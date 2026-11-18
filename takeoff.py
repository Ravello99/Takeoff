#!/usr/bin/env python3
"""
takeoff.py — set up, brand, build and host Vanguard Takeoff.

    python3 takeoff.py all              # install -> brand -> build -> serve
    python3 takeoff.py setup            # npm install for the web app
    python3 takeoff.py brand            # apply logos/colors from brand.json + brand/
    python3 takeoff.py build            # build the static site into web/dist
    python3 takeoff.py serve            # app + accounts server on port 8090
    python3 takeoff.py service          # run in the background and start on boot (as root)
    python3 takeoff.py domain takeoff.vanguarddrywall.ca   # HTTPS via the DrywallApp's Caddy
    python3 takeoff.py backup           # back up all projects and accounts
    python3 takeoff.py docker           # write Dockerfile.vanguard + nginx config

Requirements: Python 3.9+, Node.js 24+ and npm.  Optional: Pillow
(pip install pillow) to resize your logo into every favicon/icon size.

LICENSE COMPLIANCE (kept automatically, do not remove):
Apache-2.0 lets you modify, rebrand and sell this commercially, and it grants
no right to the "OpenTakeoff" name (which is why we replace it in the UI).
In return it requires that you (a) ship a copy of the license, (b) keep the
original copyright/attribution notices and any NOTICE file, and (c) mark files
you changed.  This script therefore:
  * never edits LICENSE / NOTICE files or copyright/SPDX header lines,
  * publishes them at /licenses/ in the built site (link it from your About
    screen — customers will never see "OpenTakeoff" in the normal UI),
  * writes VANGUARD-CHANGES.md listing every file it modified.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

# --------------------------------------------------------------------------
# Brand configuration.  Edit here or run `init-config` and edit brand.json.
# --------------------------------------------------------------------------
DEFAULT_BRAND = {
    "app_name": "Vanguard Takeoff",
    "short_name": "Vanguard",
    "company": "Vanguard Drywall & Acoustics",
    "tagline": "Interior drywall & ceiling takeoff",
    "website": "https://vanguarddrywall.ca",
    "support_email": "bids@vanguard.ca",
    # Match these to the colors used in the Vanguard mobile app.
    "colors": {
        "primary": "#0B2556",      # Vanguard navy (same as the DrywallApp)
        "accent": "#B4973A",       # Vanguard gold
        "background": "#FFFFFF",
        "text": "#1C2430",
    },
    # Paths to your logo files (relative to this script or absolute).
    "logo_svg": "brand/vanguard-logo.svg",     # used where the app has SVG logos
    "logo_png": "brand/vanguard-logo.png",     # square mark, 1024x1024
    "logo_wordmark": "brand/vanguard-wordmark.png",  # wide logo for the home screen
    "font_family": "",                          # e.g. "'Montserrat', sans-serif"
    # The app's own CSS color variables -> which brand color they should use.
    "css_vars": {"--cobalt": "primary", "--cobalt-deep": "primary"},
}

UPSTREAM_REPO = "https://github.com/Kentucky-ai/opentakeoff"
UPSTREAM_COMMIT = "84c7f48e458f6cd74f694e3a970dd011c73a8f2e"
HERE = Path(__file__).resolve().parent
APP_DIR = HERE            # the repository root holds the app source
CONFIG_PATH = HERE / "brand.json"

# Display names to replace.  Lowercase "opentakeoff" is deliberately NOT
# touched: it appears in npm package names, import paths and storage keys,
# and changing it would break the build or users' saved work.
# Case-sensitive on purpose: only human-facing spellings are matched.
NAME_PATTERNS = [
    re.compile(r"Open[ \-]?Takeoff"),
    re.compile(r"OPEN[ \-]?TAKEOFF"),
]
# Lines that reference code/packages are never rewritten.
CODE_LINE = re.compile(r"^\s*(import|export\s+\*|export\s+\{.*\}\s+from)\b|require\(|from\s+['\"]|github\.com|npmjs|https?://")
TEXT_EXTS = {".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
             ".css", ".scss", ".json", ".webmanifest", ".txt", ".xml"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", ".svelte-kit",
             "coverage", "mcp", "test", "tests", "__tests__", "docs", "benchmark"}
PROTECTED_FILES = re.compile(r"^(LICEN[CS]E|NOTICE|COPYING|AUTHORS)(\..*)?$", re.I)
PROTECTED_LINE = re.compile(r"copyright|licensed under|spdx-license|apache license", re.I)
ICON_NAME = re.compile(r"(favicon|logo|icon|apple-touch|og-image|social|brand)", re.I)
IMG_EXTS = {".png", ".ico", ".svg", ".jpg", ".jpeg", ".webp"}


# --------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[vanguard] {msg}", flush=True)


def run(cmd: list[str], cwd: Path | None = None) -> None:
    log("$ " + " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def load_brand() -> dict:
    brand = json.loads(json.dumps(DEFAULT_BRAND))
    if CONFIG_PATH.exists():
        user = json.loads(CONFIG_PATH.read_text())
        brand.update({k: v for k, v in user.items() if k not in {"colors", "css_vars"}})
        brand["colors"].update(user.get("colors", {}))
        brand["css_vars"].update(user.get("css_vars", {}))
    return brand


def find_web_root() -> Path:
    """Locate the package.json that owns the web app's `build` script."""
    candidates = []
    for pj in APP_DIR.rglob("package.json"):
        if any(p in SKIP_DIRS for p in pj.relative_to(APP_DIR).parts[:-1]):
            continue
        try:
            scripts = json.loads(pj.read_text()).get("scripts", {})
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if "build" in scripts:
            candidates.append(pj.parent)
    if not candidates:
        sys.exit("No package.json with a 'build' script found — run `setup` first.")
    # Prefer a folder named web/app/frontend, else the shallowest.
    candidates.sort(key=lambda p: (p.name not in {"web", "app", "frontend"},
                                   len(p.parts)))
    return candidates[0]


