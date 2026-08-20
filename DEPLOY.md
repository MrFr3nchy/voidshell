# Deploying voidshell

voidshell is two things on one droplet: a static bundle and a small API that
holds the dashboards. They're split at the process boundary rather than the
hardware one, so moving the API to its own box later is a one-line change to
the proxy config.

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
proxy, which is why the routes can assume TLS was terminated upstream.

---

## The short version

```bash
npm install

npx voidshell config domain voidshell.example
npx voidshell setup root@YOUR_DROPLET_IP
npx voidshell deploy
```

That's a live deployment. `setup` is idempotent — re-run it any time you change
a unit file or the Caddyfile.

Run `npx voidshell` for the command list, or `npx voidshell <command> --help`
for any one of them.

| | |
|---|---|
| `voidshell dev` | run both halves locally |
| `voidshell doctor` | check everything a deploy depends on |
| `voidshell setup` | provision a droplet (idempotent) |
| `voidshell deploy` | build, ship, restart, verify |
| `voidshell status` | services, dashboards, backups, disk |
| `voidshell logs` | tail the journal |
| `voidshell backup` | back up now, list what's kept |
| `voidshell restore` | replace the live database |
| `voidshell key` | store the model API key on the droplet |
| `voidshell config` | show or set saved defaults |

Settings live in `.voidshell.json` beside the repo (gitignored), so the target
is typed once. Any command still takes an explicit `user@host` to override it.

---

## Working locally

```bash
npx voidshell dev
```

Starts the API on `:3000` against a throwaway database in `.voidshell-dev/`,
and Vite on `:5173` proxying `/api` to it. One Ctrl-C stops both.

Same-origin in dev as in production, deliberately: the session cookie is
`SameSite=Strict`, so pointing the client at `localhost:3000` directly would
work right up until the cookie didn't.

`--fresh` starts from an empty database. `--api-only` skips Vite.

---

## What you need

- A droplet — Ubuntu 24.04 LTS. 1 GB is enough **because builds happen in CI or
  on your machine**, not on the box. The one exception is the console-side
  script below, which builds on the droplet and therefore insists on swap.
- A domain with an `A` record pointing at it.
- An SSH key on the droplet, and passwordless `sudo` for the deploy user (or
  connect as root).

`voidshell doctor` checks all of that and tells you which part is missing.

---

## What `setup` does

Everything below, idempotently. `--dry-run` prints the script it would run
instead of running it, which is worth doing once.

1. **Swap** — 2 GB, so a hand-run build isn't OOM-killed. Non-fatal if the
   filesystem won't take one.
2. **Node 22** via NodeSource, skipped if already current.
3. **Service user and directories** — `voidshell:voidshell`, with
   `/var/lib/voidshell` at mode `700`. `db.json` holds every dashboard on the
   box; it lives outside the repo and outside `/var/www`, where the static
   server could never hand it out.
4. **systemd units** — the API service, the backup service, and the nightly
   timer, enabled.
5. **Reverse proxy** — Caddy by default (automatic HTTPS), or `--proxy nginx`.
   The config is validated before anything is reloaded.
6. **Firewall** — OpenSSH plus 80/443.

> The `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers in
> the proxy config are **required**, not hardening. They're what grants
> `SharedArrayBuffer`, which is what lets the Python worker block on
> `Atomics.wait` for `input()`. Drop them and the shell still loads and scripts
> still run — but anything reading stdin reports interactive input unavailable,
> which reads as a broken terminal rather than a missing header.

With nginx, TLS is a separate step: `ssh root@DROPLET 'certbot --nginx'`.
Caddy gets certificates on first request.

---

## Deploying

```bash
npx voidshell deploy
```

Builds both packages, stages production-only dependencies for the API (fastify,
without vite or three), rsyncs both halves, restarts the service, and **polls
`/api/health` until it answers** — failing with the last 40 journal lines
rather than reporting success because `systemctl` returned zero.

`--api-only` / `--ui-only` narrow it; `--skip-build` ships whatever is already
in `dist/`.

### From CI

Push to `main`. `.github/workflows/deploy.yml` does the same thing on a runner.
Three secrets, set either on the repository or on its `production` environment:

| Secret | What |
|---|---|
| `DEPLOY_SSH_KEY` | private key with access to the droplet |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan YOUR_DROPLET` |
| `DEPLOY_TARGET` | `root@1.2.3.4` |

**With none of them set, the workflow skips instead of failing.** A fork or a
fresh clone has no droplet, and a deploy that cannot possibly succeed should
not spend a build proving it and then mail you about it — so a guard job checks
the three are present and the deploy job doesn't run otherwise. The run goes
green with a note saying which are missing. A red Deploy therefore means a
deploy that was meant to happen didn't, which is the only thing it should mean.

Host keys are pinned rather than using `StrictHostKeyChecking=no`, because a
deploy that accepts any host key is a deploy that hands its SSH key to whatever
answers the DNS record.

