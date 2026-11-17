# autoclip

Clips a stream automatically while it is live.

## The dashboard

```bash
python -m autoclip web
```

That opens **http://localhost:8765**, a website that runs on your own computer
and nowhere else. It has four pages:

- **Agents**: your clipping crew. Each agent shows what it is doing right now,
  next to a live activity feed.
  - **Scouts** watch live streams and chat and spot the moments. Send one to
    any channel from this page.
  - **Editor** cuts each moment and reframes it.
  - **Captioner** writes word-by-word captions with Whisper.
  - **Producer** scores each clip and writes its hook, title, post caption and
    hashtags.
  - **Publisher** keeps the posting queue and the proof log.
- **Clip Generator**: paste a YouTube, Twitch or Kick video link, or drop a
  video file, and pick the settings: Ratio, Clips, Hook, Subs, Auto Edit,
  Layout.
- **Clips**: every clip with its score. Keep it or throw it out, then open it
  for the tools:
  - **Auto Edit** cuts long pauses and "um"s between speech. The action
    before the first word and after the last is left alone.
  - **Subtitles** turns the word-by-word captions on or off and sets their
    highlight colour.
  - **Viral Hook** puts a title over the first 3.5 seconds. Edit it yourself or
    have the Producer rewrite it.
  - **Voiceover** records your voice with your mic while the clip plays. The
    stream audio ducks under you. This is what makes a clip yours and not a
    repost.
  - **Shape** (9:16, 1:1 or 16:9) and **layout** (full frame on blur, crop, or
    cam on top).
  - **Approve for posting** saves the title, caption and hashtags to
    `post.txt`. **Mark as posted** logs the link. Every step goes into the
    clip's proof log.
- **Settings**: your Claude API key (optional), the Whisper model, and
  **streamer permissions**. Save each streamer's "yes, you can clip me" here.
  The Publisher warns you before you approve a clip from a channel without one.

**Claude is optional.** With an API key (Settings, or `ANTHROPIC_API_KEY`), the
Producer uses Claude (`claude-opus-5-5`) to score clips and write hooks from the
transcript and chat. Without a key, simple rules do it and the tool costs
nothing.

**Nothing is posted automatically.** You download the short and post it
yourself. The dashboard only listens on `127.0.0.1` and ignores requests from
other websites.

## Command line It records the stream, watches
chat, and when chat suddenly explodes ("KEKW", "NO WAY", "CLIP IT") it cuts the
30 seconds around that moment into a vertical 9:16 short with burned-in,
word-by-word captions.

Everything it uses is free and runs on your own computer:

| Part | What it does |
| --- | --- |
| [streamlink](https://streamlink.github.io) | records the stream from the moment it goes live |
| Twitch chat (anonymous) | read-only, no account or token needed |
| spike detector | counts chat messages every 10 seconds and compares them with the last 5 minutes |
| loudness detector | same idea on the audio, for YouTube/Kick streams or when chat is slow |
| [ffmpeg](https://ffmpeg.org) | cuts each moment and renders the 1080×1920 short |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | writes the captions |

## Install (once)

You need **Python 3.10+** and **ffmpeg**. `yt-dlp` (in requirements) downloads
finished VODs from YouTube, Twitch and Kick.

```bash
# ffmpeg
#   Windows:  winget install Gyan.FFmpeg
#   macOS:    brew install ffmpeg
#   Linux:    sudo apt install ffmpeg

cd autoclip
python -m pip install -r requirements.txt
```

The first clip with captions downloads the Whisper model (`small` is about
500 MB). An NVIDIA GPU is used automatically if one is set up; otherwise the
CPU works, just slower.

## Clip a live stream

```bash
python -m autoclip live kaicenat
```

That's it. It waits until the channel goes live, records, and drops a finished
short into `clips/<channel>/<date>/` for every spike. Leave it running and stop
it with Ctrl-C; clips it already found still get finished.

Run several channels at once by opening one terminal per channel.

Useful options:

```bash
# webcam on top, gameplay below (the classic streamer short).
# --facecam is where the cam sits, as fractions of the frame: x,y,width,height
python -m autoclip live kaicenat --layout facecam --facecam 0.75,0.7,0.25,0.3

# any site streamlink supports; chat is Twitch only, so these use loudness
python -m autoclip live https://www.youtube.com/@someone/live
python -m autoclip live https://kick.com/someone

# keep going across streams, stop after 20 clips, 720p to save disk
python -m autoclip live kaicenat --forever --max-clips 20 --quality 720p60
```

## Clip a past stream (VOD) or any video file

```bash
python -m autoclip vod stream.mp4                       # uses loudness
python -m autoclip vod stream.mp4 --chat chat.json      # uses chat (better)
python -m autoclip vod https://www.twitch.tv/videos/123456789 --chat chat.json
python -m autoclip vod stream.mp4 --dry-run             # just list the moments
```

`--chat` accepts a [TwitchDownloader](https://github.com/lay295/TwitchDownloader)
chat export (`.json`), the `chat.jsonl` this tool saves while recording, or a
plain text file with one `SECONDS message` or `H:MM:SS message` per line. VOD
mode keeps the 15 strongest moments (`--max-clips`).

## What you get

```
clips/kaicenat/2026-11-19_1800/
  recording.json          when recording started
  chat.jsonl              every chat message, with time
  segments/               rolling raw recording (last 30 min only)
  1-42-10_x6.3_chat/      one folder per moment: time, how many times normal, signal
    short.mp4             the finished short, ready to post
    raw.mp4               the same moment, original size, no captions
    clip.json             score, hook, title, caption, status, options, proof log
    words.json            every spoken word with its timing
    captions.ass          the captions, editable
    transcript.txt        what was said
    moment.json           the spike: score, normal level, sample chat messages
    post.txt              title, caption and hashtags, once approved
    voice.wav             your voiceover, if you recorded one
```

## Layouts

| `--layout` | Looks like |
| --- | --- |
| `blur` (default) | whole stream in the middle, blurred copy filling the rest |
| `crop` | centre of the stream cropped to fill the screen |
| `facecam` | webcam on the top 40%, gameplay on the bottom 60% |

## Tuning

Defaults suit a busy channel. If you get too many clips, raise `--ratio` (for
example `3`). If you get none, lower `--ratio` or `--min-score`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--pre` / `--post` | 20 / 10 | seconds kept before / after the spike |
| `--bucket` | 10 | seconds per counting window |
| `--ratio` | 2.0 | a window must be this many times the recent normal |
| `--z` | 2.5 | ...and this many standard deviations above it |
| `--min-score` | 8 | ignore tiny windows (3 messages instead of 1 is not a moment) |
| `--cooldown` | 45 | seconds before another spike can fire |
| `--signal` | both | `chat`, `audio` or `both` (live) |
| `--keep-minutes` | 30 | raw recording kept on disk; `0` keeps the whole stream |
| `--whisper-model` | small | `tiny`/`base` are faster, `medium`/`large-v3` more accurate |
| `--no-captions` | | skip captions |
| `--aspect` | 9:16 | `9:16`, `1:1` or `16:9` |
| `--auto-edit` | off | cut long pauses and filler words between speech |
| `--no-hook` | | no hook title over the first seconds |
| `--color` | yellow | caption highlight: yellow, green, pink, cyan |

## Before you post

The footage belongs to the streamer and the game to its publisher. Ask the
streamer first or check whether they allow clipping. Plain reposts can lose
monetization under YouTube's reused-content policy, so add your own
commentary, reaction or text. A streamer or publisher can still claim a clip.

## Tests

```bash
python -m pip install pytest
python -m pytest
```
