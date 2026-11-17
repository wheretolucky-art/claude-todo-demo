"""A clip's saved state, its re-render, and the per-clip tools.

Every clip folder holds:
  raw.mp4       the moment, original framing
  words.json    every spoken word with timing (from Whisper)
  clip.json     score, hook, title, status, render options, proof log
  short.mp4     the finished video, rebuilt whenever an option changes
  voice.wav     your recorded voiceover, if any
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict
from pathlib import Path

from . import bus, captions, media, producer

EDIT_LOCK = threading.Lock()  # one ffmpeg render at a time keeps the computer usable

FILLERS = {"um", "uh", "uhh", "umm", "erm", "er", "hmm", "mm", "ah"}
STATUSES = ("new", "kept", "discarded", "approved", "posted")


# ---------------------------------------------------------------- state

def load(folder: Path) -> dict:
    return json.loads((folder / "clip.json").read_text(encoding="utf-8"))


def save(folder: Path, state: dict) -> None:
    tmp = folder / "clip.json.tmp"
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, folder / "clip.json")


def note(state: dict, text: str) -> None:
    """Append to the clip's proof log (what happened to it, and when)."""
    state.setdefault("log", []).append({"t": time.time(), "text": text})


def load_words(folder: Path) -> list[captions.Word]:
    p = folder / "words.json"
    if not p.exists():
        return []
    return [captions.Word(**w) for w in json.loads(p.read_text(encoding="utf-8"))]


def save_words(folder: Path, words: list[captions.Word]) -> None:
    (folder / "words.json").write_text(json.dumps([asdict(w) for w in words]), encoding="utf-8")


def new_state(folder: Path, channel: str, a: float, b: float, spikes: list, options: dict,
              recorded_at: str | None) -> dict:
    best = max(spikes, key=lambda s: s.ratio)
    state = {
        "channel": channel, "created": time.time(), "recorded_at": recorded_at,
        "start_seconds": round(a, 2), "end_seconds": round(b, 2),
        "source": best.source, "spike_ratio": round(min(best.ratio, 999), 2),
        "chat_sample": [m for s in spikes for m in s.sample][:40],
        "status": "new", "score": producer.base_score(best.ratio),
        "hook": "", "title": "", "caption": "", "hashtags": [], "reason": "", "written_by": "",
        "options": options, "rendering": False, "error": None, "version": 0, "duration": round(b - a, 2),
        "post": {}, "log": [],
    }
    note(state, f"found: {best.source} spike at {best.ratio:.1f}x normal")
    return state


# ---------------------------------------------------------------- producer

def run_producer(folder: Path, state: dict) -> None:
    transcript = " ".join(w.text for w in load_words(folder))
    with bus.working("Producer", f"reviewing {state['channel']} @ {_hms(state['start_seconds'])}", _cid(folder)):
        p, who = producer.pitch(state["channel"], transcript, state.get("chat_sample", []),
                                state.get("spike_ratio", 1), state.get("source", "chat"))
    state.update(score=p.score, hook=p.hook, title=p.title, caption=p.caption,
                 hashtags=p.hashtags, reason=p.reason, written_by=who)
    note(state, f"scored {p.score}/100 by {who}: {p.reason}")
    bus.say("Producer", f'{p.score}/100 "{p.hook}"', _cid(folder))


# ---------------------------------------------------------------- auto edit

def autoedit_keep(words: list[captions.Word], duration: float, max_pause: float = 1.2,
                  pad: float = 0.25) -> list[tuple[float, float]] | None:
    """Ranges to keep after cutting long pauses and filler words *between* speech.

    The action before the first word and after the last is left alone: in a
    gaming clip that silence is often the play itself.
    """
    spoken = [w for w in words if w.text.lower().strip(".,!?") not in FILLERS]
    if len(spoken) < 2:
        return None
    keep: list[list[float]] = [[0.0, spoken[0].end + pad]]
    for w in spoken[1:]:
        start = max(w.start - pad, 0)
        if start - keep[-1][1] <= max_pause - 2 * pad or start <= keep[-1][1]:
            keep[-1][1] = max(keep[-1][1], w.end + pad)
        else:
            keep.append([start, w.end + pad])
    keep[-1][1] = duration
    removed = duration - sum(b - a for a, b in keep)
    if removed < 0.5:
        return None
    return [(round(a, 3), round(min(b, duration), 3)) for a, b in keep]


def remap_words(words: list[captions.Word], keep: list[tuple[float, float]]) -> list[captions.Word]:
    out, offset = [], 0.0
    for a, b in keep:
        for w in words:
            if a <= w.start < b and w.text.lower().strip(".,!?") not in FILLERS:
                out.append(captions.Word(w.start - a + offset, min(w.end, b) - a + offset, w.text))
        offset += b - a
    return out


# ---------------------------------------------------------------- render

