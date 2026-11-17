"""The Producer: scores a clip and writes its hook, title, post caption and hashtags.

With a Claude API key it asks Claude. Without one it uses simple rules, so the
whole tool still works for free.
"""

from __future__ import annotations

import logging
import math
import os
import re
from collections import Counter

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"


class Pitch(BaseModel):
    score: int = Field(description="0-100: how likely this clip is to do well as a short")
    hook: str = Field(description="2-6 word on-screen hook shown for the first seconds, no emoji, no hashtags")
    title: str = Field(description="Short video title, under 70 characters, no hashtags")
    caption: str = Field(description="One or two sentence post caption in the clipper's own voice")
    hashtags: list[str] = Field(description="3-6 relevant hashtags without the # sign")
    reason: str = Field(description="One sentence on why the clip scored as it did")


SYSTEM = """You help a clipper turn live-stream moments into short vertical videos for \
YouTube Shorts, TikTok and Instagram Reels. For each moment you get what the streamer said \
(automatic transcript, may contain errors), a sample of chat messages from the moment, and how \
far chat or audio rose above normal.

Judge it the way an experienced short-form editor would: is there a clear payoff, a reaction, \
a funny or surprising line, something a stranger scrolling past would stop for? A huge chat \
spike with nothing understandable on screen is worth less than a smaller spike with a great line.

Write the hook as a curiosity gap that does not give away the ending. Keep titles honest: \
never claim something the transcript and chat do not support. Write as the clipper, not as \
the streamer, and do not invent names or facts."""


def _client():
    import anthropic
    key = os.environ.get("AUTOCLIP_ANTHROPIC_KEY") or None
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


def claude_available() -> bool:
    if os.environ.get("AUTOCLIP_ANTHROPIC_KEY") or os.environ.get("ANTHROPIC_API_KEY"):
        try:
            import anthropic  # noqa: F401
            return True
        except ImportError:
            return False
    return False


def base_score(ratio: float) -> int:
    """How far above normal the spike was, mapped to 0-100. 2x -> 58, 4x -> 76, 8x -> 94."""
    if ratio <= 1:
        return 30
    return int(max(5, min(99, 40 + 18 * math.log2(ratio))))


def heuristic(channel: str, transcript: str, chat: list[str], ratio: float) -> Pitch:
    score = base_score(ratio)
    if len(transcript.split()) >= 8:
        score = min(99, score + 4)
    hook = ""
    if chat:
        common = Counter(re.sub(r"\s+", " ", m.strip().upper()) for m in chat if 0 < len(m) <= 40)
        top, n = common.most_common(1)[0] if common else ("", 0)
        if n >= 2 and not top.startswith(("HTTP", "@")):
            hook = f'CHAT: "{top}"'
    if not hook and transcript:
        words = transcript.split()
        hook = " ".join(words[:5]).rstrip(".,!?") + ("..." if len(words) > 5 else "")
    hook = hook or "WAIT FOR IT..."
    tag = re.sub(r"\W", "", channel.lower()) or "stream"
    title = f"{channel} moment chat couldn't handle" if chat else f"{channel} best moment"
    return Pitch(score=score, hook=hook[:48], title=title[:70],
                 caption=f"Chat went off for this one. Clip from {channel}'s stream.",
                 hashtags=[tag, "shorts", "streamclips", "gaming"],
                 reason=f"Rule-based: activity was {ratio:.1f}x the normal level.")


def pitch(channel: str, transcript: str, chat: list[str], ratio: float, source: str) -> tuple[Pitch, str]:
    """Return (pitch, who wrote it: 'claude' or 'rules')."""
    fallback = heuristic(channel, transcript, chat, ratio)
    if not claude_available():
        return fallback, "rules"
    import anthropic
    sample = "\n".join(f"- {m}" for m in chat[:40]) or "(no chat available)"
    prompt = (f"Channel: {channel}\nSignal: {source}, {ratio:.1f}x the normal level\n\n"
              f"Transcript:\n{transcript or '(nothing intelligible was said)'}\n\n"
              f"Chat during the moment:\n{sample}")
    try:
        response = _client().beta.messages.parse(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_format=Pitch,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError:
        log.warning("Claude API key was rejected; using rules")
        return fallback, "rules"
    except anthropic.RateLimitError:
        log.warning("Claude rate limit hit; using rules for this clip")
        return fallback, "rules"
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log.warning("Claude call failed (%s); using rules", e)
        return fallback, "rules"
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return fallback, "rules"
    p = response.parsed_output
    p.score = max(0, min(100, p.score))
    p.hashtags = [h.lstrip("#").replace(" ", "") for h in p.hashtags if h.strip()][:6]
    return p, "claude"
