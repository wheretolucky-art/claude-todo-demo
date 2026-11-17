"""What each agent is doing right now, and a running log of what they did.

The dashboard reads this. Agents write to it with `say()` and `working()`.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from contextlib import contextmanager

AGENTS = {
    "Scout": "Watches live streams and chat, and spots the moments",
    "Editor": "Cuts each moment and reframes it for Shorts, Reels and TikTok",
    "Captioner": "Writes word-by-word captions with Whisper",
    "Producer": "Scores each clip and writes its hook, title and post caption",
    "Publisher": "Keeps the posting queue and the proof log. Nothing posts without your yes",
}

_lock = threading.Lock()
_log: deque[dict] = deque(maxlen=400)
_status = {name: {"busy": 0, "task": "", "done": 0} for name in AGENTS}
_seq = 0


def say(agent: str, text: str, clip: str | None = None, level: str = "info") -> None:
    global _seq
    with _lock:
        _seq += 1
        _log.append({"id": _seq, "t": time.time(), "agent": agent, "text": text, "clip": clip, "level": level})


@contextmanager
def working(agent: str, task: str, clip: str | None = None):
    with _lock:
        st = _status[agent]
        st["busy"] += 1
        st["task"] = task
    say(agent, task, clip)
    try:
        yield
    except Exception as e:
        say(agent, f"failed: {e}", clip, "error")
        raise
    finally:
        with _lock:
            st["busy"] -= 1
            st["done"] += 1
            if not st["busy"]:
                st["task"] = ""


def snapshot(after: int = 0) -> dict:
    with _lock:
        return {
            "agents": [{"name": n, "role": AGENTS[n], **_status[n]} for n in AGENTS],
            "log": [e for e in _log if e["id"] > after],
        }
