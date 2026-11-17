"""Read a Twitch channel's chat anonymously.

Twitch lets anyone read public chat over IRC with a "justinfan" nickname, so no
account, token or app registration is needed. This only reads; it never posts.
"""

from __future__ import annotations

import json
import logging
import random
import socket
import ssl
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

HOST = "irc.chat.twitch.tv"
PORT = 6697  # TLS

OnMessage = Callable[[float, str, str], None]  # (unix time, user, text)


def channel_from_url(url_or_name: str) -> str:
    """'https://www.twitch.tv/SomeOne?x=1' -> 'someone'."""
    s = url_or_name.strip().rstrip("/")
    if "twitch.tv/" in s:
        s = s.split("twitch.tv/", 1)[1]
    return s.split("/")[0].split("?")[0].lower()


def parse_privmsg(line: str) -> tuple[str, str] | None:
    """Return (user, text) for a chat line, or None for anything else."""
    if line.startswith("@"):  # tags, only present if requested
        line = line.split(" ", 1)[1] if " " in line else ""
    if " PRIVMSG #" not in line or not line.startswith(":"):
        return None
    prefix, rest = line[1:].split(" PRIVMSG #", 1)
    user = prefix.split("!", 1)[0]
    text = rest.split(" :", 1)[1] if " :" in rest else ""
    return user, text


class TwitchChat(threading.Thread):
    def __init__(self, channel: str, on_message: OnMessage, log_path: Path | None = None,
                 host: str = HOST, port: int = PORT, use_tls: bool = True):
        super().__init__(daemon=True, name=f"chat-{channel}")
        self.channel = channel_from_url(channel)
        self.on_message = on_message
        self.log_path = log_path
        self.host, self.port, self.use_tls = host, port, use_tls
        self._stop = threading.Event()
        self.connected = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        backoff = 1.0
        logf = open(self.log_path, "a", encoding="utf-8") if self.log_path else None
        try:
            while not self._stop.is_set():
                try:
                    self._session(logf)
                    backoff = 1.0
                except (OSError, ssl.SSLError) as e:
                    log.warning("chat connection dropped (%s); retrying in %.0fs", e, backoff)
                self.connected.clear()
                if self._stop.wait(backoff):
                    break
                backoff = min(backoff * 2, 60)
        finally:
            if logf:
                logf.close()

    def _session(self, logf) -> None:
        raw = socket.create_connection((self.host, self.port), timeout=30)
        sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host) if self.use_tls else raw
        with sock:
            nick = f"justinfan{random.randint(10000, 99999)}"
            sock.sendall(f"PASS SCHMOOPIIE\r\nNICK {nick}\r\nJOIN #{self.channel}\r\n".encode())
            log.info("reading chat for #%s as %s", self.channel, nick)
            self.connected.set()
            buf = b""
            sock.settimeout(1.0)
            last_data = time.time()
            while not self._stop.is_set():
                try:
                    data = sock.recv(65536)
                except socket.timeout:
                    if time.time() - last_data > 360:  # Twitch pings every ~5 minutes
                        raise OSError("no data for 6 minutes")
                    continue
                if not data:
                    raise OSError("server closed the connection")
                last_data = time.time()
                buf += data
                *lines, buf = buf.split(b"\r\n")
                for raw_line in lines:
                    line = raw_line.decode("utf-8", "replace")
                    if line.startswith("PING"):
                        sock.sendall(line.replace("PING", "PONG", 1).encode() + b"\r\n")
                        continue
                    if " RECONNECT" in line:
                        raise OSError("server asked us to reconnect")
                    msg = parse_privmsg(line)
                    if msg:
                        now = time.time()
                        if logf:
                            logf.write(json.dumps({"t": now, "user": msg[0], "text": msg[1]}) + "\n")
                            logf.flush()
                        self.on_message(now, *msg)


def load_chat_log(path: Path, start_time: float | None = None) -> list[tuple[float, str]]:
    """Load chat for VOD mode. Returns [(seconds into the video, text)].

    Accepts:
      * the chat.jsonl this tool writes while recording ({"t": unix, "text": ...});
        pass start_time (the recording's start, from recording.json) to line it up
      * JSON lines with {"offset": seconds, "text": ...}
      * plain text lines "SECONDS<TAB>text" or "H:MM:SS text"
    """
    out: list[tuple[float, str]] = []
    first_unix = None
    body = Path(path).read_text(encoding="utf-8")
    try:
        whole = json.loads(body)
    except json.JSONDecodeError:
        whole = None
    if isinstance(whole, dict) and "comments" in whole:  # TwitchDownloader chat export
        for c in whole["comments"]:
            out.append((float(c["content_offset_seconds"]), (c.get("message") or {}).get("body", "")))
        return sorted(out, key=lambda x: x[0])
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("{"):
            d = json.loads(line)
            text = d.get("text") or d.get("message") or ""
            if "offset" in d:
                out.append((float(d["offset"]), text))
            else:
                t = float(d["t"])
                if first_unix is None:
                    first_unix = t
                out.append((t - (start_time if start_time is not None else first_unix), text))
            continue
        stamp, _, text = line.replace("\t", " ", 1).partition(" ")
        if ":" in stamp:
            secs = 0.0
            for part in stamp.strip("[]").split(":"):
                secs = secs * 60 + float(part)
        else:
            secs = float(stamp)
        out.append((secs, text))
    out.sort(key=lambda x: x[0])
    return out
