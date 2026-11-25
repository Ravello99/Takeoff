#!/usr/bin/env python3
"""
Vanguard Takeoff server: serves the built web app AND a small JSON API for
user accounts and server-stored projects. Python standard library only
(sqlite3, hashlib, http.server): nothing to pip install.

    python3 backend/server.py --dist web/dist --data data --port 8090

Data lives under --data:
    takeoff.db         users, sessions, invites, projects, takeoff data
    blobs/ab/abcd…     plan PDFs, stored once by SHA-256 (content-addressed)
Back up the whole data folder; nothing else holds project data.

Accounts: the first visitor creates the admin account (one-time setup).
The admin invites people by email; each invite is a one-time link the
admin sends them. Everyone signed in sees the company's projects; a
project can be deleted by its creator or an admin.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SESSION_DAYS = 30
RESET_HOURS = 1
AI_KEYS = ("ai_base_url", "ai_api_key", "ai_model")
AI_TIMEOUT = 420          # first call after a cold start loads the model; a long schedule is ~8k tokens of answer
SCHEDULE_PROMPT = """You are reading a PARTITION (WALL TYPE) SCHEDULE or wall-type legend from a commercial construction drawing.
List EVERY wall type shown. Return ONLY a JSON array, no prose, no markdown. Each item:
{"tag": "wall type mark exactly as shown, e.g. 1A, W3, P-2",
 "description": "the schedule's own description in one line",
 "stud_size": "e.g. 3-5/8\" or 6\" or 2-1/2\" C-H, or \"\" if none",
 "stud_gauge": "e.g. 20ga, 25ga, or \"\"",
 "stud_oc": number in inches (12, 16, 19.2, 24) or null,
 "board": "board type, e.g. 5/8\" Type X",
 "layers_per_side": number or null,
 "sides": 1 or 2 (sides that get board),
 "height": "to deck" or "above ceiling" or the text shown,
 "fire_rating": "e.g. 1 HR, 2 HR, or \"\"",
 "insulation": "e.g. 3-1/2\" sound batt, or \"\"",
 "stc": "STC value if shown, else \"\"",
 "shaft_wall": true or false,
 "furring": true or false,
 "notes": "anything else important"}
