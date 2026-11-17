"""Find the moments where a signal jumps well above its recent normal.

The signal is anything that can be turned into one number per time bucket:
chat messages per 10 seconds, or how loud the stream was in those 10 seconds.
"""

from __future__ import annotations

import re
import statistics
from collections import deque
from dataclasses import dataclass, field

# Words chat spams when something happens. Each hit adds a little to a bucket's
# score, so "KEKW KEKW LULW" counts for more than three people saying "hi".
HYPE_WORDS = re.compile(
    r"\b(kekw|lul\w*|omegalul|pog\w*|w+|holy|clip\s*(it|that)|no\s*way|wtf|"
    r"lmao+|lol+|insane|bro|what|\?{2,}|!{3,})\b",
    re.IGNORECASE,
)


def hype_hits(text: str) -> int:
    return len(HYPE_WORDS.findall(text))


@dataclass
class Spike:
    start: float          # seconds from the start of the recording
    end: float
    score: float
    baseline: float
    source: str           # "chat" or "audio"
    sample: list[str] = field(default_factory=list)

    @property
    def ratio(self) -> float:
        return self.score / self.baseline if self.baseline > 0 else float("inf")


@dataclass
class DetectorSettings:
    bucket: float = 10.0          # seconds per bucket
    history: int = 30             # buckets that count as "normal" (30 x 10s = 5 min)
    warmup: int = 6               # buckets to see before anything can be a spike
    ratio: float = 2.0            # bucket must be this many times the normal level...
    z: float = 2.5                # ...and this many standard deviations above it
    min_score: float = 8.0        # and at least this big, so 1 -> 3 messages is ignored
    cooldown: float = 45.0        # seconds after a spike before the next can fire


class SpikeDetector:
    """Feed it one score per bucket, in order. It returns a Spike or None."""

    def __init__(self, settings: DetectorSettings, source: str):
        self.s = settings
        self.source = source
        self.history: deque[float] = deque(maxlen=settings.history)
        self.last_spike_end = float("-inf")

    def add(self, start: float, score: float, sample: list[str] | None = None) -> Spike | None:
        s = self.s
        spike = None
        if len(self.history) >= s.warmup:
            base = statistics.fmean(self.history)
            spread = statistics.pstdev(self.history) or 1.0
            floor = max(base, 1.0)
            if (
                score >= s.min_score
                and score >= floor * s.ratio
                and (score - base) / spread >= s.z
                and start - self.last_spike_end >= s.cooldown
            ):
                spike = Spike(start, start + s.bucket, score, base, self.source, sample or [])
                self.last_spike_end = start + s.bucket
        # A spike bucket still goes into the history, but capped, so one huge
        # moment does not hide the next one for five minutes.
        if self.history:
            cap = max(statistics.fmean(self.history) * s.ratio, s.min_score)
            self.history.append(min(score, cap))
        else:
            self.history.append(score)
        return spike


class ChatBuckets:
    """Counts chat messages into fixed buckets and scores each one."""

    def __init__(self, bucket: float):
        self.bucket = bucket
        self.index: int | None = None
        self.count = 0
        self.hits = 0
        self.sample: list[str] = []

    def _score(self) -> float:
        return self.count + 0.5 * self.hits

    def add(self, t: float, text: str) -> list[tuple[float, float, list[str]]]:
        """Add a message at time t. Returns any buckets that just closed."""
        closed = self.advance(t)
        self.count += 1
        self.hits += hype_hits(text)
        if len(self.sample) < 12:
            self.sample.append(text[:120])
        return closed

    def advance(self, t: float) -> list[tuple[float, float, list[str]]]:
        """Close every bucket that ends before time t, including empty ones."""
        i = int(t // self.bucket)
        closed = []
        if self.index is None:
            self.index = i
            return closed
        while self.index < i:
            closed.append((self.index * self.bucket, self._score(), self.sample))
            self.index += 1
            self.count, self.hits, self.sample = 0, 0, []
        return closed


def merge_windows(windows: list[tuple[float, float]], gap: float = 0.0) -> list[tuple[float, float]]:
    """Join windows that overlap or sit within `gap` seconds of each other."""
    out: list[list[float]] = []
    for a, b in sorted(windows):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]
