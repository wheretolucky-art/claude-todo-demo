"""Everything that touches video: recording, measuring loudness, cutting, rendering."""

from __future__ import annotations

import csv
import json
import logging
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

W, H = 1080, 1920  # vertical output size


def need(tool: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise SystemExit(f"'{tool}' is not installed or not on PATH. See the README's install step.")
    return path


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    log.debug("run: %s", " ".join(map(str, cmd)))
    res = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if res.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({res.returncode}):\n{res.stderr[-2000:]}")
    return res


def duration(path: Path) -> float:
    res = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(res.stdout.strip() or 0)


# ---------------------------------------------------------------- recording

def is_live(url: str) -> bool:
    res = subprocess.run(["streamlink", "--json", url], capture_output=True, text=True)
    try:
        return bool(json.loads(res.stdout or "{}").get("streams"))
    except json.JSONDecodeError:
        return False


@dataclass
class Segment:
    path: Path
    start: float  # seconds from the start of the recording
    end: float


class Recorder:
    """streamlink -> ffmpeg, written as ~10 second .ts pieces with a running index.

    Pieces make it cheap to cut any window without re-reading hours of video,
    and let old pieces be deleted so a long stream does not fill the disk.
    """

    def __init__(self, url: str, out_dir: Path, quality: str = "best",
                 segment_seconds: int = 10, keep_minutes: float = 30):
        self.url, self.quality = url, quality
        self.dir = out_dir / "segments"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.segment_seconds = segment_seconds
        self.keep_seconds = keep_minutes * 60 if keep_minutes > 0 else None
        self.started_at: float | None = None  # unix time of the first byte of video
        self._offset: float | None = None
        self._procs: list[subprocess.Popen] = []
        self._lock = threading.Lock()
        self._pinned: list[tuple[float, float]] = []  # windows still waiting to be cut

    @property
    def index_csv(self) -> Path:
        return self.dir / "segments.csv"

    def start(self) -> None:
        need("streamlink"); need("ffmpeg")
        sl = subprocess.Popen(
            ["streamlink", "--stdout", "--twitch-disable-ads", "--retry-open", "3", self.url, self.quality],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        ff = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
             "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
             "-f", "segment", "-segment_time", str(self.segment_seconds),
             "-segment_format", "mpegts",
             "-segment_list", str(self.index_csv), "-segment_list_type", "csv",
             str(self.dir / "seg_%06d.ts")],
            stdin=sl.stdout, stderr=open(self.dir.parent / "ffmpeg.log", "ab"))
        sl.stdout.close()  # ffmpeg owns the pipe now
        self._procs = [sl, ff]
        first = self.dir / "seg_000000.ts"
        while not first.exists():
            if ff.poll() is not None:
                log_text = (self.dir.parent / "ffmpeg.log").read_text(errors="replace")[-500:]
                raise RuntimeError(f"recording stopped before any video arrived (is the stream live?) {log_text}")
            time.sleep(0.2)
        self.started_at = time.time()
        log.info("recording %s", self.url)

    def running(self) -> bool:
        return bool(self._procs) and all(p.poll() is None for p in self._procs)

    def stop(self) -> None:
        for p in reversed(self._procs):
            if p.poll() is None:
                p.terminate()
        for p in self._procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()

    def segments(self) -> list[Segment]:
        """Finished pieces, oldest first. ffmpeg adds a row when a piece closes."""
        if not self.index_csv.exists():
            return []
        rows = []
        with open(self.index_csv, newline="") as f:
            for row in csv.reader(f):
                if len(row) >= 3:
                    rows.append((row[0], float(row[1]), float(row[2])))
        if not rows:
            return []
        if self._offset is None:
            self._offset = rows[0][1]
        return [Segment(self.dir / name, a - self._offset, b - self._offset)
                for name, a, b in rows if (self.dir / name).exists()]

    def recorded_until(self) -> float:
        segs = self.segments()
        return segs[-1].end if segs else 0.0

    def pin(self, a: float, b: float) -> None:
        with self._lock:
            self._pinned.append((a, b))

    def unpin(self, a: float, b: float) -> None:
        with self._lock:
            if (a, b) in self._pinned:
                self._pinned.remove((a, b))

    def prune(self) -> None:
        """Delete pieces older than keep_minutes that no pending clip needs."""
        if self.keep_seconds is None:
            return
        segs = self.segments()
        if not segs:
            return
        cutoff = segs[-1].end - self.keep_seconds
        with self._lock:
            pinned = list(self._pinned)
        for s in segs:
            if s.end < cutoff and not any(s.end > a and s.start < b for a, b in pinned):
                s.path.unlink(missing_ok=True)

    def cut(self, a: float, b: float, out: Path) -> Path:
        segs = [s for s in self.segments() if s.end > a and s.start < b]
        if not segs:
            raise RuntimeError(f"no recorded video between {a:.0f}s and {b:.0f}s")
        joined = "concat:" + "|".join(str(s.path) for s in segs)
        return cut_file(joined, a - segs[0].start, b - a, out)


