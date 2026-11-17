"""autoclip: record a stream, find the moments chat loses it, cut them into captioned shorts.

  python -m autoclip live  <twitch channel or stream URL>
  python -m autoclip vod   <video file or VOD URL> [--chat chat.json]
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from .media import LAYOUTS, need
from .pipeline import ClipSettings, LiveClipper, clip_vod
from .spikes import DetectorSettings


def facecam_arg(s: str) -> tuple[float, float, float, float]:
    parts = [float(p) for p in s.split(",")]
    if len(parts) != 4 or not all(0 <= p <= 1 for p in parts):
        raise argparse.ArgumentTypeError("use four fractions of the frame: x,y,width,height e.g. 0.75,0.7,0.25,0.3")
    return tuple(parts)  # type: ignore[return-value]


def common(p: argparse.ArgumentParser) -> None:
    p.add_argument("-o", "--out", type=Path, default=Path("clips"), help="where clips go (default: ./clips)")
    g = p.add_argument_group("clips")
    g.add_argument("--pre", type=float, default=20, help="seconds before the spike to keep (default 20)")
    g.add_argument("--post", type=float, default=10, help="seconds after the spike to keep (default 10)")
    g.add_argument("--layout", choices=LAYOUTS, default="blur",
                   help="blur: whole frame on a blurred fill. crop: centre 9:16. facecam: cam on top, game below")
    g.add_argument("--facecam", type=facecam_arg, help="where the webcam is, for --layout facecam: x,y,w,h as fractions")
    g.add_argument("--no-captions", action="store_true", help="skip Whisper captions")
    g.add_argument("--whisper-model", default="small", help="tiny, base, small, medium, large-v3 (default small)")
    g.add_argument("--language", help="spoken language code, e.g. en (default: detect)")
    g.add_argument("--font", default="Arial", help="caption font (default Arial)")
    d = p.add_argument_group("spike detection")
    d.add_argument("--bucket", type=float, default=10, help="seconds per counting window (default 10)")
    d.add_argument("--ratio", type=float, default=2.0, help="how many times normal counts as a spike (default 2.0)")
    d.add_argument("--z", type=float, default=2.5, help="standard deviations above normal (default 2.5)")
    d.add_argument("--min-score", type=float, default=8, help="ignore buckets smaller than this (default 8)")
    d.add_argument("--cooldown", type=float, default=45, help="seconds between spikes (default 45)")
    p.add_argument("-v", "--verbose", action="store_true")


def settings(a) -> tuple[ClipSettings, DetectorSettings]:
    if a.layout == "facecam" and not a.facecam:
        raise SystemExit("--layout facecam needs --facecam x,y,w,h (e.g. 0.75,0.7,0.25,0.3 for bottom-right)")
    cs = ClipSettings(a.pre, a.post, a.layout, a.facecam, not a.no_captions, a.whisper_model, a.language, a.font)
    ds = DetectorSettings(bucket=a.bucket, ratio=a.ratio, z=a.z, min_score=a.min_score, cooldown=a.cooldown)
    return cs, ds


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="autoclip", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    live = sub.add_parser("live", help="clip a stream while it is live")
    live.add_argument("channel", help="Twitch name (e.g. kaicenat) or any stream URL streamlink supports")
    live.add_argument("--signal", choices=["chat", "audio", "both"], default="both",
                      help="what counts as a spike (default both; chat is Twitch only)")
    live.add_argument("--quality", default="best", help="streamlink quality, e.g. best, 1080p60, 720p (default best)")
    live.add_argument("--keep-minutes", type=float, default=30,
                      help="minutes of raw recording to keep on disk; 0 keeps everything (default 30)")
    live.add_argument("--chat-delay", type=float, default=0,
                      help="seconds chat runs behind the video you receive (default 0)")
    live.add_argument("--max-clips", type=int, help="stop after this many clips")
    live.add_argument("--no-wait", action="store_true", help="fail instead of waiting if offline")
    live.add_argument("--forever", action="store_true", help="after the stream ends, wait for the next one")
    common(live)

    vod = sub.add_parser("vod", help="clip a past broadcast or any video file")
    vod.add_argument("source", help="video file, or a VOD URL to download with streamlink")
    vod.add_argument("--chat", type=Path,
                     help="chat log: TwitchDownloader JSON, this tool's chat.jsonl, or 'SECONDS text' lines. "
                          "Without it, loudness is used")
    vod.add_argument("--max-clips", type=int, default=15, help="keep the best N moments (default 15)")
    vod.add_argument("--dry-run", action="store_true", help="only list the moments, make no clips")
    common(vod)

    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    need("ffmpeg"); need("ffprobe")
    cs, ds = settings(a)

    if a.cmd == "live":
        signals = {"chat", "audio"} if a.signal == "both" else {a.signal}
        LiveClipper(a.channel, a.out, cs, ds, signals, a.quality, a.keep_minutes,
                    a.chat_delay, a.max_clips).run(wait=not a.no_wait, forever=a.forever)
    else:
        made = clip_vod(a.source, a.out, cs, ds, a.chat, a.max_clips, a.dry_run)
        if not a.dry_run:
            print(f"\n{len(made)} clips made:")
            for m in made:
                print(f"  {m}")


if __name__ == "__main__":
    main()
