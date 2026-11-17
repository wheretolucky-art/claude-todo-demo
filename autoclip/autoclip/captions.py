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
    try:
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
    except Exception as e:  # no internet for the first download, bad GPU setup, ...
        log.warning("captions skipped: Whisper failed (%s)", e)
        return []


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
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,5,60,60,0,1
Style: Hook,{font},{hook_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

# ASS colours are &HBBGGRR&
COLORS = {"yellow": "&H0000E5FF&", "green": "&H0066FF33&", "pink": "&H00A83CFF&", "cyan": "&H00FFE600&"}
HIGHLIGHT = COLORS["yellow"]
HOOK_BOX = "&H00B0189B&"  # deep magenta box behind the hook


def write_ass(words: list[Word], out: Path, y: int, font: str = "Arial", w: int = 1080, h: int = 1920,
              hook: str | None = None, color: str = "yellow", hook_seconds: float = 3.5) -> Path:
    """Captions: one line per phrase, the spoken word highlighted. Optional hook title at the top."""
    scale = w / 1080
    head = (HEADER.replace("{w}", str(w)).replace("{h}", str(h)).replace("{font}", font)
            .replace("{size}", str(int(92 * scale))).replace("{hook_size}", str(int(76 * scale))))
    lines = [head]
    hi = COLORS.get(color, HIGHLIGHT)
    if hook:
        lines.append(f"Dialogue: 1,{_ts(0)},{_ts(hook_seconds)},Hook,,0,0,0,,"
                     f"{{\\an8\\pos({w // 2},{int(h * 0.11)})\\3c{HOOK_BOX}\\fad(0,300)}}{_esc(hook)}")
    for group in chunk(words):
        for i, wd in enumerate(group):
            end = group[i + 1].start if i + 1 < len(group) else wd.end + 0.15
            parts = []
            for j, other in enumerate(group):
                if j == i:
                    parts.append(f"{{\\c{hi}\\fscx112\\fscy112}}{_esc(other.text)}{{\\r}}")
                else:
                    parts.append(_esc(other.text))
            lines.append(f"Dialogue: 0,{_ts(wd.start)},{_ts(end)},Cap,,0,0,0,,"
                         f"{{\\an5\\pos({w // 2},{y})}}" + " ".join(parts))
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out