Use null or "" when the schedule doesn't say. Do not invent wall types."""
SCHEDULE_TEXT_NOTE = """
The schedule below was extracted from the drawing's text layer: the table layout is gone, so each
wall type usually appears as its title line, its mark on its own line, then its layers as bullet lines.
Metric sizes are fine (e.g. 92mm studs at 400mm o.c. -> stud_size "92mm", stud_oc 16; 600mm o.c. -> 24).
Include exterior wall types too; skip roof, floor and ceiling assemblies."""
NOTES_PROMPT = """You are helping a commercial DRYWALL contractor decide its scope from construction drawing notes.
The text below is the notes, legends and keynotes from the drawings (table layout is lost).
Answer ONLY with one JSON object, no prose, no markdown:
{"existing_walls_in_scope": "yes" | "no" | "unclear",
 "reason": "one sentence quoting or paraphrasing the note that decides it",
 "existing_style": "how the legend says existing walls are drawn (e.g. 'screened/grey', 'hatched', 'dashed'), or \"\"",
 "legend": [
   {"label": "the legend entry's text exactly as written (e.g. 'EXISTING WALL TO REMAIN')",
    "meaning": "new_wall" | "existing_wall" | "demo_wall" | "rated_wall" | "wall_tag" | "door_tag" | "keynote" | "room_tag" | "window_tag" | "other",
    "rating": "fire rating for a rated wall style (e.g. '1 HR'), else \"\"",
    "prefix": "for a tag symbol: the letters its marks start with (e.g. 'D' for door tags D1, D2), else \"\""}],
 "notes": [
   {"mark": "keynote number/letter exactly as shown, or \"\" for a general note",
    "text": "the note, shortened to one line",
    "action": "fur_existing" | "patch_repair" | "new_board_on_existing" | "include_existing" | "exclude" | "demo" | "new_work" | "info",
    "applies_to": "what it applies to (e.g. 'existing exterior walls', 'columns')",
    "rooms": ["room names or numbers the note names, exactly as written"],
    "wall_type": "wall type tag the note calls for (e.g. 'F1', 'WP-2'), or \"\""}]}
For "legend", list the symbol / wall legend entries: wall line styles (new, existing, demolished, rated) and
tag symbols (wall type tags, door tags, keynotes, room tags), so the wall finder can tell them apart.
List only notes that change what drywall work is done to WALLS: work on existing walls (furring, patching,
new board, skim), existing walls excluded or by others, demolition, or new walls the plan doesn't tag.
Skip notes about doors, MEP, flooring, millwork and general conditions. Do not invent notes."""
MAP_TAGS_PROMPT = """A drywall estimator's wall finder read these WALL TYPE TAGS off a floor plan. Match each plan tag to the
project's ASSEMBLY that it means, using the tags, the assemblies' names and descriptions, the measured wall
thickness and the partition schedule text if given. Plan tags and assembly names often differ in format
(e.g. plan "WP-2" = assembly "W2" or "Type 2"; "1A" = "P-1A"). Return null for a tag that is not a wall type
(door, window, room or equipment tags such as D2, W/A, 101) or that matches no assembly. Never guess wildly.
Answer ONLY with a JSON object mapping each plan tag to an assembly id or null, e.g. {"WP-2": "cnd_ab12", "D2": null}."""
REVIEW_RUNS_PROMPT = """This image is a grid of numbered tiles cut from a commercial construction floor plan.
In each tile, ONE candidate wall run found by software is highlighted with a translucent MAGENTA band.
Judge only the highlighted run in each tile:
- "wall": true if it is a real wall or partition (two parallel lines a wall-thickness apart, often hatched or filled);
  false if it is something else: casework/counter/millwork, door frame or swing, window, column, equipment,
  furniture, plumbing fixture, stair, dimension or annotation line, title block or table border.
- "status": "new", "existing", "demo" or "unknown" — existing walls are usually drawn lighter/screened/greyed
  or with a different hatch than new ones; demolished ones dashed.
- "tag": a wall type tag (e.g. "WP-2", "P1") that clearly points at this run, else "".
- "confidence": 0 to 1.
- "why": a few words.
Answer ONLY with a JSON array, one object per tile, e.g. [{"n": 1, "wall": true, "status": "new", "tag": "", "confidence": 0.8, "why": "double line partition"}]."""
EMAIL_KEYS = ("smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from", "public_url")
INVITE_DAYS = 7
MAX_JSON = 64 * 1024 * 1024        # takeoff payload / library JSON
MAX_PDF = 1024 * 1024 * 1024       # 1 GB per plan file
MIN_PASSWORD = 8
COOKIE = "vt_session"
LIBRARY_KINDS = {"templates", "materials", "stamps"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL,
  created_at REAL NOT NULL, updated_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS project_data (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL,
  updated_at REAL NOT NULL, updated_by INTEGER);
CREATE TABLE IF NOT EXISTS pdfs (
  project_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, rev INTEGER NOT NULL,
  size INTEGER NOT NULL, ts REAL NOT NULL, PRIMARY KEY (project_id, name));
CREATE TABLE IF NOT EXISTS pdf_revs (
  project_id TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT NOT NULL,
  ts REAL NOT NULL, PRIMARY KEY (project_id, name, rev));
CREATE TABLE IF NOT EXISTS library (kind TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER, image_hash TEXT, model TEXT,
  raw TEXT, result TEXT, final TEXT, ms INTEGER, created_at REAL NOT NULL, reviewed_at REAL);
CREATE TABLE IF NOT EXISTS wall_decisions (
  id INTEGER PRIMARY KEY, user_id INTEGER, project TEXT, sheet TEXT, feature_version INTEGER NOT NULL,
  f TEXT NOT NULL, y INTEGER NOT NULL, p REAL, tag TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at REAL NOT NULL);
"""


# ── passwords & tokens ──────────────────────────────────────────────────────
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), dk)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginLimiter:
    """5 failed logins per email+IP → locked for 15 minutes."""
    def __init__(self):
        self.lock = threading.Lock()
        self.fails: dict[str, list[float]] = {}

    def blocked(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            recent = [t for t in self.fails.get(key, []) if now - t < 900]
            self.fails[key] = recent
            return len(recent) >= 5

    def fail(self, key: str):
        with self.lock:
            self.fails.setdefault(key, []).append(time.time())

    def clear(self, key: str):
        with self.lock:
            self.fails.pop(key, None)


# ── email ───────────────────────────────────────────────────────────────────
def get_settings(c) -> dict:
    return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}


def email_ready(cfg: dict) -> bool:
    return bool(cfg.get("smtp_host") and cfg.get("smtp_user") and cfg.get("smtp_password"))


def send_mail(cfg: dict, to: str, subject: str, text: str, html: str | None = None) -> None:
    """Send one message through the configured SMTP mailbox. Raises on failure."""
    host = cfg["smtp_host"]
    port = int(cfg.get("smtp_port") or 465)
    user, password = cfg["smtp_user"], cfg["smtp_password"]
    name, addr = parseaddr(cfg.get("smtp_from") or user)
    msg = EmailMessage()
    msg["From"] = formataddr((name or "Vanguard Takeoff", addr or user))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
            s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.starttls(context=ctx)
            s.login(user, password)
            s.send_message(msg)


# ── AI (any OpenAI-compatible endpoint: vLLM on a RunPod Pod or Serverless) ──
def ai_ready(cfg: dict) -> bool:
    return bool(cfg.get("ai_base_url"))


WALL_AUTO_TRAIN = 300          # retrain on its own after this many new reviews
WALL_TRAINING = threading.Event()


def wall_model_status(c) -> dict:
    cfg = get_settings(c)
    model = None
    if cfg.get("wall_model"):
        try:
            model = json.loads(cfg["wall_model"])
        except ValueError:
            model = None
    total = c.execute("SELECT COUNT(*) FROM wall_decisions").fetchone()[0]
    since = c.execute("SELECT COUNT(*) FROM wall_decisions WHERE id > ?", (int(cfg.get("wall_model_last_id") or 0),)).fetchone()[0]
    return {"model": model, "decisions": total, "since_train": since, "training": WALL_TRAINING.is_set()}


def train_wall_model(c) -> dict:
    import wallmodel
    last = c.execute("SELECT MAX(id) FROM wall_decisions").fetchone()[0] or 0
    rows = [{"f": json.loads(r["f"]), "y": r["y"], "sheet": f'{r["project"]}|{r["sheet"]}'}
            for r in c.execute("SELECT f, y, project, sheet FROM wall_decisions WHERE feature_version=? ORDER BY id DESC LIMIT ?",
                               (wallmodel.FEATURE_VERSION, wallmodel.MAX_ROWS))][::-1]
    model = wallmodel.train(rows, wallmodel.FEATURE_NAMES)
    for k, v in (("wall_model", json.dumps(model, separators=(",", ":"))), ("wall_model_last_id", str(last))):
        c.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    return model


def normalize_ai_url(url: str) -> str:
    """Forgive the usual paste slips: trailing slashes, a pasted /models or
    /chat/completions, and a missing /v1 on a bare vLLM host (RunPod Pod links
    come without it). Serverless addresses already end in /openai/v1."""
    from urllib.parse import urlsplit, urlunsplit
    u = url.strip().rstrip("/")
    for tail in ("/chat/completions", "/completions", "/models"):
        if u.endswith(tail):
            u = u[: -len(tail)].rstrip("/")
    parts = urlsplit(u)
    if parts.path in ("", "/"):
        u = urlunsplit((parts.scheme, parts.netloc, "/v1", "", ""))
    return u


def ai_request(cfg: dict, path: str, body: dict | None = None, timeout: int = AI_TIMEOUT) -> dict:
    """GET/POST JSON to the configured endpoint, e.g. https://<pod>-8000.proxy.runpod.net/v1"""
    import urllib.request
    import urllib.error
    url = normalize_ai_url(cfg["ai_base_url"]) + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 # RunPod's proxy sits behind Cloudflare, which refuses Python's default
                                 # "Python-urllib" signature with Error 1010 — name ourselves instead.
                                 headers={"Content-Type": "application/json", "Accept": "application/json",
                                          "User-Agent": "VanguardTakeoff/1.0 (+https://takeoff.vanguarddrywall.ca)",
                                          **({"Authorization": f"Bearer {cfg['ai_api_key']}"} if cfg.get("ai_api_key") else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        if e.code == 404 and "Jupyter" in detail:
            raise ApiError(502, "That address is the Pod's Jupyter notebook (port 8888). Use the port 8000 link: https://POD-ID-8000.proxy.runpod.net/v1")
        if e.code == 400 and "not a multimodal model" in detail:
            raise ApiError(400, "The model on your AI server reads text only, not pictures. Send the schedule's text instead, or switch the Pod to a vision model (e.g. Qwen/Qwen3-VL-8B-Instruct).")
        if e.code == 404 and path == "/models":
            raise ApiError(502, f"The AI server has nothing at {url}. Check the address ends in /v1 and that vLLM is running on port 8000.")
        raise ApiError(502, f"The AI server answered {e.code}: {detail or e.reason}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(502, f"Couldn't reach the AI server ({getattr(e, 'reason', e)}). Is the Pod running?")


def ai_model(cfg: dict) -> str:
    if cfg.get("ai_model"):
        return cfg["ai_model"]
    models = ai_request(cfg, "/models", timeout=30).get("data") or []
    if not models:
        raise ApiError(502, "The AI server didn't list any models.")
    return models[0]["id"]


def ai_context_len(cfg: dict, model: str) -> int | None:
    """The served model's context window (vLLM lists max_model_len on /models);
    None when the server doesn't say."""
    try:
        for m_ in ai_request(cfg, "/models", timeout=30).get("data") or []:
            if m_.get("id") == model and m_.get("max_model_len"):
                return int(m_["max_model_len"])
    except ApiError:
        pass
    return None


def answer_budget(ctx: int | None, prompt_chars: int, has_image: bool, want: int = 8192) -> int:
    """Answer tokens that fit beside the prompt: ~3.2 characters a token for
    drawing text, ~1,500 tokens for a picture, and a margin for the chat template."""
    if not ctx:
        return want
    prompt = prompt_chars // 3 + (1500 if has_image else 0) + 300
    return max(512, min(want, ctx - prompt))


def extract_json_array(text: str):
    """Pull the JSON array out of a model reply (tolerates ```json fences and chatter)."""
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    start, end = t.find("["), t.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        v = json.loads(t[start:end + 1])
    except json.JSONDecodeError:
        return None
    return v if isinstance(v, list) else None


def extract_json_object(text: str):
    """Pull the JSON object out of a model reply (tolerates fences and chatter)."""
    t = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.S)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        v = json.loads(t[start:end + 1])
    except json.JSONDecodeError:
        return None
    return v if isinstance(v, dict) else None


def mail_html(heading: str, body: str, button: str, url: str) -> str:
    esc = lambda t: (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return f"""<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1C2430">
<p style="font-size:18px;font-weight:bold;color:#0B2556;margin:0 0 4px">Vanguard Takeoff</p>
<p style="font-size:12px;color:#5E6878;margin:0 0 24px">Vanguard Drywall &amp; Acoustics</p>
<h2 style="font-size:20px;margin:0 0 12px">{esc(heading)}</h2>
<p style="font-size:15px;line-height:1.5">{esc(body)}</p>
<p style="margin:28px 0"><a href="{esc(url)}" style="background:#0B2556;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">{esc(button)}</a></p>
<p style="font-size:12px;color:#5E6878;line-height:1.5">If the button doesn't work, paste this link into your browser:<br>{esc(url)}</p>
</div>"""


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── application state ───────────────────────────────────────────────────────
class App:
    def __init__(self, data_dir: Path, dist_dir: Path | None):
        self.data = data_dir
        self.dist = dist_dir
        self.blobs = data_dir / "blobs"
        self.blobs.mkdir(parents=True, exist_ok=True)
        self.db_path = data_dir / "takeoff.db"
        self.limiter = LoginLimiter()
        self.write_lock = threading.Lock()   # serialises version checks + blob refcounts
        c = self.db()
        try:
            c.executescript(SCHEMA)
        finally:
            c.close()

    def db(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.db_path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c

    # blobs
    def blob_path(self, h: str) -> Path:
        return self.blobs / h[:2] / h

    def gc_blob(self, c: sqlite3.Connection, h: str):
        n = c.execute("SELECT (SELECT COUNT(*) FROM pdfs WHERE hash=?) + (SELECT COUNT(*) FROM pdf_revs WHERE hash=?)", (h, h)).fetchone()[0]
        if n == 0:
            try:
                self.blob_path(h).unlink()
            except FileNotFoundError:
                pass


def user_json(u) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "active": bool(u["active"])}


# ── HTTP handler ────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    app: App = None  # set at startup
    server_version = "VanguardTakeoff/1"

    def log_message(self, fmt, *args):  # quieter log: method, path, status
        sys.stderr.write("[takeoff] %s - %s\n" % (self.address_string(), fmt % args))

    # helpers
    def client_ip(self) -> str:
        """The visitor's address; behind the local Caddy proxy, the one it forwards."""
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1"):
            fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            if fwd:
                return fwd
        return ip

    def public_url(self, cfg: dict) -> str:
        if cfg.get("public_url"):
            return cfg["public_url"].rstrip("/")
        proto = "https" if self.secure() else "http"
        return f"{proto}://{self.headers.get('Host', 'localhost')}"

    def secure(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def send_json(self, status: int, obj, extra_headers: dict | None = None):
        body = json.dumps(obj).encode()
        if getattr(self, "_defer", False):
            # inside a DB transaction: hold the response until after commit
            self._pending = (status, body, extra_headers)
            return
        self._write_json(status, body, extra_headers)

    def _write_json(self, status: int, body: bytes, extra_headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def read_body(self, limit: int) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ApiError(413, "That file is too large.")
        return self.rfile.read(n) if n else b""

    def read_json(self) -> dict:
        raw = self.read_body(MAX_JSON)
        try:
            v = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid request.")
        if not isinstance(v, dict):
            raise ApiError(400, "Invalid request.")
        return v

    def session_cookie(self, token: str | None) -> str:
        if token is None:
            return f"{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        sec = "; Secure" if self.secure() else ""
        return f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 86400}{sec}"

    def current_user(self, c):
        raw = self.headers.get("Cookie") or ""
        token = None
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                token = v
        if not token:
            return None
        row = c.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
            (token_hash(token), time.time())).fetchone()
        return row

    def require_user(self, c):
        u = self.current_user(c)
        if not u:
            raise ApiError(401, "Please sign in.")
        return u

    def require_admin(self, c):
        u = self.require_user(c)
        if u["role"] != "admin":
            raise ApiError(403, "Only an admin can do that.")
        return u

    def new_session(self, c, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions VALUES (?,?,?)", (token_hash(token), user_id, time.time() + SESSION_DAYS * 86400))
        c.execute("DELETE FROM sessions WHERE expires_at<?", (time.time(),))
        return token

    def project_or_404(self, c, pid: str):
        p = c.execute("SELECT * FROM projects WHERE id=? AND deleted=0", (pid,)).fetchone()
        if not p:
            raise ApiError(404, "That project doesn't exist or was deleted.")
        return p

    def touch(self, c, pid: str):
        c.execute("UPDATE projects SET updated_at=? WHERE id=?", (time.time(), pid))

    # dispatch
    def do_GET(self): self.dispatch("GET")
    def do_HEAD(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_PATCH(self): self.dispatch("PATCH")
    def do_DELETE(self): self.dispatch("DELETE")

    def dispatch(self, method: str):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/api/"):
            if method != "GET":
                return self.send_json(405, {"error": "Method not allowed"})
            return self.serve_static(path)
        # CSRF guard: browsers can't add a custom header cross-site without CORS.
        if method != "GET" and self.headers.get("X-Vanguard") != "1":
            return self.send_json(403, {"error": "Request blocked."})
        parts = [urllib.parse.unquote(p) for p in path[len("/api/"):].split("/") if p != ""]
        self._pending = None
        c = self.app.db()
        try:
            self._defer = True
            try:
                with c:                      # commits on success, rolls back on error
                    self.route(c, method, parts)
            finally:
                self._defer = False
            if self._pending:
                self._write_json(*self._pending)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # never leak a traceback to the browser
            sys.stderr.write(f"[takeoff] error on {method} {path}: {e!r}\n")
            self.send_json(500, {"error": "Something went wrong on the server."})
        finally:
            c.close()

    # ── routes ────────────────────────────────────────────────────────────
    def route(self, c, m: str, p: list[str]):
        a = self.app
        if p == ["status"] and m == "GET":
            n = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            u = self.current_user(c)
            return self.send_json(200, {"server": True, "setup_needed": n == 0, "user": user_json(u) if u else None,
                                        "email_enabled": email_ready(get_settings(c)), "ai_enabled": ai_ready(get_settings(c))})

        if p == ["setup"] and m == "POST":
            body = self.read_json()
            with a.write_lock:
                if c.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
                    raise ApiError(409, "Setup is already done — sign in instead.")
                name, email, pw = self.validate_account(body, need_email=True)
                cur = c.execute("INSERT INTO users (email,name,pw,role,active,created_at) VALUES (?,?,?,?,1,?)",
                                (email, name, hash_password(pw), "admin", time.time()))
                token = self.new_session(c, cur.lastrowid)
                u = c.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
            return self.send_json(200, {"user": user_json(u)}, {"Set-Cookie": self.session_cookie(token)})

        if p == ["login"] and m == "POST":
            body = self.read_json()
            email = str(body.get("email", "")).strip()
            key = f"{email.lower()}|{self.client_ip()}"
            if a.limiter.blocked(key):
                raise ApiError(429, "Too many attempts. Wait 15 minutes and try again.")
            u = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not u or not check_password(str(body.get("password", "")), u["pw"]):
                a.limiter.fail(key)
                raise ApiError(401, "That email and password don't match.")
            if not u["active"]:
                raise ApiError(403, "This account has been turned off. Ask your admin.")
            a.limiter.clear(key)
            token = self.new_session(c, u["id"])
            return self.send_json(200, {"user": user_json(u)}, {"Set-Cookie": self.session_cookie(token)})

        if p == ["logout"] and m == "POST":
            raw = self.headers.get("Cookie") or ""
            for part in raw.split(";"):
                k, _, v = part.strip().partition("=")
                if k == COOKIE:
                    c.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(v),))
            return self.send_json(200, {"ok": True}, {"Set-Cookie": self.session_cookie(None)})

        # invite acceptance (public)
        if len(p) >= 2 and p[0] == "invites" and m in ("GET", "POST") and (len(p) == 2 and m == "GET" or p[2:] == ["accept"]):
            inv = c.execute("SELECT * FROM invites WHERE token_hash=? AND expires_at>?", (token_hash(p[1]), time.time())).fetchone()
            if not inv:
                raise ApiError(404, "This invite link has expired or was already used. Ask your admin for a new one.")
            if m == "GET":
                return self.send_json(200, {"email": inv["email"], "role": inv["role"]})
            body = self.read_json()
            with a.write_lock:
                if c.execute("SELECT 1 FROM users WHERE email=?", (inv["email"],)).fetchone():
                    raise ApiError(409, "An account with this email already exists — sign in instead.")
                name, _, pw = self.validate_account(body, need_email=False)
                cur = c.execute("INSERT INTO users (email,name,pw,role,active,created_at) VALUES (?,?,?,?,1,?)",
                                (inv["email"], name, hash_password(pw), inv["role"], time.time()))
                c.execute("DELETE FROM invites WHERE token_hash=?", (inv["token_hash"],))
                token = self.new_session(c, cur.lastrowid)
                u = c.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
            return self.send_json(200, {"user": user_json(u)}, {"Set-Cookie": self.session_cookie(token)})

        # ── password reset (public) ────────────────────────────────────────
        if p == ["password", "forgot"] and m == "POST":
            body = self.read_json()
            email = str(body.get("email", "")).strip()
            key = f"forgot|{email.lower()}|{self.client_ip()}"
            if a.limiter.blocked(key):
                raise ApiError(429, "Too many requests. Wait 15 minutes and try again.")
            a.limiter.fail(key)   # counts every request: max 5 per 15 min
            cfg = get_settings(c)
            u = c.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
            if u and email_ready(cfg):
                url = self.create_reset(c, u["id"], cfg)
                self.mail_async(cfg, u["email"], "Reset your Vanguard Takeoff password",
                                f"Hi {u['name']},\n\nSomeone (hopefully you) asked to reset your Vanguard Takeoff password. "
                                f"Open this link within {RESET_HOURS} hour to choose a new one:\n\n{url}\n\n"
                                "If you didn't ask for this, ignore this email; your password stays the same.",
                                mail_html("Reset your password", f"Hi {u['name']}, open the link below within {RESET_HOURS} hour to choose a new password. If you didn't ask for this, ignore this email.", "Choose a new password", url))
            # same answer whether or not the account exists
            return self.send_json(200, {"ok": True, "email_enabled": email_ready(cfg)})
        if len(p) == 3 and p[:2] == ["password", "reset"] and m in ("GET", "POST"):
            row = c.execute("SELECT r.*, u.email, u.name FROM resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.expires_at>? AND u.active=1",
                            (token_hash(p[2]), time.time())).fetchone()
            if not row:
                raise ApiError(404, "This reset link has expired or was already used. Ask for a new one.")
            if m == "GET":
                return self.send_json(200, {"email": row["email"]})
            pw = str(self.read_json().get("password", ""))
            if len(pw) < MIN_PASSWORD:
                raise ApiError(400, f"Use a password with at least {MIN_PASSWORD} characters.")
            c.execute("UPDATE users SET pw=? WHERE id=?", (hash_password(pw), row["user_id"]))
            c.execute("DELETE FROM resets WHERE user_id=?", (row["user_id"],))
            c.execute("DELETE FROM sessions WHERE user_id=?", (row["user_id"],))   # sign out everywhere else
            token = self.new_session(c, row["user_id"])
            u = c.execute("SELECT * FROM users WHERE id=?", (row["user_id"],)).fetchone()
            return self.send_json(200, {"user": user_json(u)}, {"Set-Cookie": self.session_cookie(token)})

        me = self.require_user(c)

        if p == ["me"] and m == "GET":
            return self.send_json(200, {"user": user_json(me)})
        if p == ["account", "password"] and m == "POST":
            body = self.read_json()
            if not check_password(str(body.get("current", "")), me["pw"]):
                raise ApiError(400, "Your current password isn't right.")
            new = str(body.get("new", ""))
            if len(new) < MIN_PASSWORD:
                raise ApiError(400, f"Use at least {MIN_PASSWORD} characters.")
            c.execute("UPDATE users SET pw=? WHERE id=?", (hash_password(new), me["id"]))
            return self.send_json(200, {"ok": True})

        # ── admin: users & invites ─────────────────────────────────────────
        if p == ["users"] and m == "GET":
            self.require_admin(c)
            rows = c.execute("SELECT * FROM users ORDER BY created_at").fetchall()
            return self.send_json(200, {"users": [user_json(u) for u in rows]})
        if len(p) == 2 and p[0] == "users" and m == "PATCH":
            self.require_admin(c)
            body = self.read_json()
            uid = int(p[1]) if p[1].isdigit() else -1
            target = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not target:
                raise ApiError(404, "No such user.")
            role = body.get("role", target["role"])
            active = int(bool(body.get("active", target["active"])))
            if role not in ("admin", "user"):
                raise ApiError(400, "Role must be admin or user.")
            if target["role"] == "admin" and (role != "admin" or not active):
                admins = c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0]
                if admins <= 1:
                    raise ApiError(400, "You can't remove the last admin.")
            c.execute("UPDATE users SET role=?, active=? WHERE id=?", (role, active, uid))
            if not active:
                c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            return self.send_json(200, {"user": user_json(c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())})
        if len(p) == 3 and p[0] == "users" and p[2] == "reset" and m == "POST":
            self.require_admin(c)
            target = c.execute("SELECT * FROM users WHERE id=? AND active=1", (int(p[1]) if p[1].isdigit() else -1,)).fetchone()
            if not target:
                raise ApiError(404, "No such active user.")
            cfg = get_settings(c)
            url = self.create_reset(c, target["id"], cfg)
            out = {"url": url, "emailed": False}
            if email_ready(cfg):
                try:
                    send_mail(cfg, target["email"], "Reset your Vanguard Takeoff password",
                              f"Hi {target['name']},\n\nYour admin sent you a link to set a new Vanguard Takeoff password. "
                              f"It works once, within {RESET_HOURS} hour:\n\n{url}\n",
                              mail_html("Set a new password", f"Hi {target['name']}, your admin sent you this link to set a new password. It works once, within {RESET_HOURS} hour.", "Choose a new password", url))
                    out["emailed"] = True
                except Exception as e:
                    out["email_error"] = f"Couldn't send the email ({type(e).__name__}: {e}). Copy the link instead."
            return self.send_json(200, out)
        if p == ["settings", "email"] and m == "GET":
            self.require_admin(c)
            cfg = get_settings(c)
            return self.send_json(200, {"smtp_host": cfg.get("smtp_host", ""), "smtp_port": cfg.get("smtp_port", "465"),
                                        "smtp_user": cfg.get("smtp_user", ""), "smtp_from": cfg.get("smtp_from", ""),
                                        "public_url": cfg.get("public_url", ""), "has_password": bool(cfg.get("smtp_password")),
                                        "configured": email_ready(cfg), "suggested_url": self.public_url({})})
        if p == ["settings", "email"] and m == "PUT":
            self.require_admin(c)
            body = self.read_json()
            for k in EMAIL_KEYS:
                if k not in body:
                    continue
                v = str(body[k] or "").strip()
                if k == "smtp_password" and not v:
                    continue   # blank = keep the saved password
                if k == "smtp_port" and v and not v.isdigit():
                    raise ApiError(400, "Port must be a number (465 or 587).")
                c.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
            return self.send_json(200, {"ok": True, "configured": email_ready(get_settings(c))})
        if p == ["settings", "email", "test"] and m == "POST":
            admin = self.require_admin(c)
            cfg = get_settings(c)
            if not email_ready(cfg):
                raise ApiError(400, "Fill in the mail server, username and password first.")
            try:
                send_mail(cfg, admin["email"], "Vanguard Takeoff test email",
                          "This is a test from Vanguard Takeoff. Email is working: invites and password resets will be sent automatically.")
            except Exception as e:
                raise ApiError(400, f"The mail server refused it: {type(e).__name__}: {e}")
            return self.send_json(200, {"ok": True, "to": admin["email"]})
        if p == ["settings", "ai"] and m == "GET":
            self.require_admin(c)
            cfg = get_settings(c)
            return self.send_json(200, {"ai_base_url": cfg.get("ai_base_url", ""), "ai_model": cfg.get("ai_model", ""),
                                        "has_key": bool(cfg.get("ai_api_key")), "configured": ai_ready(cfg)})
        if p == ["settings", "ai"] and m == "PUT":
            self.require_admin(c)
            body = self.read_json()
            for k in AI_KEYS:
                if k not in body:
                    continue
                v = str(body[k] or "").strip()
                if k == "ai_api_key" and not v:
                    continue   # blank = keep the saved key
                if k == "ai_base_url" and v and not re.match(r"^https?://", v):
                    raise ApiError(400, "The address must start with https:// (e.g. https://abc123-8000.proxy.runpod.net/v1).")
                if k == "ai_base_url" and v:
                    v = normalize_ai_url(v)
                c.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
            return self.send_json(200, {"ok": True, "configured": ai_ready(get_settings(c))})
        if p == ["settings", "ai", "test"] and m == "POST":
            self.require_admin(c)
            cfg = get_settings(c)
            if not ai_ready(cfg):
                raise ApiError(400, "Enter the AI server address first.")
            models = ai_request(cfg, "/models", timeout=60).get("data") or []
            return self.send_json(200, {"ok": True, "models": [m_["id"] for m_ in models]})
        if p == ["ai", "read-schedule"] and m == "POST":
            return self.ai_read_schedule(c, me)
        if p == ["ai", "review-runs"] and m == "POST":
            return self.ai_review_runs(c, me)
        if p == ["ai", "map-tags"] and m == "POST":
            return self.ai_map_tags(c, me)
        if p == ["ai", "read-notes"] and m == "POST":
            return self.ai_read_notes(c, me)
        if p == ["ai", "feedback"] and m == "POST":
            body = self.read_json()
            log_id = int(body.get("log_id") or 0)
            final = body.get("final")
            if not c.execute("SELECT 1 FROM ai_log WHERE id=?", (log_id,)).fetchone():
                raise ApiError(404, "No such AI result.")
            c.execute("UPDATE ai_log SET final=?, reviewed_at=? WHERE id=?", (json.dumps(final), time.time(), log_id))
            return self.send_json(200, {"ok": True})
        if p == ["ai", "walls", "decisions"] and m == "POST":
            return self.wall_decisions(c, me)
        if p == ["ai", "walls", "model"] and m == "GET":
            return self.send_json(200, wall_model_status(c))
        if p == ["ai", "walls", "train"] and m == "POST":
            self.require_admin(c)
            try:
                model = train_wall_model(c)
            except ValueError as e:
                raise ApiError(400, str(e))
            return self.send_json(200, {"ok": True, "metrics": model["metrics"], "seconds": model.get("seconds")})
        if p == ["ai", "log"] and m == "GET":
            self.require_admin(c)
            rows = c.execute("SELECT id, kind, model, ms, created_at, reviewed_at, (final IS NOT NULL) AS corrected FROM ai_log ORDER BY id DESC LIMIT 200").fetchall()
            total = c.execute("SELECT COUNT(*), SUM(final IS NOT NULL) FROM ai_log").fetchone()
            return self.send_json(200, {"items": [dict(r_) for r_ in rows], "total": total[0], "reviewed": total[1] or 0})
        if p == ["invites"] and m == "GET":
            self.require_admin(c)
            rows = c.execute("SELECT email, role, created_at, expires_at, token_hash FROM invites WHERE expires_at>? ORDER BY created_at DESC", (time.time(),)).fetchall()
            return self.send_json(200, {"invites": [{"id": r["token_hash"][:16], "email": r["email"], "role": r["role"], "expires_at": r["expires_at"]} for r in rows]})
        if p == ["invites"] and m == "POST":
            admin = self.require_admin(c)
            body = self.read_json()
            email = str(body.get("email", "")).strip()
            role = body.get("role", "user")
            if not EMAIL_RE.match(email):
                raise ApiError(400, "Enter a valid email address.")
            if role not in ("admin", "user"):
                raise ApiError(400, "Role must be admin or user.")
            if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                raise ApiError(409, "That person already has an account.")
            c.execute("DELETE FROM invites WHERE email=?", (email,))   # newest link wins
            token = secrets.token_urlsafe(24)
            c.execute("INSERT INTO invites VALUES (?,?,?,?,?,?)",
                      (token_hash(token), email, role, admin["id"], time.time(), time.time() + INVITE_DAYS * 86400))
            out = {"email": email, "role": role, "path": f"/invite?token={token}", "expires_days": INVITE_DAYS, "emailed": False}
            cfg = get_settings(c)
            if body.get("send_email", True) and email_ready(cfg):
                url = self.public_url(cfg) + out["path"]
                try:
                    send_mail(cfg, email, "You're invited to Vanguard Takeoff",
                              f"Hi,\n\n{admin['name']} invited you to Vanguard Takeoff, Vanguard Drywall's takeoff and estimating app.\n\n"
                              f"Open this link to set up your account (it works once and expires in {INVITE_DAYS} days):\n\n{url}\n",
                              mail_html("You're invited", f"{admin['name']} invited you to Vanguard Takeoff, Vanguard Drywall's takeoff and estimating app. The link works once and expires in {INVITE_DAYS} days.", "Set up my account", url))
                    out["emailed"] = True
                except Exception as e:  # report it; the admin can still copy the link
                    out["email_error"] = f"Couldn't send the email ({type(e).__name__}: {e}). Copy the link instead."
            return self.send_json(200, out)
        if len(p) == 2 and p[0] == "invites" and m == "DELETE":
            self.require_admin(c)
            c.execute("DELETE FROM invites WHERE substr(token_hash,1,16)=?", (p[1],))
            return self.send_json(200, {"ok": True})

        # ── projects ────────────────────────────────────────────────────────
        if p == ["projects"] and m == "GET":
            rows = c.execute("""
              SELECT pr.*, u.name AS creator, (SELECT COUNT(*) FROM pdfs WHERE project_id=pr.id) AS plans
              FROM projects pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.deleted=0 ORDER BY pr.updated_at DESC""").fetchall()
            return self.send_json(200, {"projects": [{
                "id": r["id"], "name": r["name"], "creator": r["creator"] or "", "created_by": r["created_by"],
                "created_at": r["created_at"], "updated_at": r["updated_at"], "plans": r["plans"],
                "can_delete": me["role"] == "admin" or r["created_by"] == me["id"]} for r in rows]})
        if p == ["projects"] and m == "POST":
            name = str(self.read_json().get("name", "")).strip()[:120]
            if not name:
                raise ApiError(400, "Give the project a name.")
            pid = secrets.token_hex(8)
            now = time.time()
            c.execute("INSERT INTO projects VALUES (?,?,?,?,?,0)", (pid, name, me["id"], now, now))
            return self.send_json(200, {"id": pid, "name": name})

        if len(p) >= 2 and p[0] == "projects":
            pr = self.project_or_404(c, p[1])
            pid = pr["id"]
            rest = p[2:]
            if not rest and m == "GET":
                return self.send_json(200, {"id": pid, "name": pr["name"]})
            if not rest and m == "PATCH":
                name = str(self.read_json().get("name", "")).strip()[:120]
                if not name:
                    raise ApiError(400, "Give the project a name.")
                c.execute("UPDATE projects SET name=?, updated_at=? WHERE id=?", (name, time.time(), pid))
                return self.send_json(200, {"id": pid, "name": name})
            if not rest and m == "DELETE":
                if me["role"] != "admin" and pr["created_by"] != me["id"]:
                    raise ApiError(403, "Only the person who created this project or an admin can delete it.")
                # soft delete: data is kept and can be restored from the database
                c.execute("UPDATE projects SET deleted=1, updated_at=? WHERE id=?", (time.time(), pid))
                return self.send_json(200, {"ok": True})

            if rest == ["annotations"] and m == "GET":
                row = c.execute("SELECT version, json FROM project_data WHERE project_id=?", (pid,)).fetchone()
                payload = json.loads(row["json"]) if row else None
                return self.send_json(200, {"version": row["version"] if row else 0, "payload": payload, "name": pr["name"]})
            if rest == ["annotations"] and m == "PUT":
                body = self.read_json()
                payload = body.get("payload")
                if not isinstance(payload, dict):
                    raise ApiError(400, "Invalid takeoff data.")
                base = body.get("version")
                with a.write_lock:
                    row = c.execute("SELECT version FROM project_data WHERE project_id=?", (pid,)).fetchone()
                    cur = row["version"] if row else 0
                    if base is not None and int(base) != cur:
                        raise ApiError(409, "Someone else saved this project since you opened it — reload to get their changes.")
                    nv = cur + 1
                    c.execute("INSERT INTO project_data VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version, json=excluded.json, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                              (pid, nv, json.dumps(payload), time.time(), me["id"]))
                    self.touch(c, pid)
                return self.send_json(200, {"version": nv})

            if rest == ["pdfs"] and m == "GET":
                rows = c.execute("SELECT name, hash, rev, size, ts FROM pdfs WHERE project_id=? ORDER BY name", (pid,)).fetchall()
                return self.send_json(200, {"pdfs": [dict(r) for r in rows]})
            if len(rest) >= 2 and rest[0] == "pdfs":
                name = rest[1]
                if not name or len(name) > 400 or "\x00" in name:
                    raise ApiError(400, "Invalid file name.")
                if len(rest) == 2 and m == "GET":
                    row = c.execute("SELECT hash FROM pdfs WHERE project_id=? AND name=?", (pid, name)).fetchone()
                    if not row:
                        raise ApiError(404, "That plan isn't in this project.")
                    return self.send_blob(row["hash"])
                if len(rest) == 2 and m == "PUT":
                    return self.put_pdf(c, pid, name)
                if len(rest) == 2 and m == "DELETE":
                    with a.write_lock:
                        hashes = [r["hash"] for r in c.execute(
                            "SELECT hash FROM pdfs WHERE project_id=? AND name=? UNION SELECT hash FROM pdf_revs WHERE project_id=? AND name=?",
                            (pid, name, pid, name)).fetchall()]
                        c.execute("DELETE FROM pdfs WHERE project_id=? AND name=?", (pid, name))
                        c.execute("DELETE FROM pdf_revs WHERE project_id=? AND name=?", (pid, name))
                        for h in hashes:
                            a.gc_blob(c, h)
                        self.touch(c, pid)
                    return self.send_json(200, {"ok": True})
                if rest[2:] == ["revs"] and m == "GET":
                    rows = c.execute("SELECT rev, hash, ts FROM pdf_revs WHERE project_id=? AND name=? ORDER BY rev", (pid, name)).fetchall()
                    return self.send_json(200, {"revs": [dict(r) for r in rows]})
                if len(rest) == 4 and rest[2] == "revs" and m == "GET":
                    row = c.execute("SELECT hash FROM pdf_revs WHERE project_id=? AND name=? AND rev=?", (pid, name, int(rest[3]) if rest[3].isdigit() else -1)).fetchone()
                    if not row:
                        raise ApiError(404, "No such revision.")
                    return self.send_blob(row["hash"])

        # ── company-wide libraries ──────────────────────────────────────────
        if len(p) == 2 and p[0] == "library" and p[1] in LIBRARY_KINDS:
            if m == "GET":
                row = c.execute("SELECT json FROM library WHERE kind=?", (p[1],)).fetchone()
                return self.send_json(200, {"value": json.loads(row["json"]) if row else None})
            if m == "PUT":
                body = self.read_json()
                c.execute("INSERT INTO library VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                          (p[1], json.dumps(body.get("value")), time.time()))
                return self.send_json(200, {"ok": True})

        raise ApiError(404, "Not found.")

    def ai_read_schedule(self, c, me):
        """Image of a wall-type schedule → wall types as JSON, via the configured model.
        The image, the model's answer and (later) the estimator's corrections are kept
        in ai_log: that is the training data for fine-tuning a Vanguard model."""
        import base64
        cfg = get_settings(c)
        if not ai_ready(cfg):
            raise ApiError(400, "AI isn't connected yet. An admin can add it on the Team page.")
        body = self.read_json()
        img = str(body.get("image") or "")
        sched_text = str(body.get("text") or "").strip()
        source = str(body.get("source") or "").strip()[:200]   # e.g. "A002 · bay.pdf p3"
        if sched_text:
            # the schedule as read from the drawing's own text layer (Takeoff
            # finds it in the project) — works with text-only models
            sched_text = sched_text[:20000]
            raw_bytes = sched_text.encode("utf-8")
        else:
            m_ = re.match(r"^data:(image/(?:png|jpeg|webp));base64,(.+)$", img, re.S)
            if not m_:
                raise ApiError(400, "Send the schedule text or a PNG/JPEG image.")
            raw_bytes = base64.b64decode(m_.group(2))
            if len(raw_bytes) > 25 * 1024 * 1024:
                raise ApiError(413, "That image is too large (25 MB max).")
        digest = hashlib.sha256(raw_bytes).hexdigest()
        dest = self.app.blob_path(digest)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw_bytes)
        model = ai_model(cfg)
        hint = str(body.get("hint") or "").strip()[:500]
        t0 = time.time()
        ctx = ai_context_len(cfg, model)
        budget = answer_budget(ctx, len(SCHEDULE_PROMPT) + len(SCHEDULE_TEXT_NOTE) + len(sched_text) + len(hint), not sched_text)
        if ctx and budget < 1500:
            raise ApiError(400, f"The AI's context window ({ctx} tokens) is too small for this schedule. Raise --max-model-len on the Pod (e.g. 16384 with --quantization fp8).")
        out = ai_request(cfg, "/chat/completions", {
            "model": model, "temperature": 0, "max_tokens": budget,
            # Qwen3-family models reason out loud before answering unless told not
            # to: on a 30-type schedule the reasoning alone used up the answer
            # budget and cut the list off. Reading a schedule needs no reasoning.
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": (
                SCHEDULE_PROMPT + SCHEDULE_TEXT_NOTE + (f"\nExtra note from the estimator: {hint}" if hint else "")
                + f"\n\nSCHEDULE TEXT{f' (from {source})' if source else ''}:\n{sched_text}"
            ) if sched_text else [
                {"type": "image_url", "image_url": {"url": img}},
                {"type": "text", "text": SCHEDULE_PROMPT + (f"\nExtra note from the estimator: {hint}" if hint else "")}]}],
        })
        ms = int((time.time() - t0) * 1000)
        text = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        if isinstance(text, list):   # some servers return content parts
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
        walls = extract_json_array(text)
        cur = c.execute("INSERT INTO ai_log (kind, user_id, image_hash, model, raw, result, ms, created_at) VALUES (?,?,?,?,?,?,?,?)",
                        ("schedule", me["id"], digest, model, text, json.dumps(walls) if walls is not None else None, ms, time.time()))
        if walls is None:   # still logged: bad answers are training data too
            return self.send_json(200, {"log_id": cur.lastrowid, "model": model, "ms": ms, "walls": [], "raw": text[:2000],
                                        "error": "The AI answered, but not with a list of wall types. Try a tighter crop of just the schedule."})
        return self.send_json(200, {"log_id": cur.lastrowid, "model": model, "ms": ms, "walls": walls})

    def ai_review_runs(self, c, me):
        """A grid of numbered plan tiles, each with one highlighted candidate run →
        the vision model's verdict per tile. Image and answer are logged: training
        data for fine-tuning a vision model on Vanguard's own drawings."""
        import base64
        cfg = get_settings(c)
        if not ai_ready(cfg):
            raise ApiError(400, "AI isn't connected yet.")
        body = self.read_json()
        img = str(body.get("image") or "")
        m_ = re.match(r"^data:(image/(?:png|jpeg|webp));base64,(.+)$", img, re.S)
        if not m_:
            raise ApiError(400, "Send the tiles as a PNG or JPEG image.")
        raw_bytes = base64.b64decode(m_.group(2))
        if len(raw_bytes) > 15 * 1024 * 1024:
            raise ApiError(413, "That image is too large.")
        digest = hashlib.sha256(raw_bytes).hexdigest()
        dest = self.app.blob_path(digest)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw_bytes)
        n = max(1, min(40, int(body.get("count") or 1)))
        hint = str(body.get("legend") or "").strip()[:800]
        model = ai_model(cfg)
        ctx = ai_context_len(cfg, model)
        budget = answer_budget(ctx, len(REVIEW_RUNS_PROMPT) + len(hint), True, want=min(4000, 120 * n + 200))
        t0 = time.time()
        out = ai_request(cfg, "/chat/completions", {
            "model": model, "temperature": 0, "max_tokens": budget,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": img}},
                {"type": "text", "text": REVIEW_RUNS_PROMPT + f"\nThere are {n} tiles." + (f"\nThe drawing's legend says: {hint}" if hint else "")}]}],
        })
        ms = int((time.time() - t0) * 1000)
        reply = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        if isinstance(reply, list):
            reply = "".join(part.get("text", "") for part in reply if isinstance(part, dict))
        reply = re.sub(r"<think>.*?</think>", "", reply, flags=re.S)
        verdicts = extract_json_array(reply) or []
        clean = []
        for v in verdicts:
            if not isinstance(v, dict):
                continue
            try:
                k = int(v.get("n"))
            except (TypeError, ValueError):
                continue
            if 1 <= k <= n:
                conf = v.get("confidence")
                clean.append({"n": k, "wall": v.get("wall") is not False, "status": str(v.get("status") or "unknown").lower()[:10],
                              "tag": str(v.get("tag") or "")[:12], "confidence": float(conf) if isinstance(conf, (int, float)) else 0.5,
                              "why": str(v.get("why") or "")[:80]})
        c.execute("INSERT INTO ai_log (kind, user_id, image_hash, model, raw, result, ms, created_at) VALUES (?,?,?,?,?,?,?,?)",
                  ("vision_runs", me["id"], digest, model, reply, json.dumps(clean), ms, time.time()))
        return self.send_json(200, {"verdicts": clean, "ms": ms, "model": model})

    def ai_map_tags(self, c, me):
        """Plan wall tags → the project's assemblies (ids), when their names differ."""
        cfg = get_settings(c)
        if not ai_ready(cfg):
            raise ApiError(400, "AI isn't connected yet.")
        body = self.read_json()
        tags = [t for t in (body.get("tags") or []) if isinstance(t, dict) and t.get("tag")][:60]
        asm = [a for a in (body.get("assemblies") or []) if isinstance(a, dict) and a.get("id")][:200]
        if not tags or not asm:
            return self.send_json(200, {"map": {}})
        ids = {str(a["id"]) for a in asm}
        lines = ["PLAN TAGS:"] + [f'- {str(t["tag"])[:20]} (measured {t.get("thick_in", "?")}" thick, {t.get("runs", "?")} runs)' for t in tags]
        lines += ["", "ASSEMBLIES:"] + [f'- id {str(a["id"])[:40]}: {str(a.get("tag") or "")[:30]} — {str(a.get("desc") or "")[:160]}' for a in asm]
        sched = str(body.get("schedule") or "")[:6000]
        if sched:
            lines += ["", "PARTITION SCHEDULE TEXT:", sched]
        model = ai_model(cfg)
        t0 = time.time()
        out = ai_request(cfg, "/chat/completions", {
            "model": model, "temperature": 0, "max_tokens": 1200,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": MAP_TAGS_PROMPT + "\n\n" + "\n".join(lines)}],
        })
        ms = int((time.time() - t0) * 1000)
        reply = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        if isinstance(reply, list):
            reply = "".join(part.get("text", "") for part in reply if isinstance(part, dict))
        result = extract_json_object(reply) or {}
        clean = {str(k)[:20]: (str(v) if v is not None and str(v) in ids else None) for k, v in result.items()}
        c.execute("INSERT INTO ai_log (kind, user_id, image_hash, model, raw, result, ms, created_at) VALUES (?,?,?,?,?,?,?,?)",
                  ("map_tags", me["id"], None, model, reply, json.dumps(clean), ms, time.time()))
        return self.send_json(200, {"map": clean, "ms": ms})

    def ai_read_notes(self, c, me):
        """Drawing notes/legends/keynotes (text) → which walls are in scope, as JSON.
        Logged in ai_log (kind "notes") like schedule reads: training data."""
        cfg = get_settings(c)
        if not ai_ready(cfg):
            raise ApiError(400, "AI isn't connected yet. An admin can add it on the Team page.")
        body = self.read_json()
        text = str(body.get("text") or "").strip()[:24000]
        if len(text) < 20:
            raise ApiError(400, "No notes text to read.")
        source = str(body.get("source") or "").strip()[:300]
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        dest = self.app.blob_path(digest)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(text.encode("utf-8"))
        model = ai_model(cfg)
        ctx = ai_context_len(cfg, model)
        budget = answer_budget(ctx, len(NOTES_PROMPT) + len(text), False, want=3000)
        if ctx and budget < 800:
            raise ApiError(400, f"The AI's context window ({ctx} tokens) is too small for these notes. Raise --max-model-len on the Pod.")
        t0 = time.time()
        out = ai_request(cfg, "/chat/completions", {
            "model": model, "temperature": 0, "max_tokens": budget,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": NOTES_PROMPT + f"\n\nNOTES TEXT{f' (from {source})' if source else ''}:\n{text}"}],
        })
        ms = int((time.time() - t0) * 1000)
        reply = ((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        if isinstance(reply, list):
            reply = "".join(part.get("text", "") for part in reply if isinstance(part, dict))
        result = extract_json_object(reply)
        cur = c.execute("INSERT INTO ai_log (kind, user_id, image_hash, model, raw, result, ms, created_at) VALUES (?,?,?,?,?,?,?,?)",
                        ("notes", me["id"], digest, model, reply, json.dumps(result) if result is not None else None, ms, time.time()))
        if result is None:
            return self.send_json(200, {"log_id": cur.lastrowid, "model": model, "ms": ms, "result": None,
                                        "error": "The AI answered, but not in the expected form. Try again."})
        notes = [n for n in (result.get("notes") or []) if isinstance(n, dict)][:60]
        clean = {
            "existing_walls_in_scope": str(result.get("existing_walls_in_scope") or "unclear").lower(),
            "reason": str(result.get("reason") or "")[:400],
            "existing_style": str(result.get("existing_style") or "")[:120],
            "notes": [{"mark": str(n.get("mark") or "")[:8], "text": str(n.get("text") or "")[:300], "action": str(n.get("action") or "info"),
                       "applies_to": str(n.get("applies_to") or "")[:160], "rooms": [str(r)[:60] for r in (n.get("rooms") or []) if r][:12],
                       "wall_type": str(n.get("wall_type") or "")[:20]} for n in notes],
            "legend": [{"label": str(e.get("label") or "")[:120], "meaning": str(e.get("meaning") or "other"), "rating": str(e.get("rating") or "")[:20],
                        "prefix": str(e.get("prefix") or "")[:6]} for e in (result.get("legend") or []) if isinstance(e, dict) and e.get("label")][:40],
        }
        return self.send_json(200, {"log_id": cur.lastrowid, "model": model, "ms": ms, "result": clean})

    def wall_decisions(self, c, me):
        """Find walls reviews → training rows: every run the estimator kept (y=1)
        or dropped (y=0), with the features Find walls measured. Runs whose tag was
        simply skipped (not in scope) are not sent: they say nothing about wall-ness."""
        body = self.read_json()
        rows = body.get("rows") or []
        if not isinstance(rows, list) or len(rows) > 5000:
            raise ApiError(400, "Send up to 5000 reviewed runs at a time.")
        fv = int(body.get("feature_version") or 0)
        project = str(body.get("project") or "")[:120]
        sheet = str(body.get("sheet") or "")[:300]
        now = time.time()
        n = 0
        for r in rows:
            f, y = r.get("f"), r.get("y")
            if y not in (0, 1) or not isinstance(f, list) or len(f) > 200 or not all(isinstance(v, (int, float)) for v in f):
                continue
            pr = r.get("p")
            c.execute("INSERT INTO wall_decisions (user_id, project, sheet, feature_version, f, y, p, tag, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                      (me["id"], project, sheet, fv, json.dumps(f), y, float(pr) if isinstance(pr, (int, float)) else None, str(r.get("tag") or "")[:40] or None, now))
            n += 1
        status = wall_model_status(c)
        if status["since_train"] >= WALL_AUTO_TRAIN and not WALL_TRAINING.is_set():
            app = self.app
            upto = c.execute("SELECT MAX(id) FROM wall_decisions").fetchone()[0] or 0
            WALL_TRAINING.set()
            def bg():
                c2 = app.db()
                try:
                    # this request's rows commit as it returns: wait until they're visible
                    for _ in range(100):
                        if (c2.execute("SELECT MAX(id) FROM wall_decisions").fetchone()[0] or 0) >= upto:
                            break
                        time.sleep(0.05)
                    with c2:
                        train_wall_model(c2)
                except Exception:
                    pass                      # too few rows or one class only — the next batch tries again
                finally:
                    c2.close()
                    WALL_TRAINING.clear()
            threading.Thread(target=bg, daemon=True).start()
        return self.send_json(200, {"ok": True, "saved": n, **{k: status[k] for k in ("decisions", "since_train")}})

    def create_reset(self, c, user_id: int, cfg: dict) -> str:
        token = secrets.token_urlsafe(24)
        c.execute("DELETE FROM resets WHERE user_id=? OR expires_at<?", (user_id, time.time()))
        c.execute("INSERT INTO resets VALUES (?,?,?)", (token_hash(token), user_id, time.time() + RESET_HOURS * 3600))
        return f"{self.public_url(cfg)}/reset?token={token}"

    def mail_async(self, cfg: dict, to: str, subject: str, text: str, html: str):
        """Send after the response, so timing never reveals whether an account exists."""
        def go():
            try:
                send_mail(cfg, to, subject, text, html)
            except Exception as e:
                sys.stderr.write(f"[takeoff] couldn't email {to}: {e!r}\n")
        threading.Timer(0.2, go).start()

    def validate_account(self, body: dict, need_email: bool):
        name = str(body.get("name", "")).strip()[:80]
        email = str(body.get("email", "")).strip()
        pw = str(body.get("password", ""))
        if not name:
            raise ApiError(400, "Enter your name.")
        if need_email and not EMAIL_RE.match(email):
            raise ApiError(400, "Enter a valid email address.")
        if len(pw) < MIN_PASSWORD:
            raise ApiError(400, f"Use a password with at least {MIN_PASSWORD} characters.")
        return name, email, pw

    def put_pdf(self, c, pid: str, name: str):
        a = self.app
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise ApiError(400, "The file is empty.")
        if n > MAX_PDF:
            raise ApiError(413, "That file is too large.")
        tmp = a.blobs / f".upload-{secrets.token_hex(8)}"
        h = hashlib.sha256()
        try:
            with open(tmp, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(1024 * 1024, left))
                    if not chunk:
                        raise ApiError(400, "The upload was cut off — try again.")
                    f.write(chunk)
                    h.update(chunk)
                    left -= len(chunk)
            digest = h.hexdigest()
            dest = a.blob_path(digest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with a.write_lock:
                if not dest.exists():
                    os.replace(tmp, dest)
                existing = c.execute("SELECT * FROM pdfs WHERE project_id=? AND name=?", (pid, name)).fetchone()
                now = time.time()
                if not existing:
                    c.execute("INSERT INTO pdfs VALUES (?,?,?,?,?,?)", (pid, name, digest, 1, n, now))
                    out = {"name": name, "rev": 1, "hash": digest}
                elif existing["hash"] == digest:
                    out = {"name": name, "rev": existing["rev"], "unchanged": True, "hash": digest}
                else:
                    prev = existing["rev"]
                    c.execute("INSERT OR REPLACE INTO pdf_revs VALUES (?,?,?,?,?)", (pid, name, prev, existing["hash"], existing["ts"]))
                    c.execute("UPDATE pdfs SET hash=?, rev=?, size=?, ts=? WHERE project_id=? AND name=?", (digest, prev + 1, n, now, pid, name))
                    out = {"name": name, "rev": prev + 1, "prev_rev": prev, "revised": True, "hash": digest}
                self.touch(c, pid)
            return self.send_json(200, out)
        finally:
            if tmp.exists():
                tmp.unlink()

    def send_blob(self, digest: str):
        self._defer = False   # streaming read: nothing to commit, send now
        path = self.app.blob_path(digest)
        if not path.exists():
            raise ApiError(404, "The plan file is missing on the server.")
        etag = f'"{digest}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, max-age=0, must-revalidate")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    # ── static web app ────────────────────────────────────────────────────
    def serve_static(self, path: str):
        dist = self.app.dist
        if not dist:
            return self.send_json(404, {"error": "Not found"})
        rel = urllib.parse.unquote(path).lstrip("/")
        target = (dist / rel).resolve() if rel else dist / "index.html"
        if not str(target).startswith(str(dist.resolve())):
            return self.send_json(404, {"error": "Not found"})
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            # client-side routes fall back to the app; missing assets stay 404
            if "." in Path(rel).name:
                return self.send_json(404, {"error": "Not found"})
            target = dist / "index.html"
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            ctype = "application/javascript"
        elif target.suffix == ".wasm":
            ctype = "application/wasm"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # hashed build assets can be cached; the HTML shell must always revalidate
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vanguard Takeoff server")
    ap.add_argument("--dist", default="web/dist", help="built web app folder")
    ap.add_argument("--data", default="data", help="folder for the database and plan files")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8090)
    args = ap.parse_args(argv)
    data = Path(args.data).resolve()
    dist = Path(args.dist).resolve() if args.dist else None
    data.mkdir(parents=True, exist_ok=True)
    Handler.app = App(data, dist)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[takeoff] Vanguard Takeoff on http://{args.host}:{args.port}  (data: {data})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[takeoff] stopped", flush=True)


if __name__ == "__main__":
    main()
