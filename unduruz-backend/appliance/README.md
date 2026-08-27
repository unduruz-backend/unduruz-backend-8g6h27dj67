# Unduruz appliance

Turns a fresh Raspberry Pi OS Lite (64-bit) into a box whose only job is running
Unduruz. Not a custom OS — a locked-down Pi OS that boots straight into the
stack, updates itself, backs itself up, and reboots if it locks up.

## Setup

Flash **Raspberry Pi OS Lite (64-bit)**. In Raspberry Pi Imager's gear icon set
the hostname, your username, SSH with your key, and Wi-Fi. Then:

```bash
ssh you@yourpi
git clone <your-repo> ~/unduruz-backend      # or scp the folder across
cd ~/unduruz-backend
sudo bash appliance/install.sh
```

To have it clone for you and enable auto-update in one go:

```bash
sudo REPO=git@github.com:you/unduruz-backend.git bash appliance/install.sh
```

The script prints your **dashboard token** and **database password** at the end.
Save them. Then add your Anthropic key:

```bash
nano ~/unduruz-backend/.env        # ANTHROPIC_API_KEY=...
sudo systemctl restart unduruz-worker
sudo tailscale up
sudo reboot                        # arms the hardware watchdog
```

The installer is idempotent. Re-run it any time; it skips what is already done.

## What it sets up

| Piece | Why |
|---|---|
| `unduruz-api`, `unduruz-worker` | The stack, restarted on failure, started at boot |
| `unduruz-update.timer` | Nightly 4am (jittered) git update **with automatic rollback** |
| `unduruz-health.timer` | Every 5 min: API responding, worker draining jobs |
| `unduruz-backup.timer` | Nightly `pg_dump`, 14 kept |
| Hardware watchdog | Reboots the board if it hard-locks. Software cannot fix that. |
| journald capped at 50M, `swappiness=10` | SD cards die from write churn |
| `unattended-upgrades` | OS security patches apply themselves |
| Login banner | Plug in a monitor: revenue, queue, service health |

## Auto-update, and how it protects itself

At 4am the Pi checks your git remote. If there is a new commit:

1. **Database is backed up first**, tagged `pre-update`.
2. New commit checked out, `npm ci`, migrations run, services restarted.
3. **Health check**, retried for 45 seconds: API answering, worker alive, no
   jobs wedged.
4. If it passes, done — logged to the dashboard activity feed.
5. **If it fails, the previous commit is restored automatically** and the same
   health check re-run. The failure is written to your activity log so you see
   it next time you open the dashboard.

So a bad commit costs you one night of not-updating, not a dead box. If both the
update *and* the rollback fail, that is logged loudly — the only case needing you.

Only code on your git remote is ever deployed. Nothing pulls from me or anywhere
else, and OS packages update through Debian's normal security channel.

```bash
sudo unduruz-update                     # force one now
sudo systemctl disable --now unduruz-update.timer   # turn it off
systemctl list-timers 'unduruz-*'       # when things next run
journalctl -t unduruz-update -n 50      # update history
```

## Day to day

```bash
journalctl -u unduruz-worker -f       # watch the agents
journalctl -t unduruz-health -n 20    # what got restarted, and why
sudo unduruz-backup manual            # backup on demand
ls -lh /var/backups/unduruz/
```

Restore:

```bash
sudo systemctl stop unduruz-api unduruz-worker
gunzip -c /var/backups/unduruz/unduruz-YYYYMMDD-HHMMSS-nightly.sql.gz \
  | sudo -u postgres psql -d unduruz
sudo systemctl start unduruz-api unduruz-worker
```

## Worth knowing

**Back the backups up off the box.** They sit on the same SD card that is the
most likely thing to fail. A weekly `scp` to your PC, or point `BACKUP_DIR` at a
USB stick.

**A high-endurance SD card is worth the money**, or boot from USB SSD — the Pi 5
supports it and it removes the main hardware failure mode entirely.

**The username.** The installer rewrites the systemd units to match whoever runs
it, so `unduruz` in the shipped files is only a default. If you see
`status=217/USER`, the unit and the real user disagree.

**Auto-update needs the Pi to reach git without a passphrase** — deploy key or
HTTPS token. If `sudo unduruz-update` prompts for anything, the timer will hang
rather than update.
