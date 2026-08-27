#!/usr/bin/env bash
# Login banner: plug in a monitor and see everything at a glance.
APP_DIR="/home/$(ls /home | head -1)/unduruz-backend"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
g=$'\033[1;36m'; y=$'\033[1;33m'; d=$'\033[0m'; r=$'\033[1;31m'

sql() { sudo -u postgres psql -d unduruz -tAc "$1" 2>/dev/null; }
up()  { systemctl is-active --quiet "$1" && echo "ok" || echo "${r}DOWN${d}"; }

REAL="$(sql "SELECT coalesce(sum(amount_cents),0)/100.0 FROM sales")"
SALES="$(sql "SELECT count(*) FROM sales")"
REVIEW="$(sql "SELECT count(*) FROM tasks WHERE status='review'")"
DRAFTS="$(sql "SELECT coalesce(drafts,0) FROM usage_day WHERE day=CURRENT_DATE")"
FAILED="$(sql "SELECT count(*) FROM jobs WHERE status='failed'")"

printf '\n%s  UNDURUZ INDUSTRIES%s\n' "$g" "$d"
printf '  api %s   worker %s\n' "$(up unduruz-api)" "$(up unduruz-worker)"
printf '  revenue %s$%s%s from %s sales\n' "$y" "${REAL:-0.00}" "$d" "${SALES:-0}"
printf '  %s awaiting review   %s drafts today   %s failed jobs\n' \
  "${REVIEW:-0}" "${DRAFTS:-0}" "${FAILED:-0}"
printf '  http://%s:%s/  and  /game\n\n' "$(hostname)" "$PORT"