def find_dist(web_root: Path) -> Path:
    for name in ("dist", "build", "out", "public"):
        d = web_root / name
        if (d / "index.html").exists():
            return d
    sys.exit("No built index.html found — run `build` first.")


def resolve(path_str: str) -> Path | None:
    if not path_str:
        return None
    p = Path(path_str)
    p = p if p.is_absolute() else HERE / p
    return p if p.exists() else None


# --------------------------------------------------------------------------
# setup
# --------------------------------------------------------------------------
def cmd_setup(args) -> None:
    for tool in ("node", "npm"):
        if not shutil.which(tool):
            sys.exit(f"'{tool}' is not installed. Install Node.js 24+ (https://nodejs.org).")
    major = int(subprocess.check_output(["node", "-v"], text=True).strip().lstrip("v").split(".")[0])
    if major < 24:
        sys.exit(f"Node.js 24 or newer is required (found v{major}).")
    web_root = find_web_root()
    lock = (web_root / "package-lock.json").exists()
    run(["npm", "ci" if lock else "install"], cwd=web_root)


# --------------------------------------------------------------------------
# brand
# --------------------------------------------------------------------------
def replace_names(text: str, brand: dict) -> str:
    out_lines = []
    for line in text.splitlines(keepends=True):
        if PROTECTED_LINE.search(line) or CODE_LINE.search(line):
            out_lines.append(line)
            continue
        for pat in NAME_PATTERNS:
            line = pat.sub(brand["app_name"], line)
        out_lines.append(line)
    return "".join(out_lines)


def iter_source_files(web_root: Path):
    for path in web_root.rglob("*"):
        rel = path.relative_to(web_root).parts
        if any(p in SKIP_DIRS for p in rel[:-1]) or not path.is_file():
            continue
        if PROTECTED_FILES.match(path.name) or path.suffix.lower() == ".md":
            continue
        if path.name in {"package.json", "package-lock.json", "tsconfig.json"}:
            continue
        yield path


