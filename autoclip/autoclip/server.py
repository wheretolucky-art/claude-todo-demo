"""The dashboard: a small web server on your own computer.

  python -m autoclip web        then open http://localhost:8765

It only listens on this computer (127.0.0.1). It refuses requests whose Host is
not localhost (DNS rebinding) and any write without the X-Autoclip header,
which other websites cannot add, so a page you visit cannot drive it.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import bus, producer, studio
from .chat import channel_from_url
from .pipeline import ClipSettings, LiveClipper, clip_vod
from .spikes import DetectorSettings

log = logging.getLogger(__name__)
WEB = Path(__file__).parent / "web"
MAX_UPLOAD = 20 * 1024 ** 3  # 20 GB


class App:
    def __init__(self, out_dir: Path):
        self.out = out_dir.resolve()
        self.home = self.out / ".autoclip"
        self.uploads = self.home / "uploads"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.home / "settings.json"
        self.settings = self._load_settings()
        self.scouts: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self._apply_key()

    # -- settings

    def _load_settings(self) -> dict:
        base = {"anthropic_key": "", "whisper_model": "small", "permissions": {}}
        if self.settings_path.exists():
            base.update(json.loads(self.settings_path.read_text(encoding="utf-8")))
        return base

    def save_settings(self) -> None:
        tmp = self.settings_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.settings, indent=2), encoding="utf-8")
        os.replace(tmp, self.settings_path)
        try:
            os.chmod(self.settings_path, 0o600)  # holds an API key
        except OSError:
            pass

    def _apply_key(self) -> None:
        key = self.settings.get("anthropic_key", "")
        if key:
            os.environ["AUTOCLIP_ANTHROPIC_KEY"] = key
        else:
            os.environ.pop("AUTOCLIP_ANTHROPIC_KEY", None)

    def public_settings(self) -> dict:
        key = self.settings.get("anthropic_key", "")
        return {"has_key": bool(key), "key_hint": f"...{key[-4:]}" if key else "",
                "env_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "claude": producer.claude_available(), "model": producer.MODEL,
                "whisper_model": self.settings.get("whisper_model", "small"),
                "permissions": self.settings.get("permissions", {}), "out_dir": str(self.out)}

    # -- clips

    def clip_folder(self, cid: str) -> Path:
        folder = (self.out / cid).resolve()
        if not folder.is_relative_to(self.out) or not (folder / "clip.json").exists():
            raise FileNotFoundError(cid)
        return folder

    def clips(self) -> list[dict]:
        out = []
        perms = self.settings.get("permissions", {})
        for f in self.out.glob("**/clip.json"):
            if ".autoclip" in f.parts:
                continue
            try:
                st = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            rel = f.parent.relative_to(self.out).as_posix()
            st["id"] = rel
            st["video"] = f"/files/{quote(rel)}/short.mp4?v={st.get('version', 0)}" \
                if (f.parent / "short.mp4").exists() else None
            st["raw"] = f"/files/{quote(rel)}/raw.mp4"
            st["has_voice"] = (f.parent / "voice.wav").exists()
            st["permission"] = perms.get(st.get("channel", "").lower(), {}).get("allowed", False)
            st["transcript"] = (f.parent / "transcript.txt").read_text(encoding="utf-8").strip() \
                if (f.parent / "transcript.txt").exists() else ""
            st["post_text"] = studio.post_text(st)
            st.pop("chat_sample", None)
            out.append(st)
        out.sort(key=lambda c: c.get("created", 0), reverse=True)
        return out

    # -- scouts (live)

    def start_scout(self, cfg: dict) -> dict:
        channel = cfg.get("channel", "").strip()
        if not channel:
            raise ValueError("enter a Twitch name or a stream link")
        cs, ds = self._settings_from(cfg)
        signal = cfg.get("signal", "both")
        signals = {"chat", "audio"} if signal == "both" else {signal}
        clipper = LiveClipper(channel, self.out, cs, ds, signals, cfg.get("quality", "best"),
                              float(cfg.get("keep_minutes", 30)), 0.0,
                              int(cfg["max_clips"]) if cfg.get("max_clips") else None)
        sid = uuid.uuid4().hex[:8]
        t = threading.Thread(target=self._run_scout, args=(clipper,), daemon=True, name=f"scout-{sid}")
        with self.lock:
            self.scouts[sid] = {"clipper": clipper, "thread": t, "started": time.time(), "config": cfg}
        t.start()
        bus.say("Scout", f"assigned to {clipper.name}")
        return {"id": sid}

    def _run_scout(self, clipper: LiveClipper) -> None:
        try:
            clipper.run(wait=True, forever=True)
        except Exception as e:  # already reported to the bus by the clipper
            log.error("scout %s stopped: %s", clipper.name, e)

    def stop_scout(self, sid: str) -> None:
        with self.lock:
            s = self.scouts.get(sid)
        if not s:
            raise FileNotFoundError(sid)
        s["clipper"].stop()
        bus.say("Scout", f"{s['clipper'].name}: stopping; finishing clips already found")

    def remove_scout(self, sid: str) -> None:
        with self.lock:
            s = self.scouts.get(sid)
            if s and not s["thread"].is_alive():
                del self.scouts[sid]

    def scout_list(self) -> list[dict]:
        with self.lock:
            items = list(self.scouts.items())
        return [{"id": sid, **s["clipper"].status(), "alive": s["thread"].is_alive(),
                 "started": s["started"]} for sid, s in items]

    # -- generate (VOD / file)

    def start_job(self, cfg: dict) -> dict:
        source = cfg.get("url") or ""
        if cfg.get("upload"):
            source = str(self._upload_path(cfg["upload"]))
        if not source:
            raise ValueError("paste a link or upload a video")
        chat = self._upload_path(cfg["chat_upload"]) if cfg.get("chat_upload") else None
        cs, ds = self._settings_from(cfg)
        jid = uuid.uuid4().hex[:8]
        job = {"id": jid, "source": cfg.get("url") or cfg.get("upload_name") or "upload", "status": "running",
               "step": "starting", "progress": 0.0, "started": time.time(), "clips": 0, "error": None}
        with self.lock:
            self.jobs[jid] = job

        def progress(text: str, frac: float) -> None:
            job["step"], job["progress"] = text, round(frac, 3)

        def go():
            try:
                made = clip_vod(source, self.out, cs, ds, chat, int(cfg.get("max_clips", 15)),
                                channel=(cfg.get("channel") or "").strip() or None, progress=progress)
                job.update(status="done", clips=len(made), step=f"made {len(made)} clips", progress=1.0)
            except Exception as e:
                job.update(status="error", error=str(e)[-400:], step="failed")
                bus.say("Scout", f"job failed: {e}", level="error")
        threading.Thread(target=go, daemon=True, name=f"job-{jid}").start()
        return {"id": jid}

    def _upload_path(self, name: str) -> Path:
        p = (self.uploads / name).resolve()
        if not p.is_relative_to(self.uploads) or not p.exists():
            raise FileNotFoundError(name)
        return p

    def save_upload(self, filename: str, stream, length: int) -> str:
        if length > MAX_UPLOAD:
            raise ValueError("file too large")
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", Path(filename).name)[-80:] or "upload"
        name = f"{uuid.uuid4().hex[:8]}_{safe}"
        with open(self.uploads / name, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = stream.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        return name

    def _settings_from(self, cfg: dict) -> tuple[ClipSettings, DetectorSettings]:
        facecam = cfg.get("facecam")
        if isinstance(facecam, str) and facecam.strip():
            facecam = [float(x) for x in facecam.split(",")]
        layout = cfg.get("layout", "blur")
        if layout == "facecam" and not facecam:
            raise ValueError("the facecam layout needs where the webcam is, e.g. 0.75,0.7,0.25,0.3")
        cs = ClipSettings(pre=float(cfg.get("pre", 20)), post=float(cfg.get("post", 10)), layout=layout,
                          facecam=tuple(facecam) if facecam else None, captions=bool(cfg.get("captions", True)),
                          whisper_model=self.settings.get("whisper_model", "small"),
                          ratio=cfg.get("ratio", "9:16"), hook=bool(cfg.get("hook", True)),
                          autoedit=bool(cfg.get("autoedit", False)), color=cfg.get("color", "yellow"))
        ds = DetectorSettings(ratio=float(cfg.get("sensitivity", 2.0)))
        return cs, ds

    def state(self, after: int) -> dict:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j["started"], reverse=True)[:20]
        return {**bus.snapshot(after), "scouts": self.scout_list(), "jobs": jobs,
                "settings": self.public_settings()}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "autoclip"

    def log_message(self, fmt, *args):  # quiet
        log.debug(fmt, *args)

    # -- helpers

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("localhost", "127.0.0.1", "::1")

    def _send(self, code: int, body: bytes, ctype: str = "application/json", extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj).encode())

    def _error(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _file(self, path: Path):
        if not path.is_file():
            return self._error(404, "not found")
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(size - int(m.group(2)), 0)
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if "download" in parse_qs(urlparse(self.path).query):
            self.send_header("Content-Disposition", f'attachment; filename="{path.parent.name}_{path.name}"')
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(1 << 16, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # -- routes

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._error(403, "open the dashboard at http://localhost")
        url = urlparse(self.path)
        p = unquote(url.path)
        if p in ("/", "/index.html"):
            return self._file(WEB / "index.html")
        if p.startswith("/static/"):
            f = (WEB / p[len("/static/"):]).resolve()
            if f.is_relative_to(WEB.resolve()):
                return self._file(f)
            return self._error(404, "not found")
        if p == "/api/state":
            after = int(parse_qs(url.query).get("after", ["0"])[0] or 0)
            return self._json(self.app.state(after))
        if p == "/api/clips":
            return self._json(self.app.clips())
        if p.startswith("/files/"):
            f = (self.app.out / p[len("/files/"):]).resolve()
            if f.is_relative_to(self.app.out) and ".autoclip" not in f.relative_to(self.app.out).parts:
                return self._file(f)
            return self._error(404, "not found")
        return self._error(404, "not found")

    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-Autoclip") != "1":
            return self._error(403, "forbidden")
        url = urlparse(self.path)
        p = unquote(url.path)
        q = parse_qs(url.query)
        app = self.app
        try:
            if p == "/api/upload":
                name = app.save_upload(q.get("name", ["upload"])[0], self.rfile,
                                       int(self.headers.get("Content-Length") or 0))
                return self._json({"upload": name})
            if p == "/api/scouts":
                return self._json(app.start_scout(self._body()))
            if m := re.fullmatch(r"/api/scouts/(\w+)/(stop|remove)", p):
                (app.stop_scout if m.group(2) == "stop" else app.remove_scout)(m.group(1))
                return self._json({"ok": True})
            if p == "/api/generate":
                return self._json(app.start_job(self._body()))
            if p == "/api/settings":
                body = self._body()
                if "anthropic_key" in body:
                    app.settings["anthropic_key"] = body["anthropic_key"].strip()
                    app._apply_key()
                if body.get("whisper_model") in ("tiny", "base", "small", "medium", "large-v3"):
                    app.settings["whisper_model"] = body["whisper_model"]
                if "permission" in body:
                    perm = body["permission"]
                    ch = channel_from_url(perm["channel"])
                    if perm.get("remove"):
                        app.settings["permissions"].pop(ch, None)
                    else:
                        app.settings["permissions"][ch] = {"allowed": bool(perm.get("allowed")),
                                                           "note": str(perm.get("note", ""))[:1000],
                                                           "at": time.time()}
                app.save_settings()
                return self._json(app.public_settings())
            if m := re.fullmatch(r"/api/clips/(.+)/voiceover", p):
                folder = app.clip_folder(m.group(1))
                name = app.save_upload("voice.webm", self.rfile, int(self.headers.get("Content-Length") or 0))
                studio.add_voiceover(folder, app.uploads / name)
                return self._json({"ok": True})
            if m := re.fullmatch(r"/api/clips/(.+)/action", p):
                folder = app.clip_folder(m.group(1))
                body = self._body()
                state = studio.apply(folder, body.pop("action"), body, app.settings.get("permissions"))
                return self._json({"ok": True, "status": state.get("status")})
        except PermissionError as e:
            return self._error(409, str(e))
        except FileNotFoundError:
            return self._error(404, "not found")
        except (ValueError, KeyError) as e:
            return self._error(400, str(e))
        except Exception as e:
            log.exception("request failed")
            return self._error(500, str(e))
        return self._error(404, "not found")


def serve(out_dir: Path, port: int = 8765, open_browser: bool = True) -> None:
    app = App(out_dir)
    Handler.app = app
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    url = f"http://localhost:{port}"
    print(f"autoclip dashboard: {url}   (clips in {app.out}; Ctrl-C to quit)")
    bus.say("Publisher", "dashboard started. Nothing is posted without your approval")
    if open_browser:
        import webbrowser
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for s in app.scouts.values():
            s["clipper"].stop()
        httpd.server_close()
