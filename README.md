# Vanguard Takeoff

Vanguard Drywall's takeoff and estimating app for interior drywall and ceilings.
It runs entirely in the browser: open a PDF plan set, set the scale, and measure
areas, lengths and counts, then export to CSV, Excel or a marked-up PDF.

## Quick start (on the server)

Requires **Node.js 24+**, npm and Python 3.9+.

```bash
git clone https://github.com/Ravello99/Takeoff.git /opt/vanguard
cd /opt/vanguard
python3 takeoff.py setup                      # install packages
python3 takeoff.py brand                      # apply logos + colors from brand.json
python3 takeoff.py build                      # build the site into web/dist
python3 takeoff.py serve --port 8090          # quick test at http://<server-ip>:8090
```

For permanent hosting, either point your existing web server (nginx, Apache,
Caddy) at `web/dist/` with a fallback to `index.html`, or use Docker:

```bash
python3 takeoff.py docker
docker build -f Dockerfile.vanguard -t vanguard-takeoff .
docker run -d --restart unless-stopped -p 8090:80 vanguard-takeoff
```

## Branding

- `brand.json`: app name, company, colors and contact details.
- `brand/vanguard-logo.svg` and `brand/vanguard-logo.png`: the logo files
  (square PNG, 1024x1024). `takeoff.py brand` copies them into the app and
  resizes them for the icons.

Re-run `brand` and `build` after changing either.

## Where data is stored

Projects are saved in each user's browser (IndexedDB), not on the server.
Clearing browser data deletes them. Use **export project** for backups, or set
up the optional Google Drive / OneDrive sync before relying on it as a team.

## Licensing

This app is a modified version of OpenTakeoff, used under the Apache License
2.0 (last Apache release, tag `apache-2.0-final`). `LICENSE`, `NOTICE` and
`THIRD-PARTY-NOTICES.md` must stay in the repository, and the build publishes
them at `/licenses/`. `VANGUARD-CHANGES.md` lists what was changed.

**Do not merge newer upstream OpenTakeoff code.** Versions after that tag are
AGPL-3.0, which would require keeping their attribution visible and publishing
all of Vanguard's changes.
