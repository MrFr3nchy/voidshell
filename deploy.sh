#!/usr/bin/env bash
#
# Build voidshell locally and push both halves to your droplet.
#
#   ./deploy.sh root@YOUR_DROPLET_IP
#
# or set it once:  export VOIDSHELL_TARGET=root@1.2.3.4
#
# CI is the better path — it builds from a commit rather than from whatever is
# in your working tree. See DEPLOY.md. This is for one-offs and for the first
# deploy, before the secrets are set up.
set -euo pipefail

TARGET="${1:-${VOIDSHELL_TARGET:-}}"
WWW_DIR="${VOIDSHELL_REMOTE_DIR:-/var/www/voidshell}"
API_DIR="${VOIDSHELL_API_DIR:-/opt/voidshell/api}"

if [ -z "$TARGET" ]; then
  echo "usage: ./deploy.sh user@host   (or set VOIDSHELL_TARGET)" >&2
  exit 1
fi

echo "building client and api..."
npm run build
npm run build --workspace @voidshell/api

# Production dependencies only, staged away from the repo's node_modules so the
# droplet gets fastify without vite, three, or the type packages.
echo "staging api runtime..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r packages/api/dist "$STAGE/dist"
cp packages/api/package.json "$STAGE/"
(cd "$STAGE" && npm install --omit=dev --no-package-lock --silent)

echo "syncing client -> ${TARGET}:${WWW_DIR}"
ssh "$TARGET" "mkdir -p '${WWW_DIR}' '${API_DIR}'"
rsync -az --delete packages/ui/dist/ "${TARGET}:${WWW_DIR}/"

# No --delete here: /opt/voidshell also holds backup.sh and anything else
# installed by hand, and a deploy shouldn't sweep the droplet's own furniture.
echo "syncing api -> ${TARGET}:${API_DIR}"
rsync -az "$STAGE/" "${TARGET}:${API_DIR}/"
rsync -az deploy/backup.sh "${TARGET}:/opt/voidshell/backup.sh"

echo "restarting..."
ssh "$TARGET" '
  sudo systemctl restart voidshell-api || true
  sudo systemctl reload caddy || true
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health; then echo; exit 0; fi
    sleep 1
  done
  echo "warning: the api did not report healthy" >&2
  exit 1
'

echo "live."
