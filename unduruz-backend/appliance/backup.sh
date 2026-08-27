#!/usr/bin/env bash
# Nightly pg_dump. An SD card failure should cost you a day, not the project.
set -euo pipefail
DIR="${BACKUP_DIR:-/var/backups/unduruz}"
KEEP="${KEEP:-14}"
TAG="${1:-nightly}"
mkdir -p "$DIR"
FILE="${DIR}/unduruz-$(date +%Y%m%d-%H%M%S)-${TAG}.sql.gz"
sudo -u postgres pg_dump unduruz | gzip > "$FILE"
find "$DIR" -name 'unduruz-*.sql.gz' -type f -printf '%T@ %p\n' \
  | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | xargs -r rm -f
logger -t unduruz-backup "wrote $(basename "$FILE")"
