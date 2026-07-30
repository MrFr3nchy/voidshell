#!/usr/bin/env bash
#
# Nightly copy of the voidshell database, keeping the last 14.
#
# One JSON file holding every dashboard is one bad moment from total data
# loss. This is the cheapest thing that turns "gone" into "yesterday's".
#
# Installed at /opt/voidshell/backup.sh and run by voidshell-backup.timer.
set -euo pipefail

DB="${VOIDSHELL_DB:-/var/lib/voidshell/db.json}"
DIR="${VOIDSHELL_BACKUPS:-/var/lib/voidshell/backups}"
KEEP="${VOIDSHELL_KEEP:-14}"

if [ ! -f "$DB" ]; then
  echo "no database at $DB yet — nothing to back up"
  exit 0
fi

# A backup of a corrupt file is a corrupt backup that evicts a good one. Since
# retention is a rolling window, copying garbage for fourteen nights is how a
# working backup set becomes fourteen copies of the same broken file.
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DB" 2>/dev/null; then
  echo "refusing to back up $DB — it is not valid JSON" >&2
  exit 1
fi

mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%d)"
DEST="$DIR/db-$STAMP.json"

# Same temp-then-rename as the API's own writes: a backup interrupted halfway
# should not leave a truncated file wearing today's name.
TMP="$(mktemp "$DIR/.db-$STAMP.XXXXXX")"
cp "$DB" "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$DEST"

# Rolling window. `ls -1` sorts lexicographically, which for db-YYYYMMDD.json
# is also chronological.
COUNT="$(find "$DIR" -maxdepth 1 -name 'db-*.json' | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$DIR" -maxdepth 1 -name 'db-*.json' -printf '%f\n' \
    | sort \
    | head -n "$((COUNT - KEEP))" \
    | while read -r old; do rm -f "$DIR/$old"; done
fi

echo "backed up to $DEST ($(find "$DIR" -maxdepth 1 -name 'db-*.json' | wc -l) kept)"
