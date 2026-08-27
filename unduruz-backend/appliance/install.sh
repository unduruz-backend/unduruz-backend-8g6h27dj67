#!/usr/bin/env bash
# Turn a fresh Raspberry Pi OS Lite (64-bit) into an Unduruz appliance.
# Safe to re-run: every step checks before it acts.
#
#   sudo bash install.sh
#
set -euo pipefail

APP_USER="${APP_USER:-$(logname 2>/dev/null || echo "${SUDO_USER:-pi}")}"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/unduruz-backend"
REPO="${REPO:-}"                      # optional git URL for auto-update

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !! %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ "$(uname -m)" = "aarch64" ] || warn "Not aarch64. You want 64-bit Pi OS."

say "Installing packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  git curl ca-certificates postgresql postgresql-client \
  unattended-upgrades watchdog jq

say "Installing Node 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Database"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='unduruz'" | grep -q 1 || {
  DBPASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -c "CREATE USER unduruz WITH PASSWORD '${DBPASS}';"
  sudo -u postgres psql -c "CREATE DATABASE unduruz OWNER unduruz;"
  echo "DB password: ${DBPASS}"
  echo "${DBPASS}" > /root/.unduruz-db-pass
  chmod 600 /root/.unduruz-db-pass
}

say "Application"
if [ -n "${REPO}" ] && [ ! -d "${APP_DIR}/.git" ]; then
  sudo -u "${APP_USER}" git clone "${REPO}" "${APP_DIR}"
fi
[ -d "${APP_DIR}" ] || { echo "Put the code in ${APP_DIR} first, or set REPO=<git-url>."; exit 1; }
cd "${APP_DIR}"
sudo -u "${APP_USER}" npm ci --omit=dev 2>/dev/null || sudo -u "${APP_USER}" npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  DBPASS="$(cat /root/.unduruz-db-pass 2>/dev/null || echo CHANGEME)"
  TOKEN="$(openssl rand -hex 32)"
  sed -i "s|DATABASE_URL=.*|DATABASE_URL=postgres://unduruz:${DBPASS}@localhost:5432/unduruz|" .env
  sed -i "s|DASHBOARD_TOKEN=.*|DASHBOARD_TOKEN=${TOKEN}|" .env
  chown "${APP_USER}:${APP_USER}" .env
  chmod 600 .env
  warn "Edit ${APP_DIR}/.env and add ANTHROPIC_API_KEY, then: sudo systemctl restart unduruz-worker"
  echo "Dashboard token: ${TOKEN}"
fi

say "Schema"
sudo -u "${APP_USER}" node src/migrate.js || warn "Migration failed; check .env"

say "Services"
for unit in unduruz-api unduruz-worker; do
  sed -e "s|/home/unduruz|${APP_HOME}|g" -e "s|^User=unduruz|User=${APP_USER}|" \
      "deploy/${unit}.service" > "/etc/systemd/system/${unit}.service"
done
cp appliance/systemd/*.service appliance/systemd/*.timer /etc/systemd/system/
sed -i "s|__APP_DIR__|${APP_DIR}|g; s|__APP_USER__|${APP_USER}|g" \
  /etc/systemd/system/unduruz-update.service \
  /etc/systemd/system/unduruz-health.service \
  /etc/systemd/system/unduruz-backup.service
install -m 755 appliance/update.sh  /usr/local/bin/unduruz-update
install -m 755 appliance/health.sh  /usr/local/bin/unduruz-health
install -m 755 appliance/backup.sh  /usr/local/bin/unduruz-backup
install -m 755 appliance/banner.sh  /etc/update-motd.d/99-unduruz
systemctl daemon-reload
systemctl enable --now unduruz-api unduruz-worker
systemctl enable --now unduruz-health.timer unduruz-backup.timer
if [ -n "${REPO}" ] || [ -d "${APP_DIR}/.git" ]; then
  systemctl enable --now unduruz-update.timer
else
  warn "No git repo: auto-update timer left off."
fi

say "SD card protection"
# journald eats cards alive by default
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/unduruz.conf << 'EOF'
[Journal]
Storage=persistent
SystemMaxUse=50M
SystemMaxFileSize=10M
EOF
systemctl restart systemd-journald
grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl -p >/dev/null

say "Hardware watchdog"
# If the board hard-locks, nothing in software can save it. This can.
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
grep -q 'dtparam=watchdog=on' "$BOOTCFG" || echo 'dtparam=watchdog=on' >> "$BOOTCFG"
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/watchdog.conf << 'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF

say "Unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
echo "Run: sudo tailscale up"

say "Done"
systemctl --no-pager status unduruz-api unduruz-worker | head -20
echo
echo "Dashboard: http://$(hostname):8787/    Town: http://$(hostname):8787/game"
echo "Token:     grep DASHBOARD_TOKEN ${APP_DIR}/.env"
echo "Reboot once to arm the hardware watchdog."
