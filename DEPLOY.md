# Deploying voidshell

voidshell is now two things on one droplet: a static bundle and a small API
that holds the dashboards. They're split at the process boundary rather than
the hardware one, so moving the API to its own box later is a one-line change
to the proxy config.

```
                    ┌──────────────────────────────────────────┐
  :443 ─── Caddy ───┤ /        → /var/www/voidshell   (static) │
                    │ /api/*   → 127.0.0.1:3000       (proxy)  │
                    └──────────────────────────────────────────┘
                                        │
                              voidshell-api.service
                                        │
                            /var/lib/voidshell/db.json
```

The API binds **127.0.0.1 only**. It is never reachable except through the
proxy. Nothing about the API is exposed to the internet directly, which is why
the routes can assume TLS was terminated upstream.

## What you need

- A droplet — Ubuntu 24.04 LTS. 1 GB is enough **because the build happens in
  CI**, not on the box. If you intend to build by hand there, add swap first
  (below) or the OOM killer will pick your API mid-build.
- A domain, with an `A` record pointing at the droplet.
- An SSH key on the droplet.
- Caddy — reverse proxy with automatic HTTPS. (An nginx equivalent is in
  `deploy/nginx/voidshell.conf` if the box already runs nginx. Pick one.)

## One-time droplet setup

### 1. Swap, if you will ever build by hand

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2. Node, a service user, and somewhere for the data

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo adduser --system --group --no-create-home voidshell
sudo mkdir -p /var/lib/voidshell/backups /opt/voidshell/api /var/www/voidshell
sudo chown -R voidshell:voidshell /var/lib/voidshell
sudo chmod 700 /var/lib/voidshell
```

`db.json` holds every dashboard. It lives in `/var/lib`, owned by the service
user, mode 0600 — not in the repo, not under `/var/www`, and never anywhere the
static server could hand it out.

### 3. Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Edit `Caddyfile` — replace `example.com` — then:

```bash
scp Caddyfile root@DROPLET:/etc/caddy/Caddyfile
ssh root@DROPLET 'sudo systemctl reload caddy'
```

> The `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers in
> that file are **required**, not hardening. They're what grants
> `SharedArrayBuffer`, which is what lets the Python worker block on
> `Atomics.wait` for `input()`. Drop them and the shell still loads and scripts
> still run — but anything reading stdin reports that interactive input is
> unavailable, which reads as a broken terminal rather than a missing header.

### 4. The API service and the backup timer

```bash
scp deploy/systemd/*.service deploy/systemd/*.timer root@DROPLET:/etc/systemd/system/
scp deploy/backup.sh root@DROPLET:/opt/voidshell/backup.sh
ssh root@DROPLET '
  chmod +x /opt/voidshell/backup.sh
  systemctl daemon-reload
  systemctl enable --now voidshell-api
  systemctl enable --now voidshell-backup.timer
'
```

Check it:

```bash
ssh root@DROPLET 'curl -s localhost:3000/api/health'   # {"ok":true,"users":0}
ssh root@DROPLET 'systemctl list-timers voidshell-backup.timer'
```

### 5. Firewall and TLS

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Caddy gets certificates automatically on first request. (With nginx instead,
run `sudo certbot --nginx`.)

## Deploying

### From CI, which is the intended path

Push to `main`. `.github/workflows/deploy.yml` builds both packages, installs
production-only dependencies for the API, rsyncs everything up, restarts the
service, and polls `/api/health` until it answers — failing the deploy and
dumping the last 40 journal lines if it doesn't.

Three repository secrets:

| Secret | What |
|---|---|
| `DEPLOY_SSH_KEY` | private key with access to the droplet |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan YOUR_DROPLET` |
| `DEPLOY_TARGET` | `root@1.2.3.4` |

The deploy user needs passwordless `systemctl restart voidshell-api`.

`DEPLOY_KNOWN_HOSTS` is pinned rather than using
`StrictHostKeyChecking=no`, because a deploy that accepts any host key is a
deploy that hands its SSH key to whatever answers the DNS record.

### By hand

```bash
./deploy.sh root@YOUR_DROPLET_IP
```

Builds locally, syncs both halves, restarts the API. Fine for a one-off; CI is
better because it builds from a commit rather than from your working tree.

## Backups

`voidshell-backup.timer` copies `db.json` to
`/var/lib/voidshell/backups/db-YYYYMMDD.json` nightly at 03:30 and keeps 14.

Two details that matter more than they look:

- It **refuses to back up a file that isn't valid JSON**. Retention is a
  rolling window, so copying a corrupt database for fourteen nights is exactly
  how a working backup set turns into fourteen copies of the same broken file.
- `Persistent=true`, so a droplet that was off at 03:30 takes its backup on the
  next boot instead of silently skipping the night.

Restoring:

```bash
sudo systemctl stop voidshell-api
sudo -u voidshell cp /var/lib/voidshell/backups/db-20260729.json /var/lib/voidshell/db.json
sudo systemctl start voidshell-api
```

Stop the service first. The API holds the whole database in memory and writes
it out whole, so a restore underneath a running process is overwritten by the
next save.

## Things that will bite

**The API entrypoint is `dist/server.js`, not `dist/index.js`.** `index.js`
exports `build()` and starts nothing — the split is what stops a test from
booting a listener against the production database. Point systemd at the wrong
one and you get a process that starts and exits with no error.

**Order the proxy rule before the static fallback.** Reversed, `/api/*` gets
answered with `index.html`, and the client reports "not signed in" — a 200 full
of HTML parses as neither a session nor an error.

**Losing `db.json` loses every dashboard permanently.** Keys are stored as
hashes and are unrecoverable by design; there is no reset-password path to fall
back on. That is the whole reason the backup timer exists.
