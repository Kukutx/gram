# Shared helpers for the deploy scripts. Source it from the repository root:  . deploy/lib.sh

# env_value KEY: the last KEY=value in .env, without surrounding quotes; empty (and success) if unset.
env_value() {
  { grep -E "^$1=" .env 2>/dev/null || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# pick ZH EN: the text for the bot's DEFAULT_LANGUAGE (Chinese unless it is en).
pick() { if [[ "$(env_value DEFAULT_LANGUAGE)" == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

# notify_admins TEXT: best-effort Telegram message to the support group, else to every admin.
# Server jobs (updates, backups) use it so problems reach a person without anyone reading logs.
# The token goes to curl on stdin, never on a command line other users could list.
notify_admins() {
  local token chats chat
  token="$(env_value BOT_TOKEN)"
  [[ -n "$token" ]] || return 0
  chats="$(env_value ADMIN_CHAT_ID)"
  [[ -n "$chats" ]] || chats="$(env_value ADMIN_IDS),$(env_value ADMIN_TELEGRAM_ID)"
  for chat in $(tr ', ' '\n\n' <<<"$chats" | grep -E '^-?[0-9]+$' | sort -u); do
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
      curl -fsS --max-time 20 -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" \
        -o /dev/null 2>/dev/null || true
  done
}