# ---------------------------------------------------------------- loudness

def loudness_buckets(source: str | Path, bucket: float, start: float = 0.0,
                     length: float | None = None, rate: int = 8000) -> list[float]:
    """Loudness (RMS dBFS) of each `bucket`-second slice of the audio, measured by ffmpeg."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(source)]
    if length:
        cmd += ["-t", f"{length:.3f}"]
    n = int(bucket * rate)
    cmd += ["-vn", "-af",
            f"aresample={rate},pan=mono|c0=c0,asetnsamples=n={n}:p=0,astats=metadata=1:reset=1,"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
            "-f", "null", "-"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    out = []
    for line in res.stdout.splitlines():
        if "RMS_level=" in line:
            v = line.split("=", 1)[1].strip()
            out.append(-90.0 if "inf" in v else max(float(v), -90.0))
    return out


def loudness_score(db: float) -> float:
    """Map dBFS to a positive score where louder grows fast: -50 dB -> ~1, -10 dB -> ~100."""
    return 10 ** ((db + 50) / 20)


# ---------------------------------------------------------------- cutting & rendering

def cut_file(source: str | Path, start: float, length: float, out: Path) -> Path:
    """Frame-accurate cut, re-encoded so the clip starts cleanly.

    Seeking straight to `start` in a .ts file can land on the keyframe *after* it.
    So jump to 15 s early (fast, rough) and decode the rest of the way (exact).
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    start = max(start, 0)
    rough = max(start - 15, 0)
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", f"{rough:.3f}", "-i", str(source), "-ss", f"{start - rough:.3f}", "-t", f"{length:.3f}",
         "-map", "0:v:0", "-map", "0:a:0?",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    return out


LAYOUTS = ("blur", "crop", "facecam")


def caption_y(layout: str) -> int:
    """Where captions sit in the 1080x1920 frame for each layout."""
    return {"blur": 1450, "crop": 1380, "facecam": 770}[layout]


def vertical_filter(layout: str, facecam: tuple[float, float, float, float] | None) -> str:
    if layout == "crop":
        return f"[0:v]crop='min(iw,ih*9/16)':ih,scale={W}:{H},setsar=1[v]"
    if layout == "facecam":
        if not facecam:
            raise ValueError("the facecam layout needs --facecam x,y,w,h")
        x, y, w, h = facecam
        top = int(H * 0.4)
        return (
            f"[0:v]split[a][b];"
            f"[a]crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},"
            f"scale={W}:{top}:force_original_aspect_ratio=increase,crop={W}:{top}[cam];"
            f"[b]scale=-2:{H - top},crop={W}:{H - top}[game];"
            f"[cam][game]vstack,setsar=1[v]")
    return (
        f"[0:v]split[a][b];"
        f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:3,eq=brightness=-0.08[bg];"
        f"[b]scale={W}:-2[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]")


def render_vertical(raw: Path, out: Path, layout: str = "blur", subtitles: Path | None = None,
                    facecam: tuple[float, float, float, float] | None = None) -> Path:
    graph = vertical_filter(layout, facecam)
    if subtitles:
        # Run from the clip's folder so the subtitle path needs no escaping.
        graph = graph[:-3] + f"[pre];[pre]ass={subtitles.name}[v]"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", raw.name,
         "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?",
         "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out.name], cwd=raw.parent)
    return out
