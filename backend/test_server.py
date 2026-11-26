"""End-to-end tests for backend/server.py (standard library only).

    python3 -m unittest backend/test_server.py -v
"""
import hashlib
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import server  # noqa: E402


class Client:
    def __init__(self, port):
        self.port = port
        self.cookie = None

    def req(self, method, path, body=None, raw=None, headers=None, csrf=True):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if csrf and method != "GET":
            h["X-Vanguard"] = "1"
        if self.cookie:
            h["Cookie"] = self.cookie
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        payload = r.read()
        sc = r.getheader("Set-Cookie")
        if sc:
            val = sc.split(";")[0]
            self.cookie = None if val.endswith("=") else val
        ctype = r.getheader("Content-Type") or ""
        out = json.loads(payload) if ctype.startswith("application/json") and payload else payload
        c.close()
        return r.status, out, r


class ServerTest(unittest.TestCase):
    def setUp(self):
        cls = self
        cls.tmp = tempfile.TemporaryDirectory()
        dist = Path(cls.tmp.name) / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>app</title>")
        (dist / "assets" / "app.js").write_text("console.log(1)")
        server.Handler.app = server.App(Path(cls.tmp.name) / "data", dist)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def test_full_flow(self):
        admin = Client(self.port)
        s, out, _ = admin.req("GET", "/api/status")
        self.assertEqual((s, out["setup_needed"], out["user"]), (200, True, None))

        # setup: validation, then admin created and signed in
        s, out, _ = admin.req("POST", "/api/setup", {"name": "Al", "email": "al@v.ca", "password": "short"})
        self.assertEqual(s, 400)
        s, out, _ = admin.req("POST", "/api/setup", {"name": "Al Admin", "email": "al@v.ca", "password": "correct horse"})
        self.assertEqual((s, out["user"]["role"]), (200, "admin"))
        self.assertIsNotNone(admin.cookie)
        # setup cannot run twice
        s, _, _ = Client(self.port).req("POST", "/api/setup", {"name": "X", "email": "x@v.ca", "password": "12345678"})
        self.assertEqual(s, 409)

        # CSRF guard: a write without the header is refused
        s, _, _ = admin.req("POST", "/api/projects", {"name": "X"}, csrf=False)
        self.assertEqual(s, 403)

        # invite a user; anonymous can read invite, accept it
        s, inv, _ = admin.req("POST", "/api/invites", {"email": "bob@v.ca"})
        self.assertEqual(s, 200)
        token = inv["path"].split("token=")[1]
        s, invs, _ = admin.req("GET", "/api/invites")
        self.assertEqual(len(invs["invites"]), 1)
        bob = Client(self.port)
        s, out, _ = bob.req("GET", f"/api/invites/{token}")
        self.assertEqual((s, out["email"]), (200, "bob@v.ca"))
        s, out, _ = bob.req("POST", f"/api/invites/{token}/accept", {"name": "Bob", "password": "bobpassword"})
        self.assertEqual((s, out["user"]["role"]), (200, "user"))
        # one-time link
        s, _, _ = Client(self.port).req("POST", f"/api/invites/{token}/accept", {"name": "Eve", "password": "evepassword"})
        self.assertEqual(s, 404)

        # non-admin cannot invite or list users
        self.assertEqual(bob.req("POST", "/api/invites", {"email": "c@v.ca"})[0], 403)
        self.assertEqual(bob.req("GET", "/api/users")[0], 403)
        # anonymous cannot list projects
        self.assertEqual(Client(self.port).req("GET", "/api/projects")[0], 401)

        # login / wrong password / lockout
        anon = Client(self.port)
        self.assertEqual(anon.req("POST", "/api/login", {"email": "bob@v.ca", "password": "nope"})[0], 401)
        s, out, _ = anon.req("POST", "/api/login", {"email": "BOB@v.ca", "password": "bobpassword"})
        self.assertEqual((s, out["user"]["name"]), (200, "Bob"))

        # projects
        s, p1, _ = bob.req("POST", "/api/projects", {"name": "Niagara Outlet — Boss"})
        self.assertEqual(s, 200)
        pid = p1["id"]
        s, out, _ = admin.req("GET", "/api/projects")
        self.assertEqual([p["name"] for p in out["projects"]], ["Niagara Outlet — Boss"])
        self.assertTrue(out["projects"][0]["can_delete"])   # admin can delete anyone's

        # takeoff data with optimistic version check
        s, ann, _ = bob.req("GET", f"/api/projects/{pid}/annotations")
        self.assertEqual((ann["version"], ann["payload"]), (0, None))
        s, out, _ = bob.req("PUT", f"/api/projects/{pid}/annotations", {"version": 0, "payload": {"shapes": [1]}})
        self.assertEqual((s, out["version"]), (200, 1))
        s, out, _ = admin.req("PUT", f"/api/projects/{pid}/annotations", {"version": 0, "payload": {"shapes": []}})
        self.assertEqual(s, 409)   # stale writer is refused
        s, ann, _ = admin.req("GET", f"/api/projects/{pid}/annotations")
        self.assertEqual((ann["version"], ann["payload"]["shapes"]), (1, [1]))

        # plan upload, dedupe, revisions, ETag caching, delete + blob GC
        pdf1, pdf2 = b"%PDF-1.4 one", b"%PDF-1.4 two"
        name = "A-101 Floor Plan.pdf"
        path = f"/api/projects/{pid}/pdfs/" + "A-101%20Floor%20Plan.pdf"
        s, out, _ = bob.req("PUT", path, raw=pdf1)
        self.assertEqual((s, out["rev"]), (200, 1))
        s, out, _ = bob.req("PUT", path, raw=pdf1)
        self.assertTrue(out["unchanged"])
        s, out, _ = bob.req("PUT", path, raw=pdf2)
        self.assertEqual((out["rev"], out["prev_rev"], out["revised"]), (2, 1, True))
        s, lst, _ = bob.req("GET", f"/api/projects/{pid}/pdfs")
        self.assertEqual([(x["name"], x["rev"]) for x in lst["pdfs"]], [(name, 2)])
        s, body, r = bob.req("GET", path)
        self.assertEqual((s, body), (200, pdf2))
        etag = r.getheader("ETag")
        s, _, _ = bob.req("GET", path, headers={"If-None-Match": etag})
        self.assertEqual(s, 304)
        s, revs, _ = bob.req("GET", path + "/revs")
        self.assertEqual([x["rev"] for x in revs["revs"]], [1])
        s, body, _ = bob.req("GET", path + "/revs/1")
        self.assertEqual(body, pdf1)
        blob = server.Handler.app.blob_path(hashlib.sha256(pdf1).hexdigest())
        self.assertTrue(blob.exists())
        self.assertEqual(bob.req("DELETE", path)[0], 200)
        self.assertFalse(blob.exists())   # no longer referenced → removed

        # company library
        self.assertEqual(bob.req("PUT", "/api/library/templates", {"value": [{"finish_tag": "W1"}]})[0], 200)
        s, out, _ = admin.req("GET", "/api/library/templates")
        self.assertEqual(out["value"], [{"finish_tag": "W1"}])
        self.assertEqual(admin.req("PUT", "/api/library/../etc", {"value": 1})[0], 404)

        # delete rights: another user's project needs creator or admin
        s, p2, _ = admin.req("POST", "/api/projects", {"name": "Admin job"})
        self.assertEqual(bob.req("DELETE", f"/api/projects/{p2['id']}")[0], 403)
        self.assertEqual(bob.req("DELETE", f"/api/projects/{pid}")[0], 200)
        self.assertEqual(bob.req("GET", f"/api/projects/{pid}/annotations")[0], 404)

        # admin turns Bob off → his session stops working
        s, users, _ = admin.req("GET", "/api/users")
        bob_id = [u["id"] for u in users["users"] if u["email"] == "bob@v.ca"][0]
        self.assertEqual(admin.req("PATCH", f"/api/users/{bob_id}", {"active": False})[0], 200)
        self.assertEqual(bob.req("GET", "/api/projects")[0], 401)
        # the last admin can't be removed
        admin_id = [u["id"] for u in users["users"] if u["role"] == "admin"][0]
        self.assertEqual(admin.req("PATCH", f"/api/users/{admin_id}", {"role": "user"})[0], 400)

        # password change, logout
        self.assertEqual(admin.req("POST", "/api/account/password", {"current": "wrong", "new": "newpassword1"})[0], 400)
        self.assertEqual(admin.req("POST", "/api/account/password", {"current": "correct horse", "new": "newpassword1"})[0], 200)
        self.assertEqual(admin.req("POST", "/api/logout")[0], 200)
        self.assertEqual(admin.req("GET", "/api/me")[0], 401)

    def test_email_flows(self):
        sent = []
        real = server.send_mail
        server.send_mail = lambda cfg, to, subject, text, html=None: sent.append({"to": to, "subject": subject, "text": text, "cfg": cfg})
        try:
            admin = Client(self.port)
            admin.req("POST", "/api/setup", {"name": "Al Admin", "email": "mail-admin@v.ca", "password": "correct horse"})
            email = "mail-admin@v.ca"
            self.assertFalse(admin.req("GET", "/api/status")[1]["email_enabled"])
            # invite without email configured → link only
            s, out, _ = admin.req("POST", "/api/invites", {"email": "early@v.ca"})
            self.assertEqual((s, out["emailed"]), (200, False))
            # configure SMTP; password never comes back
            s, out, _ = admin.req("PUT", "/api/settings/email", {"smtp_host": "mail.v.ca", "smtp_port": "465", "smtp_user": "noreply@v.ca",
                                                                  "smtp_password": "secret", "smtp_from": "Vanguard <noreply@v.ca>", "public_url": "https://takeoff.v.ca/"})
            self.assertTrue(out["configured"])
            s, cfg, _ = admin.req("GET", "/api/settings/email")
            self.assertTrue(cfg["has_password"])
            self.assertNotIn("smtp_password", cfg)
            admin.req("PUT", "/api/settings/email", {"smtp_password": ""})   # blank keeps it
            self.assertTrue(admin.req("GET", "/api/settings/email")[1]["has_password"])
            self.assertEqual(admin.req("PUT", "/api/settings/email", {"smtp_port": "abc"})[0], 400)
            self.assertEqual(admin.req("POST", "/api/settings/email/test")[0], 200)
            self.assertEqual((sent[-1]["to"], sent[-1]["subject"]), (email, "Vanguard Takeoff test email"))
            self.assertTrue(admin.req("GET", "/api/status")[1]["email_enabled"])
            # invite is emailed with the public URL
            s, out, _ = admin.req("POST", "/api/invites", {"email": "carl@v.ca"})
            self.assertTrue(out["emailed"])
            self.assertEqual(sent[-1]["to"], "carl@v.ca")
            self.assertIn("https://takeoff.v.ca/invite?token=", sent[-1]["text"])
            token = sent[-1]["text"].split("invite?token=")[1].split()[0]
            carl = Client(self.port)
            self.assertEqual(carl.req("POST", f"/api/invites/{token}/accept", {"name": "Carl", "password": "carlpassword"})[0], 200)
            # forgot password: same answer for unknown emails, mail only for real ones
            n = len(sent)
            anon = Client(self.port)
            self.assertEqual(anon.req("POST", "/api/password/forgot", {"email": "nobody@v.ca"})[0], 200)
            self.assertEqual(anon.req("POST", "/api/password/forgot", {"email": "carl@v.ca"})[0], 200)
            import time as _t; _t.sleep(0.6)   # mail goes out just after the response
            self.assertEqual(len(sent), n + 1)
            self.assertEqual(sent[-1]["to"], "carl@v.ca")
            reset = sent[-1]["text"].split("reset?token=")[1].split()[0]
            self.assertEqual(anon.req("GET", f"/api/password/reset/{reset}")[1]["email"], "carl@v.ca")
            self.assertEqual(anon.req("POST", f"/api/password/reset/{reset}", {"password": "short"})[0], 400)
            s, out, _ = anon.req("POST", f"/api/password/reset/{reset}", {"password": "brand new pass"})
            self.assertEqual((s, out["user"]["email"]), (200, "carl@v.ca"))
            self.assertEqual(carl.req("GET", "/api/me")[0], 401)          # old session signed out
            self.assertEqual(anon.req("GET", "/api/me")[0], 200)           # new one works
            self.assertEqual(Client(self.port).req("POST", f"/api/password/reset/{reset}", {"password": "again again"})[0], 404)  # one-time
            # admin-triggered reset, and a mail failure is reported, not fatal
            users = admin.req("GET", "/api/users")[1]["users"]
            carl_id = [u["id"] for u in users if u["email"] == "carl@v.ca"][0]
            s, out, _ = admin.req("POST", f"/api/users/{carl_id}/reset")
            self.assertTrue(out["emailed"] and "/reset?token=" in out["url"])
            def boom(*a, **k): raise OSError("connection refused")
            server.send_mail = boom
            s, out, _ = admin.req("POST", "/api/invites", {"email": "dana@v.ca"})
            self.assertEqual((s, out["emailed"]), (200, False))
            self.assertIn("connection refused", out["email_error"])
            self.assertEqual(admin.req("POST", "/api/settings/email/test")[0], 400)
            # non-admins can't see or change mail settings
            self.assertEqual(anon.req("GET", "/api/settings/email")[0], 403)
        finally:
            server.send_mail = real

    def test_ai_runpod_serverless(self):
        # a stand-in for RunPod Serverless: jobs go in at /run and are polled at /status
        from http.server import BaseHTTPRequestHandler
        seen = {"polls": 0}
        class Fake(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _send(self, obj, code=200):
                b = json.dumps(obj).encode()
                self.send_response(code); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                if self.path == "/v2/ep1/run":
                    seen["job"] = body; seen["auth"] = self.headers.get("Authorization"); seen["polls"] = 0
                    return self._send({"id": "job-1", "status": "IN_QUEUE"})
                self._send({}, 404)
            def do_GET(self):
                if self.path == "/v2/ep1/status/job-1":
                    seen["polls"] += 1
                    if seen["polls"] < 2:                     # still cold-starting
                        return self._send({"id": "job-1", "status": "IN_PROGRESS"})
                    route = seen["job"]["input"]["openai_route"]
                    out = {"data": [{"id": "Qwen/Qwen3-VL-8B-Instruct"}]} if route == "/v1/models" else \
                          {"choices": [{"message": {"content": '[{"tag": "WP-1", "stud_size": "3-5/8\\"", "stud_oc": 16}]'}}]}
                    return self._send({"id": "job-1", "status": "COMPLETED", "output": [out]})
                self._send({}, 404)
        fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        admin = Client(self.port)
        admin.req("POST", "/api/setup", {"name": "A", "email": "rp@v.ca", "password": "correct horse"})
        base = f"http://127.0.0.1:{fake.server_address[1]}/v2/ep1/openai/v1"
        self.assertEqual(admin.req("PUT", "/api/settings/ai", {"ai_base_url": base, "ai_api_key": "rp-key", "ai_model": "Qwen/Qwen3-VL-8B-Instruct"})[0], 200)
        s, out, _ = admin.req("POST", "/api/settings/ai/test")
        self.assertEqual((s, out["models"]), (200, ["Qwen/Qwen3-VL-8B-Instruct"]))
        self.assertEqual(seen["job"]["input"]["openai_route"], "/v1/models")
        self.assertEqual(seen["auth"], "Bearer rp-key")
        s, out, _ = admin.req("POST", "/api/ai/read-schedule", {"text": "WALL SCHEDULE\nWP-1\n5/8 GYPSUM BOARD EACH SIDE", "source": "A2.0"})
        self.assertEqual((s, out["walls"][0]["tag"]), (200, "WP-1"))
        job = seen["job"]["input"]
        self.assertEqual(job["openai_route"], "/v1/chat/completions")
        self.assertEqual(job["openai_input"]["model"], "Qwen/Qwen3-VL-8B-Instruct")
        self.assertIn("5/8 GYPSUM BOARD", job["openai_input"]["messages"][0]["content"])
        self.assertGreaterEqual(seen["polls"], 2)

    def test_ai_flow(self):
        # a stand-in for vLLM's OpenAI-compatible server
        import base64
        from http.server import BaseHTTPRequestHandler
        seen = {}
        class Fake(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _send(self, obj):
                b = json.dumps(obj).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            def do_GET(self):
                seen["auth"] = self.headers.get("Authorization")
                self._send({"data": [{"id": "Qwen/Qwen3.5-9B", "max_model_len": 8128}]})
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen["body"] = body
                reply = seen.get("reply", '```json\n[{"tag": "1A", "stud_size": "3-5/8\\"", "stud_gauge": "20ga", "stud_oc": 16, "layers_per_side": 1, "sides": 2, "height": "to deck"}]\n```')
                self._send({"choices": [{"message": {"content": reply}}]})
        fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        try:
            admin = Client(self.port)
            admin.req("POST", "/api/setup", {"name": "A", "email": "ai@v.ca", "password": "correct horse"})
            img = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake image").decode()
            # not configured yet → clear message
            s, out, _ = admin.req("POST", "/api/ai/read-schedule", {"image": img})
            self.assertEqual(s, 400)
            self.assertFalse(admin.req("GET", "/api/status")[1]["ai_enabled"])
            self.assertEqual(admin.req("PUT", "/api/settings/ai", {"ai_base_url": "ftp://x"})[0], 400)
            base = f"http://127.0.0.1:{fake.server_address[1]}/v1"
            self.assertEqual(admin.req("PUT", "/api/settings/ai", {"ai_base_url": base, "ai_api_key": "k-secret"})[0], 200)
            s, cfg, _ = admin.req("GET", "/api/settings/ai")
            self.assertTrue(cfg["has_key"] and "ai_api_key" not in cfg)
            s, out, _ = admin.req("POST", "/api/settings/ai/test")
            self.assertEqual((s, out["models"]), (200, ["Qwen/Qwen3.5-9B"]))
            self.assertEqual(seen["auth"], "Bearer k-secret")   # key stays server-side
            self.assertTrue(admin.req("GET", "/api/status")[1]["ai_enabled"])
            # read a schedule: fenced JSON is parsed, image + answer logged
            s, out, _ = admin.req("POST", "/api/ai/read-schedule", {"image": img, "hint": "all walls to deck"})
            self.assertEqual((s, out["walls"][0]["tag"], out["model"]), (200, "1A", "Qwen/Qwen3.5-9B"))
            sent = seen["body"]["messages"][0]["content"]
            self.assertEqual(sent[0]["image_url"]["url"], img)
            self.assertIn("all walls to deck", sent[1]["text"])
            self.assertTrue(server.Handler.app.blob_path(hashlib.sha256(b"\x89PNG fake image").hexdigest()).exists())
            # corrections recorded against the result
            self.assertEqual(admin.req("POST", "/api/ai/feedback", {"log_id": out["log_id"], "final": [{"tag": "1A", "stud_gauge": "25ga"}]})[0], 200)
            # a bad answer is reported and still logged
            seen["reply"] = "Sorry, I can't read that."
            s, bad, _ = admin.req("POST", "/api/ai/read-schedule", {"image": img})
            self.assertEqual((s, bad["walls"]), (200, []))
            self.assertIn("not with a list", bad["error"])
            s, log, _ = admin.req("GET", "/api/ai/log")
            self.assertEqual((log["total"], log["reviewed"]), (2, 1))  # (before the text read below)
            # the schedule as text (found in the project's drawings): sent as plain text
            seen["reply"] = '[{"tag": "P1", "stud_size": "92mm", "stud_oc": 16}]'
            s, out, _ = admin.req("POST", "/api/ai/read-schedule", {"text": "INTERIOR PARTITION\nP1\n· 16mm GYPSUM WALL BOARD", "source": "A002 p3"})
            self.assertEqual((s, out["walls"][0]["tag"]), (200, "P1"))
            sent = seen["body"]["messages"][0]["content"]
            self.assertIsInstance(sent, str)
            self.assertEqual(seen["body"]["chat_template_kwargs"], {"enable_thinking": False})
            self.assertLess(seen["body"]["max_tokens"], 8128)          # sized to fit the served context window
            self.assertGreater(seen["body"]["max_tokens"], 4000)
            self.assertIn("16mm GYPSUM WALL BOARD", sent)
            self.assertIn("from A002 p3", sent)
            # scope notes → JSON object (fenced, with chatter) normalised
            seen["reply"] = 'Here you go:\n```json\n{"existing_walls_in_scope": "no", "reason": "Existing walls to remain, no work.", "notes": [{"mark": "4", "text": "Fur out existing wall", "action": "fur_existing", "rooms": ["EXAM 7"], "wall_type": "F1"}], "legend": [{"label": "EXISTING WALL TO REMAIN", "meaning": "existing_wall"}, {"label": "DOOR TAG", "meaning": "door_tag", "prefix": "D"}]}\n```'
            s, out, _ = admin.req("POST", "/api/ai/read-notes", {"text": "KEYNOTES\n4. FUR OUT EXISTING WALL W/ 1-5/8\" STUDS", "source": "A101"})
            self.assertEqual(s, 200)
            self.assertEqual(out["result"]["existing_walls_in_scope"], "no")
            self.assertEqual(out["result"]["notes"][0]["mark"], "4")
            self.assertEqual(out["result"]["notes"][0]["rooms"], ["EXAM 7"])
            self.assertEqual([e["meaning"] for e in out["result"]["legend"]], ["existing_wall", "door_tag"])
            self.assertEqual(out["result"]["legend"][1]["prefix"], "D")
            self.assertEqual(admin.req("POST", "/api/ai/read-notes", {"text": "x"})[0], 400)
            # plan tags → assemblies: unknown ids are refused
            seen["reply"] = '{"WP-2": "cnd_w2", "D2": null, "WP-9": "cnd_made_up"}'
            s, out, _ = admin.req("POST", "/api/ai/map-tags", {"tags": [{"tag": "WP-2", "thick_in": 4.9}, {"tag": "D2"}, {"tag": "WP-9"}],
                                                              "assemblies": [{"id": "cnd_w2", "tag": "W2", "desc": "3-5/8 studs acoustic"}]})
            self.assertEqual(out["map"], {"WP-2": "cnd_w2", "D2": None, "WP-9": None})
            # vision review of run tiles
            seen["reply"] = '[{"n": 1, "wall": false, "status": "unknown", "confidence": 0.9, "why": "counter"}, {"n": 2, "wall": true, "status": "existing", "tag": "WP-2", "confidence": 0.7}, {"n": 9, "wall": true}]'
            s, out, _ = admin.req("POST", "/api/ai/review-runs", {"image": img, "count": 2, "legend": "existing walls screened"})
            self.assertEqual(s, 200)
            self.assertEqual([(v["n"], v["wall"], v["status"]) for v in out["verdicts"]], [(1, False, "unknown"), (2, True, "existing")])
            sent = seen["body"]["messages"][0]["content"]
            self.assertEqual(sent[0]["image_url"]["url"], img)
            self.assertIn("existing walls screened", sent[1]["text"])
            # wrong image type refused
            self.assertEqual(admin.req("POST", "/api/ai/read-schedule", {"image": "data:text/plain;base64,aGk="})[0], 400)
        finally:
            fake.shutdown(); fake.server_close()

    def test_wall_model(self):
        import random as _r
        admin = Client(self.port)
        admin.req("POST", "/api/setup", {"name": "A", "email": "wm@v.ca", "password": "correct horse"})
        s, st, _ = admin.req("GET", "/api/ai/walls/model")
        self.assertEqual((s, st["model"], st["decisions"]), (200, None, 0))
        # too little to learn from → a clear refusal
        self.assertEqual(admin.req("POST", "/api/ai/walls/train")[0], 400)
        # reviews from 6 sheets: thin, unhatched, untagged runs are dropped; tagged hatched ones kept
        rng = _r.Random(3)
        for sh in range(6):
            rows = []
            for _ in range(60):
                y = rng.random() < 0.7
                f = [rng.uniform(4, 8) if y else rng.uniform(2, 3), rng.uniform(1, 3), 0, 1, 1, 0.5, rng.uniform(2, 9) if y else 0,
                     1 if y else 0, 0, 0, 0, 0 if y else 1, 2 if y else 0, 0 if y else 2, 0, rng.random(), rng.random(), 0, 0, 0.3]
                rows.append({"f": f, "y": int(y), "tag": "P1" if y else None})
            rows.append({"f": ["bad"], "y": 1})          # junk rows are skipped
            s, out, _ = admin.req("POST", "/api/ai/walls/decisions", {"sheet": f"A20{sh}", "project": "p1", "feature_version": 1, "rows": rows})
            self.assertEqual((s, out["saved"]), (200, 60))
        import time as _t
        for _ in range(100):                               # 360 reviews ≥ 300 → trains on its own
            st = admin.req("GET", "/api/ai/walls/model")[1]
            if st["model"] and not st["training"]:
                break
            _t.sleep(0.1)
        self.assertIsNotNone(st["model"])
        self.assertEqual(st["model"]["format"], "gbdt-v1")
        self.assertGreater(st["model"]["metrics"]["accuracy"], 0.9)
        # manual retrain (admin) learns from everything so far
        s, out, _ = admin.req("POST", "/api/ai/walls/train")
        self.assertEqual(s, 200)
        self.assertIn("auc", out["metrics"])
        self.assertEqual(admin.req("GET", "/api/ai/walls/model")[1]["since_train"], 0)
        self.assertEqual(admin.req("POST", "/api/ai/walls/decisions", {"rows": [{}] * 5001})[0], 400)

    def test_lockout(self):
        c = Client(self.port)
        for _ in range(5):
            c.req("POST", "/api/login", {"email": "nobody@v.ca", "password": "x"})
        self.assertEqual(c.req("POST", "/api/login", {"email": "nobody@v.ca", "password": "x"})[0], 429)

    def test_static(self):
        c = Client(self.port)
        s, body, r = c.req("GET", "/projects/some/route")
        self.assertEqual(s, 200)
        self.assertIn(b"<title>app</title>", body)
        s, body, r = c.req("GET", "/assets/app.js")
        self.assertEqual((s, r.getheader("Content-Type")), (200, "application/javascript"))
        self.assertEqual(c.req("GET", "/assets/missing.js")[0], 404)
        self.assertEqual(c.req("GET", "/../../etc/passwd")[0] in (200, 404), True)


if __name__ == "__main__":
    unittest.main()
