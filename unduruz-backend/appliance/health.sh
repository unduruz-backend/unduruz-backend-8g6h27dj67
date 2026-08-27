#!/usr/bin/env bash
# Is the stack actually working? Used by the timer and by update.sh.
#   unduruz-health              check once, restart what is stuck
#   unduruz-health --strict     check only, exit non-zero on failure
#   unduruz-health --wait 45    retry for N seconds before giving up
set -uo pipefail

APP_DIR="${APP_DIR:-/home/unduruz/unduruz-backend}"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
STRICT=0; WAIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --wait) WAIT="$2"; shift ;;
  esac
  shift
done

check() {
  curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null || return 1
  systemctl is-active --quiet unduruz-worker || return 2
  # a job stuck 'running' for 20 minutes means the worker is wedged
  local stuck
  stuck="$(sudo -u postgres psql -d unduruz -tAc \
    "SELECT count(*) FROM jobs WHERE status='running' AND created_at < now() - interval '20 minutes'" \
    2>/dev/null || echo 0)"
  [ "${stuck:-0}" -eq 0 ] || return 3
  return 0
}

deadline=$(( $(date +%s) + WAIT ))
while :; do
  if check; then exit 0; fi
  rc=$?
  [ "$(date +%s)" -lt "$deadline" ] && { sleep 5; continue; }
  break
done

if [ "$STRICT" -eq 1 ]; then
  logger -t unduruz-health "health check failed (rc=$rc)"
  exit "$rc"
fi

logger -t unduruz-health "unhealthy (rc=$rc), restarting"
case "$rc" in
  1) systemctl restart unduruz-api ;;
  2|3) systemctl restart unduruz-worker
       sudo -u postgres psql -d unduruz -q -c \
         "UPDATE jobs SET status='pending' WHERE status='running' AND created_at < now() - interval '20 minutes'" \
         >/dev/null 2>&1 ;;
esac
