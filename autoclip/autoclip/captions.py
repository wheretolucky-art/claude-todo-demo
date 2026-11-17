"""Word-level captions with Whisper, written as an .ass file ffmpeg can burn in."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_models: dict[str, object] = {}


@dataclass
class Word:
    start: float
    end: float
    text: str


def transcribe(path: Path, model_name: str = "small", language: str | None = None) -> list[Word]:
    """Return every spoken word with its timing. Empty list if Whisper is not installed."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("faster-whisper is not installed, so clips get no captions "
                    "(pip install faster-whisper)")
        return []
    if model_name not in _models:
        log.info("loading Whisper model '%s' (first time downloads it)", model_name)
        _models[model_name] = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, _ = _models[model_name].transcribe(
        str(path), language=language, word_timestamps=True, vad_filter=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append(Word(w.start, w.end, text))
    return words


def chunk(words: list[Word], max_words: int = 3, max_gap: float = 0.6) -> list[list[Word]]:
    """Group words into short on-screen phrases, breaking on pauses and sentence ends."""
    groups: list[list[Word]] = []
    for w in words:
        if (groups and len(groups[-1]) < max_words
                and w.start - groups[-1][-1].end <= max_gap
                and not groups[-1][-1].text.endswith((".", "!", "?"))):
            groups[-1].append(w)
        else:
            groups.append([w])
    return groups


def _ts(t: float) -> str:
    t = max(t, 0)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").upper()


HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

HIGHLIGHT = "&H0000E5FF&"  # ASS is BGR: this is a warm yellow


def write_ass(words: list[Word], out: Path, y: int, font: str = "Arial") -> Path:
    """One caption line per phrase; the word being spoken is highlighted and pops."""
    lines = [HEADER.replace("{font}", font)]
    for group in chunk(words):
        for i, w in enumerate(group):
            end = group[i + 1].start if i + 1 < len(group) else w.end + 0.15
            parts = []
            for j, other in enumerate(group):
                if j == i:
                    parts.append(f"{{\\c{HIGHLIGHT}\\fscx112\\fscy112}}{_esc(other.text)}{{\\r}}")
                else:
                    parts.append(_esc(other.text))
            lines.append(f"Dialogue: 0,{_ts(w.start)},{_ts(end)},Cap,,0,0,0,,"
                         f"{{\\an5\\pos(540,{y})}}" + " ".join(parts))
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out
