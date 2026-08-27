#!/usr/bin/env bash
# Check nothing was corrupted in transit, and fix the usual setup mistakes.
#   bash appliance/verify.sh
cd "$(dirname "$0")/.." || exit 1
ok=1

echo "== file integrity =="
node -e "JSON.parse(require('fs').readFileSync('package.json'))" 2>/dev/null \
  && echo "ok   package.json" || { echo "BROKEN package.json"; ok=0; }
for f in $(find src -name '*.js'); do
  node --check "$f" >/dev/null 2>&1 && echo "ok   $f" || { echo "BROKEN $f"; ok=0; }
done
[ -s src/public/game.html ] && echo "ok   game.html" || { echo "MISSING game.html"; ok=0; }
[ -s src/public/index.html ] && echo "ok   index.html" || { echo "MISSING index.html"; ok=0; }

echo
echo "== configuration =="
if [ -f .env ]; then
  echo "ok   .env exists"
  grep -q '^ANTHROPIC_API_KEY=sk-' .env && echo "ok   anthropic key set" \
    || { echo "WARN no ANTHROPIC_API_KEY (agents cannot draft)"; }
  grep -q '^DASHBOARD_TOKEN=.\{16,\}' .env && echo "ok   dashboard token set" \
    || echo "WARN dashboard token missing or short"
else
  echo "MISSING .env  ->  cp .env.example .env && chmod 600 .env"; ok=0
fi

echo
echo "== systemd units match this user =="
ME="$(whoami)"; HOMEDIR="$HOME"
for u in unduruz-api unduruz-worker; do
  F="/etc/systemd/system/$u.service"
  if [ -f "$F" ]; then
    U="$(grep -m1 '^User=' "$F" | cut -d= -f2)"
    W="$(grep -m1 '^WorkingDirectory=' "$F" | cut -d= -f2)"
    if [ "$U" = "$ME" ] && [ -d "$W" ]; then
      echo "ok   $u (user=$U)"
    else
      echo "MISMATCH $u: unit says user=$U dir=$W, you are $ME at $HOMEDIR/unduruz-backend"
      echo "         fix: sudo bash appliance/verify.sh --fix"
      ok=0
    fi
  else
    echo "MISSING $F  ->  re-run appliance/install.sh"; ok=0
  fi
done

if [ "${1:-}" = "--fix" ]; then
  echo
  echo "== fixing unit paths =="
  sudo sed -i "s|/home/unduruz|$HOMEDIR|g; s|^User=.*|User=$ME|" \
    /etc/systemd/system/unduruz-api.service \
    /etc/systemd/system/unduruz-worker.service
  sudo chown -R "$ME":"$ME" .
  sudo systemctl daemon-reload
  sudo systemctl restart unduruz-api unduruz-worker
  sleep 2
  systemctl is-active --quiet unduruz-api && echo "api running" || echo "api still down"
  systemctl is-active --quiet unduruz-worker && echo "worker running" || echo "worker still down"
fi

echo
[ "$ok" = 1 ] && echo "ALL GOOD" || echo "Problems above. Run with --fix to repair paths."
