# Vanguard Takeoff

Vanguard Drywall's takeoff and estimating app for commercial interior drywall
and ceilings. It runs entirely in the browser: open a PDF plan set, set the
scale, and measure wall types, ceilings, trims and counts, then export
quantities and a material order list to CSV, Excel or a marked-up PDF.

## Accounts and projects

When the app runs through `takeoff.py serve` (or the service), it has sign-in
and server-stored projects:

- **First visit:** create the admin account (one time).
- **Team page (admin):** invite people by email. Each invite is a one-time
  link (valid 7 days) you copy or email to them; they pick their own password.
  Admins can turn access off or make someone else an admin.
- **Projects page:** everyone signed in sees the company's projects. Create
  as many as you like; plans and takeoffs save to the server automatically, so
  work is kept between sessions and on any computer. A project can be deleted
  by its creator or an admin (it's kept in the database, so it can be recovered).
- **Templates, materials and stamps** are shared by the whole company.
- If two people edit the same project at once, the second save is refused
  with a "reload to get their changes" message, so no one overwrites anyone.

**Email (invites and password resets):** on the Team page, open *Email* and
enter the mailbox (the same one the DrywallApp uses works), or copy the
DrywallApp's settings in one step:

```bash
python3 takeoff.py email      # reads ~/DrywallApp/backend/.env
```

Then click *Send test email*. With email on, invites are emailed, the sign-in
page offers *Forgot your password?* (a reset link valid for 1 hour), and the
admin can send anyone a reset link. Without it, the same links are shown to
copy and send yourself.

Data lives in `data/` (database + plan files). Back it up with
`python3 takeoff.py backup`. Use HTTPS (a subdomain behind Caddy) before
inviting people: over plain http, passwords cross the network unencrypted.

Run it in the background and on boot (as root):

```bash
python3 takeoff.py service
```

## Drywall conditions

New projects start with a commercial interior set: partitions W1–W6, furring
F1, shaft wall SW1, ceilings C1–C4 (ACT and gypsum), bulkhead BH1, trims and
backing, access panels and door frames. Each carries a material list (studs,
track, board, screws, tape, compound, grid, tile, hanger wire, wall angle).
See [docs/DRYWALL_CONDITIONS.md](docs/DRYWALL_CONDITIONS.md) for every rate.

- **Walls:** use the Wall tool (S). Trace the wall line; height × length gives
  wall SF (one face), and the length is the LF used for studs and track.
- **Ceilings:** use the Area tool (A). The area's perimeter drives wall angle.
- **Trims/backing:** Linear tool (L). **Frames/panels:** Count tool (C).

The rates are starting points. Replace them with your own production numbers
in the condition's Materials editor, then save the condition to the Library
so new projects use your version.

## Quick start (on the server)

Requires **Node.js 24+**, npm and Python 3.9+.

```bash
git clone https://github.com/Ravello99/Takeoff.git /opt/vanguard
cd /opt/vanguard
python3 takeoff.py setup                      # install packages
python3 takeoff.py brand                      # apply logos + colors from brand.json
python3 takeoff.py build                      # build the site into web/dist
python3 takeoff.py serve                      # http://<server-ip>:8090
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
