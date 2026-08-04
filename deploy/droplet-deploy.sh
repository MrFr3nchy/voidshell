#!/usr/bin/env bash
#
# Deploy voidshell from the droplet itself.
#
#   /opt/voidshell/src/deploy/droplet-deploy.sh [branch]
#
# For when you are not at your own machine: the DigitalOcean web console, a
# phone, a borrowed laptop. Pulls the branch, builds it here, ships both halves
# into place, restarts, and waits for the API to actually answer.
#
# Prefer the GitHub Actions "Deploy" workflow when you can reach it — Actions →
# Deploy → Run workflow does the same thing on a runner with memory to spare,
# and never touches the live box until it has a finished artifact. This script
# builds on the same droplet that is currently serving traffic, which is why it
# refuses to start without enough memory to do that safely.
#
# The script lives in the checkout it deploys, so `git pull` updates it too.
# An edit to this file takes effect on the *next* run, not the one that pulled
# it: bash reads the script as it executes, and rewriting it mid-run is how you
# get a shell parsing the second half of a different file.

set -euo pipefail

REPO_URL="${VOIDSHELL_REPO:-git@github.com:MrFr3nchy/voidshell.git}"
SRC_DIR="${VOIDSHELL_SRC:-/opt/voidshell/src}"
API_DIR="${VOIDSHELL_API_DIR:-/opt/voidshell/api}"
WWW_DIR="${VOIDSHELL_WWW_DIR:-/var/www/voidshell}"
PORT="${VOIDSHELL_PORT:-3000}"

# Rollup holding a Three.js module graph peaks well past what a 1 GB droplet
# has free while the API is also resident. Without swap the kernel resolves the
# shortfall by killing the largest process, which is usually the API — so the
# site goes down in order to publish a build that then fails anyway.
MIN_TOTAL_MB="${VOIDSHELL_MIN_MEM_MB:-2400}"

# Same reasoning as the CLI's SHIPPED_MODES. `-a` implies `-p`, and the staging
# directory is a `mktemp -d`, created 0700. Those modes shipped as-is once and
# left the unprivileged service user unable to enter its own WorkingDirectory:
# systemd failed with status=200/CHDIR before Node ran, which reads like an
# application crash and is not one.
SHIPPED_MODES="--chmod=D755,F644"

BRANCH="main"
RUN_CHECKS=1
MAKE_SWAP=0

usage() {
  cat >&2 <<'EOF'
usage: droplet-deploy.sh [branch] [options]

  branch          branch to deploy (default: main)
  --skip-checks   skip typecheck — faster, and ships whatever compiles
  --make-swap     add a 2G swapfile if none is active, then continue
  --help          this

env overrides: VOIDSHELL_REPO VOIDSHELL_SRC VOIDSHELL_API_DIR
               VOIDSHELL_WWW_DIR VOIDSHELL_PORT VOIDSHELL_MIN_MEM_MB
EOF
}

for arg in "$@"; do
  case "$arg" in
    --skip-checks) RUN_CHECKS=0 ;;
    --make-swap)   MAKE_SWAP=1 ;;
    --help|-h)     usage; exit 0 ;;
    -*)            echo "unknown option: $arg" >&2; usage; exit 1 ;;
    *)             BRANCH="$arg" ;;
  esac
done

log()  { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root — it writes to ${API_DIR}, ${WWW_DIR}, and restarts a unit"

# ---------------------------------------------------------------- preflight

total_mb() { awk '/^MemTotal:/{m=$2} /^SwapTotal:/{s=$2} END{printf "%d", (m+s)/1024}' /proc/meminfo; }

make_swap() {
  if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
    log "swap is already active"
    return 0
  fi
  [ -e /swapfile ] && die "/swapfile exists but is not active — look at it by hand before I make another"
  log "creating a 2G swapfile"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  ok "swap active, and it will come back after a reboot"
}

[ "$MAKE_SWAP" -eq 1 ] && make_swap

AVAILABLE_MB="$(total_mb)"
if [ "$AVAILABLE_MB" -lt "$MIN_TOTAL_MB" ]; then
  die "only ${AVAILABLE_MB}MB of RAM+swap — the client build needs about ${MIN_TOTAL_MB}MB here.
  Re-run with --make-swap to add 2G, or use the GitHub Actions Deploy workflow instead.
  Building anyway is how the OOM killer takes the API down with it."
fi

command -v git  >/dev/null || die "git is not installed — apt install git"
command -v node >/dev/null || die "node is not installed — run voidshell setup from your machine"
NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 22 ] || die "node $(node -v) is too old — the build needs 22 or newer"

