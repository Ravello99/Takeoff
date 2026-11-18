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
import sqlite3
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SESSION_DAYS = 30
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
        with self.db() as c:
            c.executescript(SCHEMA)

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
            return self.send_json(200, {"server": True, "setup_needed": n == 0, "user": user_json(u) if u else None})

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
            return self.send_json(200, {"email": email, "role": role, "path": f"/invite?token={token}", "expires_days": INVITE_DAYS})
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
