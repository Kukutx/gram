#!/usr/bin/env bash
# Dump the bundled PostgreSQL database to deploy/backups/, keeping the newest N (default 14),
# and upload a copy when BACKUP_UPLOAD_URL is set in .env.
# Schedule it, e.g. daily from cron:  15 3 * * * cd /srv/gram && bash deploy/backup.sh
# Restore: gunzip -c deploy/backups/<file>.sql.gz | docker compose --env-file .env \
#            -f deploy/compose.yaml exec -T postgres psql -U bot -d grammy_bot
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/lib.sh
# A failed backup tells the admins in Telegram; nobody reads cron logs.
trap 'notify_admins "$(pick "⚠️ 今天的数据库备份失败了，请查看服务器 /var/log/gram-backup.log。" "⚠️ Today'"'"'s database backup failed; see /var/log/gram-backup.log on the server.")"' ERR
keep="${KEEP:-14}"
mkdir -p deploy/backups
file="deploy/backups/gram-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose --env-file .env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U bot -d grammy_bot --no-owner --clean --if-exists | gzip > "$file.partial"
mv "$file.partial" "$file"
echo "Backup written: $file"
ls -1t deploy/backups/gram-*.sql.gz | tail -n "+$((keep + 1))" | xargs -r rm --

# Optional off-server copy: BACKUP_UPLOAD_URL is a write-only bucket link (an Oracle Object
# Storage pre-authenticated request, or any URL that accepts PUT). Named by day of month, so
# the bucket holds a rolling month of copies.
upload="$(env_value BACKUP_UPLOAD_URL)"
if [[ -n "$upload" ]]; then
  if ! curl -fsS --retry 3 -T "$file" "${upload%/}/gram-day-$(date -u +%d).sql.gz" >/dev/null; then
    trap - ERR
    echo 'WARN: off-server upload failed (local backup is fine).' >&2
    notify_admins "$(pick "⚠️ 今天的备份已保存在服务器上，但上传到存储桶失败了。请查看服务器 /var/log/gram-backup.log。" "⚠️ Today's backup is on the server, but uploading it to the bucket failed; see /var/log/gram-backup.log.")"
    exit 1
  fi
  echo 'Uploaded off-server copy.'
fi
