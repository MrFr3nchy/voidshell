#!/usr/bin/env bash
#
# Build voidshell locally and push the static output to your droplet.
#
#   ./deploy.sh root@YOUR_DROPLET_IP
#
# or set it once:  export VOIDSHELL_TARGET=root@1.2.3.4
#
set -euo pipefail

TARGET="${1:-${VOIDSHELL_TARGET:-}}"
REMOTE_DIR="${VOIDSHELL_REMOTE_DIR:-/var/www/voidshell}"

if [ -z "$TARGET" ]; then
  echo "usage: ./deploy.sh user@host   (or set VOIDSHELL_TARGET)" >&2
  exit 1
fi

echo "building..."
npm run build

echo "syncing dist/ -> ${TARGET}:${REMOTE_DIR}"
ssh "$TARGET" "mkdir -p '${REMOTE_DIR}'"
rsync -avz --delete dist/ "${TARGET}:${REMOTE_DIR}/"

echo "reloading caddy..."
ssh "$TARGET" 'sudo systemctl reload caddy || true'

echo "live."