**This is the way to deploy without your own machine.** The workflow has
`workflow_dispatch` on it, so Actions → Deploy → *Run workflow*, from a phone
or any browser, does a full build-and-ship on a runner. Nothing below is needed
unless Actions itself is unavailable.

### From the droplet itself

For when neither your machine nor Actions is reachable — the DigitalOcean web
console, a borrowed laptop, a branch you'd rather not push:

```bash
/opt/voidshell/src/deploy/droplet-deploy.sh              # main
/opt/voidshell/src/deploy/droplet-deploy.sh feat/thing   # any branch
```

It fetches, hard-resets to `origin/<branch>`, builds, ships both halves,
restarts, and polls health — the same sequence as everything else here, just
without a second machine involved.

The trade is memory. Rollup holding a Three.js module graph peaks well past
what a 1 GB droplet has free while the API is also resident, and the kernel
resolves that shortfall by killing the largest process — which is the API. So
the script **refuses to start** below roughly 2.4 GB of RAM plus swap. Pass
`--make-swap` once to add a 2 GB swapfile and it will stop complaining:

```bash
/opt/voidshell/src/deploy/droplet-deploy.sh --make-swap
```

The previous API build is copied to `/opt/voidshell/api.prev` before anything
is overwritten, and a failed health check prints the one-line command to put it
back. `--skip-checks` drops the typecheck if you need the minutes.

#### First-time setup on the box

The script lives in the checkout it deploys, so it updates itself on every run.
Getting the first checkout there is the only manual part. On the droplet, once:

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519
cat /root/.ssh/id_ed25519.pub
```

Add that key at **Settings → Deploy keys** on the repo — read-only is enough,
and a read-only deploy key is the whole point: a droplet that can be pushed
from is a droplet that can rewrite history if it's ever compromised. Then:

```bash
git clone git@github.com:MrFr3nchy/voidshell.git /opt/voidshell/src
/opt/voidshell/src/deploy/droplet-deploy.sh
```

Note what this puts on the box: a checkout, and full devDependencies under
`/opt/voidshell/src/node_modules`. The API does not read any of it — it runs
from `/opt/voidshell/api`, which still gets only production dependencies — but
it is a few hundred megabytes of code sitting on a production machine, which is
a real if modest increase in what an intruder finds there. That is the actual
cost of being able to deploy from a phone, and it is why this is the third
option rather than the first.

---

## The model key (optional)

The stonks module asks Claude for its daily decision through
`/api/stonks/decide`, so the key stays on the server and never reaches a
dashboard:

```bash
npx voidshell key
# or:  pass show anthropic/voidshell | npx voidshell key
```

Prompted for, never passed as an argument — anything in `argv` is visible in
`ps` to every user on the machine. It lands in `/etc/voidshell.env` at mode
`600`, owned by root, referenced from the unit via `EnvironmentFile=-`.

Entirely optional. Without it the route answers `503` with
`{"fallback":"mock"}` and the module runs its deterministic simulator — a
working app, not a broken one. `voidshell key --clear` removes it.

Never put the key in the unit file itself: unit files are world-readable and
`systemctl show` prints `Environment=` lines to anyone on the box.

---

## Backups

`voidshell-backup.timer` copies `db.json` to
`/var/lib/voidshell/backups/db-YYYYMMDD.json` nightly at 03:30 and keeps 14.

```bash
npx voidshell backup            # run one now, list what's kept
npx voidshell backup --pull     # also download db.json for local inspection
```

Two details that matter more than they look:

- The script **refuses to back up a file that isn't valid JSON**. Retention is a
  rolling window, so copying a corrupt database for fourteen nights is exactly
  how a working backup set becomes fourteen copies of the same broken file.
- `Persistent=true`, so a droplet that was off at 03:30 takes its backup on the
  next boot instead of silently skipping the night.

### Restoring

```bash
npx voidshell restore db-20260729.json        # a backup already on the box
npx voidshell restore ./local-copy.json       # or a local file
```

Validates the JSON, copies the current database aside as
`db-pre-restore-*.json`, **stops the API**, installs the file at mode `600`, and
starts it again — then waits for health.

Stopping first is not optional: the API holds the whole database in memory and
writes it out whole, so a restore underneath a running process is overwritten
by the next save.

---

## Checking on it

```bash
npx voidshell status     # services, dashboards, backups, disk, memory
npx voidshell logs -f    # follow the API journal
npx voidshell logs --proxy
```

`status` flags the two states that are quietly wrong rather than loudly broken:
a `db.json` that isn't mode `600`, and dashboards that exist with no backups yet.

---

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

---

## Doing it by hand

Everything above is ordinary files. `voidshell setup --dry-run` prints exactly
what would run, and `deploy/` holds the units, the backup script, and the nginx
config if you'd rather copy them up yourself.
