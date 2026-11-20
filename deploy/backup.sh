#!/usr/bin/env bash
# Dump the bundled PostgreSQL database to deploy/backups/, keeping the newest N (default 14).
# Schedule it, e.g. daily from cron:  15 3 * * * cd /srv/gram && bash deploy/backup.sh
# Restore: gunzip -c deploy/backups/<file>.sql.gz | docker compose --env-file .env \
#            -f deploy/compose.yaml exec -T postgres psql -U bot -d grammy_bot
set -euo pipefail
cd "$(dirname "$0")/.."
keep="${KEEP:-14}"
mkdir -p deploy/backups
file="deploy/backups/gram-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U bot -d grammy_bot --no-owner --clean --if-exists | gzip > "$file.partial"
mv "$file.partial" "$file"
echo "Backup written: $file"
ls -1t deploy/backups/gram-*.sql.gz | tail -n "+$((keep + 1))" | xargs -r rm --