def replace_image(target: Path, brand: dict) -> bool:
    ext = target.suffix.lower()
    if ext == ".svg":
        src = resolve(brand["logo_svg"])
        if src:
            shutil.copyfile(src, target)
            return True
        return False
    src = resolve(brand["logo_png"])
    if not src:
        return False
    try:
        from PIL import Image
        with Image.open(target) as old:
            size = old.size
        with Image.open(src) as logo:
            logo = logo.convert("RGBA")
            logo.thumbnail(size, Image.LANCZOS)
            canvas = Image.new("RGBA", size, (0, 0, 0, 0))
            canvas.paste(logo, ((size[0] - logo.width) // 2, (size[1] - logo.height) // 2))
            if ext == ".ico":
                canvas.save(target, sizes=[(16, 16), (32, 32), (48, 48)])
            elif ext in {".jpg", ".jpeg"}:
                canvas.convert("RGB").save(target, quality=92)
            else:
                canvas.save(target)
        return True
    except ImportError:
        if ext == ".png":
            shutil.copyfile(src, target)   # browsers will scale it
            return True
        log(f"  Pillow not installed; left {target.name} unchanged")
        return False
    except Exception as exc:  # unreadable image etc.
        log(f"  could not replace {target.name}: {exc}")
        return False


def theme_css(brand: dict, var_names: set[str]) -> str:
    c = brand["colors"]
    lines = ["/* Vanguard Drywall theme — generated by takeoff.py brand */",
             "/* Light theme only; outranks the app's own :root rules regardless of load order */",
             'html:root:not([data-theme="dark"]) {',
             f"  --vg-primary: {c['primary']};", f"  --vg-accent: {c['accent']};",
             f"  --vg-bg: {c['background']};", f"  --vg-text: {c['text']};"]
    for v, which in brand.get("css_vars", {}).items():
        if which in c:
            lines.append(f"  {v}: {c[which]};")
    # Point any generically named color variables at Vanguard colors.
    for v in sorted(var_names - set(brand.get("css_vars", {}))):
        low = v.lower()
        if low.startswith("--vg-") or "contrast" in low:
            continue
        if any(k in low for k in ("primary", "brand")):
            lines.append(f"  {v}: {c['primary']};")
        elif "accent" in low or "highlight" in low:
            lines.append(f"  {v}: {c['accent']};")
    lines.append("}")
    # The wordmark has navy lettering: give it a light card in dark mode.
    lines.append(':root[data-theme="dark"] .vg-home-logo { background: #fff; '
                 'padding: 10px 16px; border-radius: 6px; }')
    if brand.get("font_family"):
        lines.append(f"body {{ font-family: {brand['font_family']}; }}")
    return "\n".join(lines) + "\n"


def cmd_brand(args) -> None:
    brand = load_brand()
    web_root = find_web_root()
    changed: list[str] = []
    css_vars: set[str] = set()
    missing_logo = not resolve(brand["logo_png"]) and not resolve(brand["logo_svg"])
    if missing_logo:
        log("WARNING: no logo found at brand.json paths — text/colors only this run.")

    for path in iter_source_files(web_root):
        ext = path.suffix.lower()
        rel = str(path.relative_to(APP_DIR))
        if ext in IMG_EXTS and ICON_NAME.search(path.name):
            if replace_image(path, brand):
                changed.append(rel)
            continue
        if ext not in TEXT_EXTS:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if ext in {".css", ".scss"}:
            css_vars.update(re.findall(r"(--[\w-]+)\s*:", text))
        new = replace_names(text, brand)
        if path.name in {"manifest.json", "site.webmanifest", "manifest.webmanifest"}:
            new = patch_manifest(new, brand)
        if ext in {".html", ".htm"}:
            new = patch_html(new, brand)
        if new != text:
            path.write_text(new, encoding="utf-8")
            changed.append(rel)

    public = web_root / "public"
    public.mkdir(exist_ok=True)
    # Logos used by the in-app mark (web/src/brand/marks.jsx).
    (public / "brand").mkdir(exist_ok=True)
    for key, name in (("logo_svg", "logo.svg"), ("logo_png", "logo.png"),
                      ("logo_wordmark", "wordmark.png")):
        src = resolve(brand.get(key, ""))
        if src:
            shutil.copyfile(src, public / "brand" / name)
            changed.append(f"web/public/brand/{name}")
    # Theme override stylesheet.
    (public / "vanguard-theme.css").write_text(theme_css(brand, css_vars))
    changed.append(str((public / "vanguard-theme.css").relative_to(APP_DIR)) + " (new)")

    write_change_log(changed, brand)
    log(f"Branding applied: {len(changed)} files changed (see VANGUARD-CHANGES.md).")


def patch_manifest(text: str, brand: dict) -> str:
    try:
        m = json.loads(text)
    except json.JSONDecodeError:
        return text
    m["name"] = brand["app_name"]
    m["short_name"] = brand["short_name"]
    m["description"] = brand["tagline"]
    m["theme_color"] = brand["colors"]["primary"]
    m["background_color"] = brand["colors"]["background"]
    return json.dumps(m, indent=2) + "\n"


def patch_html(text: str, brand: dict) -> str:
    text = re.sub(r"<title>.*?</title>", f"<title>{brand['app_name']}</title>",
                  text, count=1, flags=re.S | re.I)
    text = re.sub(r'(<meta\s+name="theme-color"\s+content=")[^"]*(")',
                  rf"\g<1>{brand['colors']['primary']}\g<2>", text, flags=re.I)
    text = re.sub(r'(<meta\s+name="description"\s+content=")[^"]*(")',
                  rf"\g<1>{brand['tagline']}\g<2>", text, flags=re.I)
    if "vanguard-theme.css" not in text and "</head>" in text:
        text = text.replace("</head>",
                            '  <link rel="stylesheet" href="/vanguard-theme.css">\n</head>', 1)
    return text


def write_change_log(changed: list[str], brand: dict) -> None:
    body = [
        f"# Modifications by {brand['company']}", "",
        f"{brand['app_name']} is a modified version of OpenTakeoff "
        f"({UPSTREAM_REPO}), used under the Apache License 2.0.",
        "The original LICENSE and NOTICE files are retained unchanged.", "",
        f"Upstream source: tag apache-2.0-final (commit {UPSTREAM_COMMIT}),",
        "the last Apache-2.0 release. Later upstream versions are AGPL-3.0 and are",
        "NOT used here; do not merge them into this repository.", "",
        "Manual changes: removed upstream analytics, Netlify forms, premium",
        "sign-up prompts, upstream privacy/terms pages and marketing files;",
        "replaced the logo marks, favicon, page title and static page.", "",
        "Files modified by takeoff.py brand:", "",
        *[f"- {c}" for c in sorted(set(changed))], "",
    ]
    path = APP_DIR / "VANGUARD-CHANGES.md"
    if path.exists():  # keep entries from earlier runs
        changed = changed + [l[2:] for l in path.read_text().splitlines() if l.startswith("- ")]
    body = [l for l in body if not l.startswith("- ")][:-1]
    body += [f"- {c}" for c in sorted(set(changed))] + [""]
    text = "\n".join(body)
    if not path.exists() or path.read_text() != text:   # no-op when nothing changed
        path.write_text(text)


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def cmd_build(args) -> None:
    web_root = find_web_root()
    run(["npm", "run", "build"], cwd=web_root)
    dist = find_dist(web_root)
    publish_licenses(dist, load_brand())
    log(f"Built site: {dist.relative_to(HERE)}")


def publish_licenses(dist: Path, brand: dict) -> None:
    """Ship the license + notices with the site (Apache-2.0 §4a, §4d)."""
    out = dist / "licenses"
    out.mkdir(exist_ok=True)
    items = []
    for f in APP_DIR.iterdir():
        if f.is_file() and (PROTECTED_FILES.match(f.name) or f.name == "VANGUARD-CHANGES.md"):
            shutil.copyfile(f, out / (f.name + ("" if f.suffix else ".txt")))
            items.append(f.name + ("" if f.suffix else ".txt"))
    links = "\n".join(f'<li><a href="{i}">{i}</a></li>' for i in sorted(items))
    (out / "index.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8">
<title>{brand['app_name']} — Open-source notices</title>
<link rel="stylesheet" href="/vanguard-theme.css"></head>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">
<h1>Open-source notices</h1>
<p>{brand['app_name']} by {brand['company']} includes software licensed under the
Apache License 2.0. The license and attribution notices are below.</p>
<ul>{links}</ul></body></html>
""")


# --------------------------------------------------------------------------
# serve (development / LAN hosting)
# --------------------------------------------------------------------------
class SPAHandler(http.server.SimpleHTTPRequestHandler):
    """Static server that falls back to index.html for client-side routes."""
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "application/javascript", ".mjs": "application/javascript",
                      ".wasm": "application/wasm", ".webmanifest": "application/manifest+json"}

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if not path.exists() and "." not in Path(self.path.split("?")[0]).name:
            self.path = "/index.html"
        return super().send_head()


def cmd_serve(args) -> None:
    """Run the Vanguard server: the web app + accounts + server-stored projects."""
    dist = find_dist(find_web_root())
    sys.path.insert(0, str(HERE / "backend"))
    import server as vserver
    data = Path(args.data).resolve() if getattr(args, "data", None) else HERE / "data"
    log(f"Projects and accounts are stored in {data} — back this folder up.")
    vserver.main(["--dist", str(dist), "--data", str(data), "--host", args.host, "--port", str(args.port)])


def cmd_service(args) -> None:
    """Install a systemd service so the app runs in the background and on boot."""
    if os.geteuid() != 0:
        sys.exit("Run this as root (sudo) to install the service.")
    find_dist(find_web_root())   # must be built first
    unit = f"""[Unit]
Description=Vanguard Takeoff
After=network.target

[Service]
WorkingDirectory={HERE}
ExecStart={sys.executable} {HERE / "takeoff.py"} serve --host {args.host} --port {args.port}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/vanguard-takeoff.service").write_text(unit)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "vanguard-takeoff"])
    run(["systemctl", "restart", "vanguard-takeoff"])
    log(f"Installed. It now runs in the background on port {args.port} and starts on boot.")
    log("  status: systemctl status vanguard-takeoff    logs: journalctl -u vanguard-takeoff -f")


def cmd_domain(args) -> None:
    """Serve the app at https://<domain> through the DrywallApp's Caddy."""
    import re
    import socket
    domain = args.name.strip().lower()
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", domain):
        sys.exit(f"'{args.name}' doesn't look like a domain name.")
    dwa = Path(args.drywallapp).expanduser() if args.drywallapp else None
    if not dwa:
        for cand in (Path.home() / "DrywallApp", Path("/root/DrywallApp"), Path("/opt/DrywallApp")):
            if (cand / "run.py").exists():
                dwa = cand
                break
    if not dwa or not (dwa / "run.py").exists():
        sys.exit("Couldn't find the DrywallApp folder. Pass it with --drywallapp /path/to/DrywallApp")
    try:
        ip = socket.gethostbyname(domain)
        log(f"{domain} points to {ip}.")
    except OSError:
        log(f"WARNING: {domain} doesn't resolve yet. Add the CNAME record first, then wait a few minutes.")
    block = (f"{domain} {{\n"
             f"\tencode gzip\n"
             f"\treverse_proxy 127.0.0.1:{args.port}\n"
             f"\theader Strict-Transport-Security \"max-age=31536000\"\n"
             f"}}\n")
    extra = dwa / ".data" / "extra-sites.caddy"
    extra.parent.mkdir(parents=True, exist_ok=True)
    text = extra.read_text() if extra.exists() else ""
    # replace an existing block for this domain, keep other sites
    text = re.sub(rf"(?ms)^# Vanguard Takeoff\n{re.escape(domain)} \{{.*?^\}}\n?", "", text).strip()
    text = (text + "\n\n" if text else "") + "# Vanguard Takeoff\n" + block
    extra.write_text(text)
    log(f"Wrote {extra}")
    log("Next, restart the DrywallApp so its Caddy picks this up:")
    log(f"  cd {dwa} && python3 run.py update")
    log(f"Then open https://{domain}. Once it works, keep plain http off the internet:")
    log(f"  cd {HERE} && python3 takeoff.py service --host 127.0.0.1")


def cmd_backup(args) -> None:
    """Copy the database (safely, even while running) and plan files to one archive."""
    import sqlite3
    import tarfile
    data = HERE / "data"
    if not (data / "takeoff.db").exists():
        sys.exit("No data yet — nothing to back up.")
    out_dir = Path(args.to).resolve() if args.to else HERE / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    snap = out_dir / f".takeoff-{stamp}.db"
    src = sqlite3.connect(data / "takeoff.db")
    dst = sqlite3.connect(snap)
    src.backup(dst)
    dst.close(); src.close()
    archive = out_dir / f"vanguard-takeoff-{stamp}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(snap, arcname="data/takeoff.db")
        if (data / "blobs").exists():
            tar.add(data / "blobs", arcname="data/blobs")
    snap.unlink()
    log(f"Backup written: {archive}")
    log("To restore: stop the service, extract it over /opt/vanguard, start the service.")


# --------------------------------------------------------------------------
# docker (production hosting)
# --------------------------------------------------------------------------
def cmd_docker(args) -> None:
    web_root = find_web_root()
    rel = web_root.relative_to(APP_DIR).as_posix()
    rel = "." if rel == "." else rel
    (APP_DIR / "Dockerfile.vanguard").write_text(f"""# Vanguard Takeoff — production image
FROM node:24-alpine AS build
WORKDIR /src
COPY . .
RUN cd {rel} && (npm ci || npm install) && npm run build
FROM nginx:alpine
COPY nginx.vanguard.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/{rel}/dist /usr/share/nginx/html
COPY LICENSE* NOTICE* VANGUARD-CHANGES.md /usr/share/nginx/html/licenses/
EXPOSE 80
""")
    (APP_DIR / "nginx.vanguard.conf").write_text("""server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  add_header X-Content-Type-Options nosniff;
  location / { try_files $uri $uri/ /index.html; }
  location ~* \\.(js|css|png|svg|ico|woff2?)$ { expires 30d; access_log off; }
}
""")
    log("Wrote Dockerfile.vanguard and nginx.vanguard.conf. Build and run with:")
    log("  docker build -f Dockerfile.vanguard -t vanguard-takeoff . "
        "&& docker run -d --restart unless-stopped -p 8090:80 vanguard-takeoff")


# --------------------------------------------------------------------------
def cmd_init_config(args) -> None:
    if CONFIG_PATH.exists() and not args.force:
        sys.exit("brand.json already exists (use --force to overwrite).")
    CONFIG_PATH.write_text(json.dumps(DEFAULT_BRAND, indent=2) + "\n")
    (HERE / "brand").mkdir(exist_ok=True)
    log("Wrote brand.json and brand/ — put vanguard-logo.svg and vanguard-logo.png in brand/.")


def cmd_all(args) -> None:
    cmd_setup(args)
    if not CONFIG_PATH.exists():
        cmd_init_config(argparse.Namespace(force=False))
    cmd_brand(args)
    cmd_build(args)
    cmd_serve(args)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in [("setup", cmd_setup), ("brand", cmd_brand), ("build", cmd_build),
                     ("serve", cmd_serve), ("service", cmd_service), ("domain", cmd_domain), ("backup", cmd_backup), ("docker", cmd_docker),
                     ("init-config", cmd_init_config), ("all", cmd_all)]:
        sp = sub.add_parser(name)
        sp.set_defaults(func=fn)
        if name == "domain":
            sp.add_argument("name", help="e.g. takeoff.vanguarddrywall.ca")
            sp.add_argument("--drywallapp", default="", help="DrywallApp folder (default: ~/DrywallApp)")
            sp.add_argument("--port", type=int, default=8090)
        if name == "backup":
            sp.add_argument("--to", default="", help="folder for the backup archive (default: ./backups)")
        if name in {"serve", "all", "service"}:
            sp.add_argument("--host", default="0.0.0.0",
                            help="use 0.0.0.0 to reach it from other devices on your network")
            # 8000 and 8081 are used by the DrywallApp (backend + Expo).
            sp.add_argument("--port", type=int, default=8090)
        if name == "init-config":
            sp.add_argument("--force", action="store_true")
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
