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

from . import bus, captions, media, studio
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
    ratio: str = "9:16"
    hook: bool = True               # show the Producer's hook at the top for the first seconds
    autoedit: bool = False          # cut long pauses and filler words between speech
    color: str = "yellow"           # caption highlight colour

    def options(self) -> dict:
        return {"layout": self.layout, "facecam": list(self.facecam) if self.facecam else None,
                "captions": self.captions, "ratio": self.ratio, "hook_on": self.hook,
                "autoedit": self.autoedit, "color": self.color, "font": self.font, "voiceover": False}


def hms(seconds: float) -> str:
    return str(timedelta(seconds=int(max(seconds, 0))))


def make_clip(cut: Callable[[float, float, Path], Path], a: float, b: float,
              spikes: list[Spike], out_root: Path, cs: ClipSettings,
              wall_start: float | None = None, channel: str = "stream") -> Path:
    """Editor cuts [a, b], Captioner transcribes, Producer scores, Editor renders the short."""
    best = max(spikes, key=lambda s: s.ratio)
    folder = out_root / f"{hms(a).replace(':', '-')}_x{min(best.ratio, 99):.1f}_{best.source}"
    folder.mkdir(parents=True, exist_ok=True)
    cid = folder.name
    with studio.EDIT_LOCK, bus.working("Editor", f"cutting {channel} {hms(a)}-{hms(b)}", cid):
        raw = cut(a, b, folder / "raw.mp4")
    words = []
    if cs.captions:
        with bus.working("Captioner", f"transcribing {channel} {hms(a)}", cid):
            words = captions.transcribe(raw, cs.whisper_model, cs.language)
        if not words:
            bus.say("Captioner", "no speech found (or Whisper is not installed)", cid)
    studio.save_words(folder, words)
    (folder / "transcript.txt").write_text(" ".join(w.text for w in words) + "\n", encoding="utf-8")
    recorded_at = datetime.fromtimestamp(wall_start + a).isoformat(timespec="seconds") if wall_start else None
    meta = {
        "from": hms(a), "to": hms(b), "start_seconds": round(a, 2), "end_seconds": round(b, 2),
        "recorded_at": recorded_at,
        "spikes": [{**asdict(s), "ratio": round(s.ratio, 2)} for s in spikes],
    }
    (folder / "moment.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    state = studio.new_state(folder, channel, a, b, spikes, cs.options(), recorded_at)
    studio.save(folder, state)
    studio.run_producer(folder, state)
    studio.save(folder, state)
    studio.render(folder)
    short = folder / "short.mp4"
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
        self.stop_event = threading.Event()
        self.state = "starting"       # waiting / recording / stopped / error
        self.spikes = 0
        self.recording_since: float | None = None
        self.error: str | None = None

    def stop(self) -> None:
        self.stop_event.set()

    def status(self) -> dict:
        return {"channel": self.name, "url": self.url, "state": self.state, "spikes": self.spikes,
                "clips": self.made, "signals": sorted(self.signals), "error": self.error,
                "recording_since": self.recording_since, "pending": len(self._pending)}

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
        self.spikes += 1
        bus.say("Scout", f"{self.name}: {spike.source} spike at {hms(spike.start)} "
                         f"({spike.ratio:.1f}x normal)" + (f' - "{spike.sample[0]}"' if spike.sample else ""))
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
                make_clip(self.rec.cut, a, b, spikes, self.session_dir, self.cs, self.rec.started_at, self.name)
            except Exception as e:  # one bad clip must not stop the recording
                log.error("could not make clip %s-%s: %s", hms(a), hms(b), e)
            finally:
                self.rec.unpin(a, b)

    # -- main loop

    def run(self, wait: bool = True, forever: bool = False) -> None:
        try:
            while not self.stop_event.is_set():
                if wait and not self._wait_until_live():
                    break
                self._run_once()
                if not forever or (self.max_clips and self.made >= self.max_clips):
                    break
                bus.say("Scout", f"{self.name}: stream ended; waiting for the next one")
        except Exception as e:
            self.state, self.error = "error", str(e)[-300:]
            bus.say("Scout", f"{self.name}: {e}", level="error")
            raise
        if self.state != "error":
            self.state = "stopped"

    def _wait_until_live(self) -> bool:
        """Block until the channel is live. False if stopped while waiting."""
        self.state = "waiting"
        announced = False
        while not media.is_live(self.url):
            if not announced:
                bus.say("Scout", f"{self.name} is offline; checking every 30 seconds")
                log.info("%s is offline; checking every 30 seconds", self.url)
                announced = True
            if self.stop_event.wait(30):
                return False
        return True

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
        self.state, self.recording_since = "recording", self.rec.started_at
        bus.say("Scout", f"{self.name} is live: recording and watching "
                         + " + ".join("chat" if s == "chat" else "loudness" for s in sorted(self.signals)))
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
            while self.rec.running() and not self.stop_event.is_set():
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


def download(source: str, folder: Path) -> tuple[Path, str]:
    """Fetch a VOD link. yt-dlp handles YouTube, Twitch and Kick videos; streamlink is the fallback."""
    import shutil
    folder.mkdir(parents=True, exist_ok=True)
    name = source.rstrip("/").rsplit("/", 1)[-1].split("?")[0][:60] or "video"
    if shutil.which("yt-dlp"):
        res = media.run(["yt-dlp", "--no-playlist", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
                         "--merge-output-format", "mp4", "-o", str(folder / "%(uploader)s - %(id)s.%(ext)s"),
                         "--print", "after_move:filepath", source])
        path = Path(res.stdout.strip().splitlines()[-1])
        uploader = path.stem.split(" - ")[0]
        return path, uploader or name
    media.need("streamlink")
    video = folder / f"{name}.ts"
    if not video.exists():
        media.run(["streamlink", "--force", "-o", str(video), source, "best"])
    return video, name


def clip_vod(source: str, out_dir: Path, cs: ClipSettings, ds: DetectorSettings,
             chat_path: Path | None = None, max_clips: int = 15, dry_run: bool = False,
             channel: str | None = None, progress: Callable[[str, float], None] | None = None) -> list[Path]:
    report = progress or (lambda text, frac: None)
    video = Path(source)
    name = video.stem
    if not video.exists():  # a link: download it first
        report("downloading", 0.02)
        with bus.working("Scout", f"downloading {source}"):
            video, name = download(source, out_dir / "downloads")
    name = channel or name
    report("finding moments", 0.15)
    with bus.working("Scout", f"scanning {name} for moments using " + ("chat" if chat_path else "loudness")):
        spikes = find_moments_vod(video, ds, chat_path)
    spikes.sort(key=lambda s: s.ratio, reverse=True)
    spikes = sorted(spikes[:max_clips], key=lambda s: s.start)
    length = media.duration(video)
    log.info("found %d moments in %s", len(spikes), hms(length))
    bus.say("Scout", f"found {len(spikes)} moments in {hms(length)} of {name}")
    for s in spikes:
        log.info("  %s  %s %.1fx  %s", hms(s.start), s.source, s.ratio, " | ".join(s.sample[:3]))
    if dry_run:
        return []

    session = out_dir / name
    windows = merge_windows([(max(s.start - cs.pre, 0), min(s.start + cs.post, length)) for s in spikes])
    made = []
    for i, (a, b) in enumerate(windows):
        report(f"making clip {i + 1} of {len(windows)}", 0.2 + 0.8 * i / max(len(windows), 1))
        inside = [s for s in spikes if a <= s.start <= b] or spikes[:1]
        try:
            made.append(make_clip(lambda x, y, out: media.cut_file(video, x, y - x, out),
                                  a, b, inside, session, cs, channel=name))
        except Exception as e:
            log.error("could not make clip %s-%s: %s", hms(a), hms(b), e)
            bus.say("Editor", f"could not make clip {hms(a)}-{hms(b)}: {e}", level="error")
    report("done", 1.0)
    return made