def render(folder: Path) -> None:
    """Rebuild short.mp4 from raw.mp4 and the clip's options."""
    state = load(folder)
    o = state["options"]
    words = load_words(folder)
    raw = folder / "raw.mp4"
    keep = autoedit_keep(words, media.duration(raw)) if o.get("autoedit") else None
    if keep:
        words = remap_words(words, keep)
    ratio = o.get("ratio", "9:16")
    w, h = media.RATIOS[ratio]
    ass = None
    hook = state.get("hook") if o.get("hook_on") else None
    if (o.get("captions") and words) or hook:
        ass = captions.write_ass(words if o.get("captions") else [], folder / "captions.ass",
                                 media.caption_y(o.get("layout", "blur"), ratio), o.get("font", "Arial"),
                                 w, h, hook, o.get("color", "yellow"))
    facecam = tuple(o["facecam"]) if o.get("facecam") else None
    layout = o.get("layout", "blur")
    if layout == "facecam" and not facecam:
        layout = "blur"
    tmp = folder / "short.tmp.mp4"
    with EDIT_LOCK, bus.working("Editor", f"rendering {ratio} {layout}"
                                + (", auto edit" if keep else "") + (", voiceover" if o.get("voiceover") else ""),
                                _cid(folder)):
        media.render_short(raw, tmp, layout, ass, facecam, ratio, keep)
        voice = folder / "voice.wav"
        if o.get("voiceover") and voice.exists():
            mixed = folder / "short.mix.mp4"
            media.mix_voiceover(tmp, voice, mixed)
            os.replace(mixed, tmp)
        os.replace(tmp, folder / "short.mp4")
    state = load(folder)  # options may have changed while rendering; keep them
    state["version"] = state.get("version", 0) + 1
    state["duration"] = round(media.duration(folder / "short.mp4"), 2)
    state["rendering"] = False
    state["error"] = None
    save(folder, state)


def render_async(folder: Path) -> None:
    state = load(folder)
    state["rendering"] = True
    save(folder, state)

    def go():
        try:
            render(folder)
        except Exception as e:
            st = load(folder)
            st.update(rendering=False, error=str(e)[-400:])
            save(folder, st)
    threading.Thread(target=go, daemon=True).start()


# ---------------------------------------------------------------- tools

RENDER_OPTIONS = {"autoedit", "captions", "color", "hook_on", "ratio", "layout", "facecam", "voiceover"}


def apply(folder: Path, action: str, payload: dict, permissions: dict | None = None) -> dict:
    """Run one dashboard action on a clip. Returns the new state."""
    state = load(folder)
    cid = _cid(folder)
    needs_render = False
    if action == "status":
        status = payload["status"]
        if status not in STATUSES:
            raise ValueError(f"unknown status {status}")
        state["status"] = status
        note(state, f"marked {status}")
    elif action == "options":
        changed = {k: v for k, v in payload.items() if k in RENDER_OPTIONS and state["options"].get(k) != v}
        if "voiceover" in changed and changed["voiceover"] and not (folder / "voice.wav").exists():
            raise ValueError("record a voiceover first")
        state["options"].update(changed)
        needs_render = bool(changed)
        if changed:
            note(state, "changed " + ", ".join(f"{k}={v}" for k, v in changed.items()))
    elif action == "text":
        for k in ("hook", "title", "caption"):
            if k in payload:
                state[k] = str(payload[k])[:300]
        if "hashtags" in payload:
            state["hashtags"] = [h.strip().lstrip("#") for h in payload["hashtags"] if h.strip()][:10]
        needs_render = "hook" in payload and state["options"].get("hook_on")
        note(state, "edited text")
    elif action == "regenerate":
        save(folder, state)
        run_producer(folder, state)
        needs_render = state["options"].get("hook_on")
    elif action == "approve":
        perm = (permissions or {}).get(state["channel"].lower(), {})
        if not perm.get("allowed") and not payload.get("override"):
            raise PermissionError(f"No permission recorded for {state['channel']}. Ask the streamer first "
                                  "(Settings > Streamer permissions), or approve anyway.")
        state["status"] = "approved"
        (folder / "post.txt").write_text(post_text(state), encoding="utf-8")
        note(state, "approved for posting" + ("" if perm.get("allowed") else " WITHOUT recorded permission"))
        bus.say("Publisher", f"queued for posting: {state['title']}", cid)
    elif action == "posted":
        state["status"] = "posted"
        state["post"] = {"url": str(payload.get("url", ""))[:500], "at": time.time()}
        note(state, f"posted {state['post']['url']}".strip())
        bus.say("Publisher", f"logged as posted: {state['post']['url'] or state['title']}", cid)
    else:
        raise ValueError(f"unknown action {action}")
    save(folder, state)
    if needs_render:
        render_async(folder)
        state["rendering"] = True
    return state


def add_voiceover(folder: Path, audio: Path) -> None:
    """Convert an uploaded recording to voice.wav and turn the voiceover on."""
    media.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio),
               "-vn", "-ac", "1", "-ar", "48000", str(folder / "voice.wav")])
    audio.unlink(missing_ok=True)
    state = load(folder)
    state["options"]["voiceover"] = True
    note(state, "recorded a voiceover")
    save(folder, state)
    render_async(folder)


def post_text(state: dict) -> str:
    tags = " ".join(f"#{h}" for h in state.get("hashtags", []))
    return f"{state.get('title', '')}\n\n{state.get('caption', '')}\n\n{tags}\n"


def _hms(s: float) -> str:
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _cid(folder: Path) -> str:
    return folder.name
