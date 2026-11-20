#!/usr/bin/env bash
# Daily self-update, scheduled by server-install.sh (/etc/cron.d/gram). Run it by hand the same way:
#
#   sudo bash /opt/gram/deploy/auto-update.sh
#
# When the tracked branch (/etc/gram/ref, usually develop) has a new commit, it reinstalls from
# that commit with the new commit's own server-install.sh. If anything fails (build, migration,
# health checks, self-check), it goes back to the commit that was running and rebuilds it. Either
# way the admins get a Telegram message, so nobody needs to read logs. AUTO_UPDATE=false in .env
# turns it off.
#
# Everything runs inside main(): a checkout that rewrites this file mid-run cannot change what runs.
main() {
  set -uo pipefail
  # GRAM_DIR / GRAM_ETC / GRAM_LOCK_FILE exist for tests; servers use the defaults.
  local dir="${GRAM_DIR:-/opt/gram}" etc="${GRAM_ETC:-/etc/gram}" ref old new title repeat
  local failed="$etc/failed-update" installer="$etc/install-next.sh"
  cd "$dir" || exit 1
  echo "== $(date -u +%FT%TZ)"
  . deploy/lib.sh
  [[ $EUID -eq 0 || -n "${GRAM_ETC:-}" ]] || { echo 'Run as root (sudo).' >&2; exit 1; }
  if [[ "$(env_value AUTO_UPDATE)" =~ ^(0|false|no|off)$ ]]; then
    echo 'AUTO_UPDATE is off.'
    exit 0
  fi
  # One install or update at a time (server-install.sh takes the same lock).
  exec 9>"${GRAM_LOCK_FILE:-/run/gram-install.lock}"
  flock -n 9 || { echo 'An install or update is already running.'; exit 0; }
  export GRAM_LOCK_HELD=1

  ref="$(cat "$etc/ref" 2>/dev/null || echo develop)"
  old="$(git rev-parse HEAD)"
  if ! git fetch --quiet --depth 1 origin "$ref"; then
    echo 'Could not reach GitHub; trying again tomorrow.'
    exit 0
  fi
  new="$(git rev-parse FETCH_HEAD)"
  if [[ "$new" == "$old" ]]; then
    echo "Up to date ($(git rev-parse --short HEAD))."
    exit 0
  fi
  # GitHub merge commits say "Merge pull request #N from ..." and carry the PR title below it.
  title="$(git log -1 --format=%s "$new")"
  [[ "$title" == 'Merge pull request'* ]] && title="$(git log -1 --format=%b "$new" | sed -n '/./{p;q}')"
  echo "Updating ${old:0:7} -> ${new:0:7}: $title"
  git tag -f gram-previous "$old" >/dev/null # keeps the running version's objects for a rollback

  if git show "$new:deploy/server-install.sh" > "$installer" &&
    GRAM_COMMIT="$new" bash "$installer"; then
    rm -f "$failed"
    notify_admins "$(pick "✅ 机器人已自动更新到 ${new:0:7}：$title" "✅ The bot updated itself to ${new:0:7}: $title")"
    exit 0
  fi

  echo "Update failed; going back to ${old:0:7}." >&2
  # Retried daily (a failure may be temporary), but the admins hear about each commit once.
  repeat=''
  [[ "$(cat "$failed" 2>/dev/null)" == "$new" ]] && repeat=1
  echo "$new" > "$failed"
  if git checkout --quiet --force -B deploy "$old" && bash deploy/up.sh; then
    [[ -n "$repeat" ]] || notify_admins "$(pick \
      "⚠️ 自动更新到 ${new:0:7} 没有成功，已自动退回原来的版本 ${old:0:7}，机器人正常运行。之后每天会再试；日志在服务器 /var/log/gram-update.log。" \
      "⚠️ Updating to ${new:0:7} failed, so the bot went back to ${old:0:7} and is running. It retries daily; log: /var/log/gram-update.log on the server.")"
  else
    notify_admins "$(pick \
      "🚨 自动更新失败，退回原版本也没有成功，机器人可能已停止。请在 Cloud Shell 重新运行部署命令，或查看服务器 /var/log/gram-update.log。" \
      "🚨 The update failed and so did going back; the bot may be down. Re-run the deploy command, or see /var/log/gram-update.log on the server.")"
  fi
  exit 1
}
main "$@"
