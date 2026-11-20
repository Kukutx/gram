#!/usr/bin/env bash
# Installs or updates gram on a fresh Debian/Ubuntu server (any provider), as root:
#
#   curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/server-install.sh | sudo bash
#
# Safe to re-run: it pulls the latest code and redeploys. Settings live in /opt/gram/.env.
# Values in /etc/gram/env.install (written by deploy/gcp-free.sh) are merged into .env once.
set -euo pipefail

GRAM_DIR="${GRAM_DIR:-/opt/gram}"
GRAM_REPO="${GRAM_REPO:-https://github.com/Kukutx/gram.git}"
GRAM_REF="${GRAM_REF:-$(cat /etc/gram/ref 2>/dev/null || echo develop)}"
INSTALL_ENV=/etc/gram/env.install

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo 'Run as root (sudo).' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say 'Memory: making sure swap exists (small servers need it to build)'
if ! swapon --show --noheadings | grep -q .; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-gram-swap.conf && sysctl -q -p /etc/sysctl.d/90-gram-swap.conf
fi

say 'Packages: git, curl, automatic security updates'
# A fresh VM runs cloud-init and its own apt jobs at boot. Let them finish first, then retry:
# DPkg::Lock::Timeout waits for the dpkg lock but not for the lists lock that `apt-get update` takes.
wait_for_apt() {
  if command -v cloud-init >/dev/null; then timeout 900 cloud-init status --wait >/dev/null 2>&1 || true; fi
  for _ in $(seq 1 120); do
    pgrep -x 'apt|apt-get|dpkg|unattended-upgr' >/dev/null || return 0
    sleep 5
  done
}
apt_get() {
  local try
  for try in 1 2 3 4 5 6; do
    apt-get -o DPkg::Lock::Timeout=600 "$@" && return 0
    echo "apt is busy (attempt $try), retrying in 20 s..." >&2
    sleep 20
  done
  return 1
}
wait_for_apt
apt_get update -qq
apt_get install -y -qq ca-certificates curl git openssl unattended-upgrades >/dev/null

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say 'Installing Docker'
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null

say "Code: $GRAM_REPO ($GRAM_REF)"
install -d -m 700 /etc/gram
echo "$GRAM_REF" > /etc/gram/ref
if [[ -d "$GRAM_DIR/.git" ]]; then
  git -C "$GRAM_DIR" fetch --quiet --depth 1 origin "$GRAM_REF"
  git -C "$GRAM_DIR" checkout --quiet --force -B deploy FETCH_HEAD
else
  git clone --quiet --depth 1 --branch "$GRAM_REF" "$GRAM_REPO" "$GRAM_DIR"
fi
cd "$GRAM_DIR"

say 'Settings: /opt/gram/.env'
touch .env && chmod 600 .env
[[ -s .env ]] || cp .env.example .env
set_env() { # set_env KEY VALUE: replace or append one line, keeping every other line
  local tmp; tmp="$(mktemp)"
  grep -v -E "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
get_env() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
if [[ -f "$INSTALL_ENV" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]] && set_env "${line%%=*}" "${line#*=}"
  done < "$INSTALL_ENV"
  rm -f "$INSTALL_ENV"
fi
[[ -n "$(get_env POSTGRES_PASSWORD)" ]] || set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
[[ -n "$(get_env METRICS_TOKEN)" ]] || set_env METRICS_TOKEN "$(openssl rand -hex 24)"
# Keep Node within a 1 GB machine; harmless on bigger ones.
[[ -n "$(get_env NODE_OPTIONS)" ]] || set_env NODE_OPTIONS '--max-old-space-size=256'
if [[ -z "$(get_env BOT_TOKEN)" || "$(get_env BOT_TOKEN)" == 123456789:* ]]; then
  echo "Put your bot token in $GRAM_DIR/.env (BOT_TOKEN=...) and run this script again." >&2
  exit 1
fi

say 'Daily backup at 03:15 (keeps 14) and weekly cleanup of old Docker images'
cat > /etc/cron.d/gram <<CRON
SHELL=/bin/bash
15 3 * * * root cd $GRAM_DIR && bash deploy/backup.sh >> /var/log/gram-backup.log 2>&1
40 4 * * 0 root docker image prune -af --filter until=168h >/dev/null 2>&1; docker builder prune -af --filter until=168h >/dev/null 2>&1
CRON

say 'Building and starting (the first build on a small server takes 10-20 minutes)'
bash deploy/up.sh
