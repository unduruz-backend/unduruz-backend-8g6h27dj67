#!/usr/bin/env bash
# Auto-update with rollback. If the new commit fails its health check,
# the previous commit is restored automatically.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/unduruz/unduruz-backend}"
cd "$APP_DIR"

log() { logger -t unduruz-update "$*"; echo "$*"; }
note() {  # write to the activity log the dashboard shows
  local msg="$1"
  sudo -u postgres psql -d unduruz -q -c \
    "INSERT INTO events (actor, text, icon) VALUES ('System', \$\$${msg}\$\$, 'update')" \
    >/dev/null 2>&1 || true
}

BEFORE="$(git rev-parse HEAD)"
git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
AFTER="$(git rev-parse "origin/${BRANCH}")"

if [ "$BEFORE" = "$AFTER" ]; then
  log "already current ($BEFORE)"
  exit 0
fi

log "updating ${BEFORE:0:7} -> ${AFTER:0:7}"

# Back up the database before any migration touches it.
/usr/local/bin/unduruz-backup pre-update || log "backup failed, continuing"

apply() {
  git checkout --quiet --force "$1"
  npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
  node src/migrate.js
  systemctl restart unduruz-api unduruz-worker
}

if apply "$AFTER" && /usr/local/bin/unduruz-health --strict --wait 45; then
  log "update ok at ${AFTER:0:7}"
  note "Updated to ${AFTER:0:7} and healthy"
  exit 0
fi

log "health check FAILED, rolling back to ${BEFORE:0:7}"
if apply "$BEFORE" && /usr/local/bin/unduruz-health --strict --wait 45; then
  log "rollback ok"
  note "Update ${AFTER:0:7} failed health check. Rolled back to ${BEFORE:0:7}."
else
  log "ROLLBACK ALSO FAILED - needs a human"
  note "Update AND rollback failed. Service may be down."
fi
exit 1
