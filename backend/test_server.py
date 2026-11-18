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
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        dist = Path(cls.tmp.name) / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><title>app</title>")
        (dist / "assets" / "app.js").write_text("console.log(1)")
        server.Handler.app = server.App(Path(cls.tmp.name) / "data", dist)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

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
