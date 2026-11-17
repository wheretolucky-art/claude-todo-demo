"""Turn detected moments into finished vertical shorts, live or from a VOD."""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from . import captions, media
from .chat import TwitchChat, channel_from_url, load_chat_log
from .spikes import ChatBuckets, DetectorSettings, Spike, SpikeDetector, merge_windows

log = logging.getLogger(__name__)


@dataclass
class ClipSettings:
    pre: float = 20.0               # seconds kept before the spike
    post: float = 10.0              # seconds kept after it
    layout: str = "blur"
    facecam: tuple[float, float, float, float] | None = None
    captions: bool = True
    whisper_model: str = "small"
    language: str | None = None
    font: str = "Arial"


def hms(seconds: float) -> str:
    return str(timedelta(seconds=int(max(seconds, 0))))


def make_clip(cut: Callable[[float, float, Path], Path], a: float, b: float,
              spikes: list[Spike], out_root: Path, cs: ClipSettings,
              wall_start: float | None = None) -> Path:
    """Cut [a, b], caption it, render the 9:16 short, and write what was found."""
    best = max(spikes, key=lambda s: s.ratio)
    folder = out_root / f"{hms(a).replace(':', '-')}_x{min(best.ratio, 99):.1f}_{best.source}"
    folder.mkdir(parents=True, exist_ok=True)
    raw = cut(a, b, folder / "raw.mp4")
    ass = None
    if cs.captions:
        words = captions.transcribe(raw, cs.whisper_model, cs.language)
        if words:
            ass = captions.write_ass(words, folder / "captions.ass", media.caption_y(cs.layout), cs.font)
            (folder / "transcript.txt").write_text(" ".join(w.text for w in words) + "\n", encoding="utf-8")
    short = media.render_vertical(raw, folder / "short.mp4", cs.layout, ass, cs.facecam)
    meta = {
        "from": hms(a), "to": hms(b), "start_seconds": round(a, 2), "end_seconds": round(b, 2),
        "recorded_at": datetime.fromtimestamp(wall_start + a).isoformat(timespec="seconds") if wall_start else None,
        "spikes": [{**asdict(s), "ratio": round(s.ratio, 2)} for s in spikes],
    }
    (folder / "moment.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("clip ready: %s", short)
    return short


# ---------------------------------------------------------------- live

class LiveClipper:
    """Record a live stream, watch chat and/or loudness, clip every spike as it happens."""

    def __init__(self, url: str, out_dir: Path, cs: ClipSettings, ds: DetectorSettings,
                 signals: set[str], quality: str = "best", keep_minutes: float = 30,
                 chat_delay: float = 0.0, max_clips: int | None = None):
        self.url = url if "://" in url else f"https://www.twitch.tv/{url}"
        self.is_twitch = "twitch.tv/" in self.url
        self.name = channel_from_url(self.url) if self.is_twitch else self.url.rstrip("/").rsplit("/", 1)[-1]
        self.out_dir, self.cs, self.ds = out_dir, cs, ds
        self.signals = set(signals)
        if "chat" in self.signals and not self.is_twitch:
            log.warning("chat reading only works for Twitch; using loudness instead")
            self.signals = {"audio"}
        self.quality, self.keep_minutes, self.chat_delay = quality, keep_minutes, chat_delay
        self.max_clips = max_clips
        self.made = 0
        self._lock = threading.Lock()
        self._pending: list[tuple[float, float, list[Spike]]] = []
        self._jobs: queue.Queue = queue.Queue()

    # -- signal handling

    def _on_spike(self, spike: Spike) -> None:
        a, b = max(spike.start - self.cs.pre, 0), spike.start + self.cs.post
        with self._lock:
            for i, (pa, pb, sp) in enumerate(self._pending):
                if a <= pb and b >= pa:  # chat and audio agreeing on one moment -> one clip
                    self.rec.unpin(pa, pb)
                    self._pending[i] = (min(a, pa), max(b, pb), sp + [spike])
                    self.rec.pin(*self._pending[i][:2])
                    break
            else:
                self._pending.append((a, b, [spike]))
                self.rec.pin(a, b)
        log.info("SPIKE at %s (%s, %.1fx normal, score %.0f)%s", hms(spike.start), spike.source,
                 spike.ratio, spike.score, f": {spike.sample[:3]}" if spike.sample else "")

    def _on_chat(self, unix: float, user: str, text: str) -> None:
        t = unix - self.rec.started_at - self.chat_delay
        with self._lock:
            closed = self.buckets.add(t, text)
        self._feed_chat(closed)

    def _feed_chat(self, closed) -> None:
        for start, score, sample in closed:
            spike = self.chat_det.add(start, score, sample)
            if spike:
                self._on_spike(spike)

    def _worker(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            a, b, spikes = job
            try:
                make_clip(self.rec.cut, a, b, spikes, self.session_dir, self.cs, self.rec.started_at)
            except Exception as e:  # one bad clip must not stop the recording
                log.error("could not make clip %s-%s: %s", hms(a), hms(b), e)
            finally:
                self.rec.unpin(a, b)

    # -- main loop

    def run(self, wait: bool = True, forever: bool = False) -> None:
        while True:
            if wait:
                self._wait_until_live()
            self._run_once()
            if not forever or (self.max_clips and self.made >= self.max_clips):
                return
            log.info("stream ended; waiting for the next one")

    def _wait_until_live(self) -> None:
        announced = False
        while not media.is_live(self.url):
            if not announced:
                log.info("%s is offline; checking every 30 seconds", self.url)
                announced = True
            time.sleep(30)

    def _run_once(self) -> None:
        self.session_dir = self.out_dir / self.name / datetime.now().strftime("%Y-%m-%d_%H%M")
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.rec = media.Recorder(self.url, self.session_dir, self.quality,
                                  int(self.ds.bucket), self.keep_minutes)
        self.buckets = ChatBuckets(self.ds.bucket)
        self.chat_det = SpikeDetector(self.ds, "chat")
        self.audio_det = SpikeDetector(self.ds, "audio")
        self._pending = []
        self.rec.start()
        (self.session_dir / "recording.json").write_text(json.dumps(
            {"url": self.url, "started_at": self.rec.started_at, "signals": sorted(self.signals)}, indent=2))
        chat = None
        if "chat" in self.signals:
            chat = TwitchChat(self.name, self._on_chat, self.session_dir / "chat.jsonl")
            chat.start()
        worker = threading.Thread(target=self._worker, daemon=True)
        worker.start()
        audio_done = float("-inf")  # start time of the last piece measured
        log.info("watching for spikes; clips go to %s (Ctrl-C to stop)", self.session_dir)
        try:
            while self.rec.running():
                time.sleep(1)
                now = time.time() - self.rec.started_at - self.chat_delay
                if chat:
                    with self._lock:
                        closed = self.buckets.advance(now)
                    self._feed_chat(closed)
                if "audio" in self.signals:
                    for seg in self.rec.segments():
                        if seg.start <= audio_done:
                            continue
                        audio_done = seg.start
                        levels = media.loudness_buckets(seg.path, seg.end - seg.start + 1)
                        if levels:
                            spike = self.audio_det.add(seg.start, media.loudness_score(levels[0]))
                            if spike:
                                self._on_spike(spike)
                self._dispatch(self.rec.recorded_until())
                self.rec.prune()
                if self.max_clips and self.made >= self.max_clips:
                    log.info("made %d clips, stopping", self.made)
                    break
        except KeyboardInterrupt:
            log.info("stopping; finishing clips already found")
        finally:
            if chat:
                chat.stop()
            self.rec.stop()
            self._dispatch(float("inf"))
            self._jobs.put(None)
            worker.join()

    def _dispatch(self, recorded_until: float) -> None:
        """Send every moment whose after-roll has been recorded off to be cut."""
        with self._lock:
            ready = [p for p in self._pending if p[1] + 2 <= recorded_until]
            self._pending = [p for p in self._pending if p not in ready]
        for job in ready:
            if self.max_clips and self.made >= self.max_clips:
                self.rec.unpin(job[0], job[1])
                continue
            self.made += 1
            self._jobs.put(job)


# ---------------------------------------------------------------- VOD

def find_moments_vod(video: Path, ds: DetectorSettings, chat_path: Path | None) -> list[Spike]:
    spikes: list[Spike] = []
    if chat_path:
        det = SpikeDetector(ds, "chat")
        buckets = ChatBuckets(ds.bucket)
        msgs = load_chat_log(chat_path)
        for t, text in msgs:
            for start, score, sample in buckets.add(t, text):
                if (s := det.add(start, score, sample)):
                    spikes.append(s)
        if msgs:
            for start, score, sample in buckets.advance(msgs[-1][0] + ds.bucket):
                if (s := det.add(start, score, sample)):
                    spikes.append(s)
    else:
        det = SpikeDetector(ds, "audio")
        for i, db in enumerate(media.loudness_buckets(video, ds.bucket)):
            if (s := det.add(i * ds.bucket, media.loudness_score(db))):
                spikes.append(s)
    return spikes


def clip_vod(source: str, out_dir: Path, cs: ClipSettings, ds: DetectorSettings,
             chat_path: Path | None = None, max_clips: int = 15, dry_run: bool = False) -> list[Path]:
    video = Path(source)
    name = video.stem
    if not video.exists():  # a link: download it first
        media.need("streamlink")
        name = source.rstrip("/").rsplit("/", 1)[-1]
        video = out_dir / "downloads" / f"{name}.ts"
        video.parent.mkdir(parents=True, exist_ok=True)
        if not video.exists():
            log.info("downloading %s", source)
            media.run(["streamlink", "--force", "-o", str(video), source, "best"])
    spikes = find_moments_vod(video, ds, chat_path)
    spikes.sort(key=lambda s: s.ratio, reverse=True)
    spikes = sorted(spikes[:max_clips], key=lambda s: s.start)
    length = media.duration(video)
    log.info("found %d moments in %s", len(spikes), hms(length))
    for s in spikes:
        log.info("  %s  %s %.1fx  %s", hms(s.start), s.source, s.ratio, " | ".join(s.sample[:3]))
    if dry_run:
        return []

    session = out_dir / name
    windows = merge_windows([(max(s.start - cs.pre, 0), min(s.start + cs.post, length)) for s in spikes])
    made = []
    for a, b in windows:
        inside = [s for s in spikes if a <= s.start <= b] or spikes[:1]
        try:
            made.append(make_clip(lambda x, y, out: media.cut_file(video, x, y - x, out),
                                  a, b, inside, session, cs))
        except Exception as e:
            log.error("could not make clip %s-%s: %s", hms(a), hms(b), e)
    return made
