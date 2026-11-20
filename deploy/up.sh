#!/usr/bin/env bash
# Build and (re)start the production stack, then verify it. Safe to re-run for upgrades:
# migrations run first, bot and worker restart only after they succeed.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo 'Missing .env: cp .env.example .env and fill it in.' >&2; exit 1; }
compose() { docker compose --env-file .env -f deploy/compose.yaml "$@"; }
value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

mode="$(value BOT_MODE)"; mode="${mode:-polling}"
[[ -n "$(value BOT_TOKEN)" ]] || { echo 'Set BOT_TOKEN in .env.' >&2; exit 1; }
[[ -n "$(value POSTGRES_PASSWORD)" ]] ||
  { echo 'Set POSTGRES_PASSWORD in .env (e.g. openssl rand -hex 24).' >&2; exit 1; }
[[ -n "$(value ADMIN_IDS)$(value ADMIN_CHAT_ID)$(value ADMIN_TELEGRAM_ID)" ]] ||
  echo 'WARN: no ADMIN_IDS / ADMIN_CHAT_ID: tickets are stored but nobody is notified.' >&2

profiles=()
if [[ "$mode" == webhook ]]; then
  [[ -n "$(value DOMAIN)" ]] || { echo 'Webhook mode needs DOMAIN (and PUBLIC_URL=https://DOMAIN) in .env.' >&2; exit 1; }
  [[ "$(value PUBLIC_URL)" == "https://$(value DOMAIN)"* ]] ||
    { echo 'PUBLIC_URL must be https://DOMAIN in webhook mode.' >&2; exit 1; }
  profiles=(--profile webhook)
fi

export GRAM_IMAGE_TAG="${GRAM_IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
echo "==> Building images ($GRAM_IMAGE_TAG)"
compose build
echo '==> Starting database, migrations, bot and worker'
compose "${profiles[@]}" up -d --wait --remove-orphans

if [[ "$mode" == webhook ]]; then
  echo '==> Registering the Telegram webhook'
  compose run --rm --no-deps bot node dist/cli/set-webhook.js
else
  # Polling and a registered webhook exclude each other; the bot removes it on start.
  :
fi
echo '==> Publishing the command menu'
compose run --rm --no-deps bot node dist/cli/sync-commands.js || echo 'WARN: command menu sync failed (bot still works).' >&2

echo '==> Self-check'
compose run --rm --no-deps bot node dist/cli/doctor.js
compose ps
echo
echo 'Done. Send /start to the bot, then /ticket and /status as an admin.'
echo "Logs: docker compose --env-file .env -f deploy/compose.yaml logs -f bot worker"