log "${AVAILABLE_MB}MB RAM+swap, node $(node -v), deploying ${BRANCH}"

# ----------------------------------------------------------------- sources

if [ ! -d "$SRC_DIR/.git" ]; then
  log "no checkout at ${SRC_DIR} — cloning"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone "$REPO_URL" "$SRC_DIR" || die "clone failed.
  A private repo needs a key this droplet is allowed to read with. Generate one:
    ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519
    cat /root/.ssh/id_ed25519.pub
  then add it at Settings → Deploy keys on the repo (read-only is enough)."
fi

cd "$SRC_DIR"
log "fetching"
git fetch --prune origin || die "could not fetch — check the droplet's deploy key"
# reset rather than pull: a stray edit made on the box during some 3am incident
# should not be able to block or, worse, silently merge into a deploy.
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
log "at $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s | cut -c1-60)"

# ------------------------------------------------------------------ build

log "installing dependencies"
npm ci --no-audit --no-fund

if [ "$RUN_CHECKS" -eq 1 ]; then
  log "typecheck"
  npm run typecheck || die "typecheck failed — nothing was shipped. --skip-checks overrides this."
fi

log "building the client"
npm run build || die "the client build failed — nothing was shipped"

log "building the API"
npm run build --workspace @voidshell/api || die "the API build failed — nothing was shipped"

# ------------------------------------------------------------------ stage

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log "staging API runtime dependencies"
cp -r packages/api/dist "$STAGE/dist"
cp packages/api/package.json "$STAGE/"
# Against the API's own manifest, so the droplet gets fastify without vite,
# three, or the type packages.
(cd "$STAGE" && npm install --omit=dev --no-package-lock --silent)

# A snapshot to fall back to. The health check below can fail on a build that
# compiled perfectly well, and rolling back should not require a laptop.
if [ -d "$API_DIR" ]; then
  rm -rf "${API_DIR}.prev"
  cp -a "$API_DIR" "${API_DIR}.prev"
fi

log "shipping API → ${API_DIR}"
mkdir -p "$API_DIR" "$WWW_DIR"
# No --delete: /opt/voidshell also holds backup.sh and anything else installed
# by hand, and a deploy should not sweep the droplet's own furniture.
rsync -a $SHIPPED_MODES "$STAGE/" "$API_DIR/"

log "shipping client → ${WWW_DIR}"
rsync -a --delete $SHIPPED_MODES packages/ui/dist/ "$WWW_DIR/"

if [ -f deploy/backup.sh ]; then
  install -m 755 deploy/backup.sh /opt/voidshell/backup.sh
fi

# ---------------------------------------------------------------- restart

log "restarting and waiting for health"
systemctl restart voidshell-api

# systemctl returns as soon as the unit is active, which is before the store has
# finished loading. Poll the thing that actually answers.
for _ in $(seq 1 20); do
  if HEALTH="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)"; then
    ok "deployed — $(git rev-parse --short HEAD)"
    printf '  health  %s\n' "$HEALTH"
    exit 0
  fi
  sleep 1
done

printf '\n' >&2
journalctl -u voidshell-api -n 40 --no-pager >&2
printf '\n' >&2
die "the API did not come back healthy.
  The previous build is at ${API_DIR}.prev — to put it back:
    rsync -a --delete ${API_DIR}.prev/ ${API_DIR}/ && systemctl restart voidshell-api"
