#!/usr/bin/env bash
# One command, run in Google Cloud Shell (https://shell.cloud.google.com):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/gcp-free.sh)
#
# It creates (or reuses) a project, links billing, creates one always-free e2-micro VM
# (us-central1, 30 GB standard disk), finds your Telegram ID, installs Docker and starts
# the bot with its own PostgreSQL. Re-run it any time to update the bot or change the token.
#
# Optional overrides: GCP_PROJECT, GRAM_VM, GRAM_ZONE, GRAM_REF, BOT_TOKEN, ADMIN_IDS,
# GRAM_TIME_ZONE (e.g. Europe/Rome; times in chats are UTC otherwise).
set -euo pipefail

VM="${GRAM_VM:-gram-bot}"
REF="${GRAM_REF:-develop}"
RAW="https://raw.githubusercontent.com/Kukutx/gram/$REF/deploy"
# Only these regions are part of the e2-micro free tier.
ZONES=(${GRAM_ZONE:-us-central1-a us-central1-b us-central1-c us-central1-f us-west1-b us-west1-a us-east1-b us-east1-c})

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
if [[ -n "${GRAM_TIME_ZONE:-}" ]]; then # checked up front so a typo fails before anything is created
  [[ "$GRAM_TIME_ZONE" =~ ^[A-Za-z][A-Za-z0-9_+/-]*$ &&
    ( ! -d /usr/share/zoneinfo || -f "/usr/share/zoneinfo/$GRAM_TIME_ZONE" ) ]] ||
    die "GRAM_TIME_ZONE=$GRAM_TIME_ZONE 不是有效时区，例如 Europe/Rome 或 Asia/Shanghai。"
fi
ask() { local reply; read -r -p "$1" reply < /dev/tty; printf '%s' "$reply"; }
command -v gcloud >/dev/null || die 'Run this in Google Cloud Shell: https://shell.cloud.google.com'

# ── 1. Project and billing ─────────────────────────────────────────────────────
say '1/6 项目 (project)'
PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  PROJECT="gram-bot-$(date +%y%m%d)-$RANDOM"
  echo "创建新项目 $PROJECT"
  gcloud projects create "$PROJECT" --name='gram bot' --quiet
fi
gcloud config set project "$PROJECT" --quiet >/dev/null
echo "使用项目: $PROJECT"

if [[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != True ]]; then
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter='open=true' --format='value(name)' 2>/dev/null)
  [[ ${#ACCOUNTS[@]} -gt 0 ]] || die '还没有结算账号。打开 https://console.cloud.google.com/billing 开通免费试用（需要绑卡，免费额度内不扣费），然后重新运行这条命令。'
  echo "为项目绑定结算账号 ${ACCOUNTS[0]}"
  gcloud billing projects link "$PROJECT" --billing-account="${ACCOUNTS[0]}" --quiet >/dev/null
fi
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
gcloud services enable compute.googleapis.com --quiet
ZONE="$(gcloud compute instances list --filter="name=$VM" --format='value(zone.basename())' 2>/dev/null | head -n1)"

# ── 2. Bot token ───────────────────────────────────────────────────────────────
say '2/6 机器人 Token'
TOKEN="${BOT_TOKEN:-}"
KEEP=''
while true; do
  if [[ -z "$TOKEN" ]]; then
    hint='粘贴 BotFather 给你的 Token（输入时不显示），按回车: '
    [[ -n "$ZONE" ]] && hint='粘贴新的 Token（输入时不显示）；不换 Token 直接按回车: '
    read -r -s -p "$hint" TOKEN < /dev/tty; echo
  fi
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  if [[ -z "$TOKEN" && -n "$ZONE" ]]; then KEEP=1; break; fi
  ME="$(curl -fsS "https://api.telegram.org/bot$TOKEN/getMe" 2>/dev/null || true)"
  BOT_NAME="$(printf '%s' "$ME" | python3 -c 'import json,sys; print("@"+json.load(sys.stdin)["result"]["username"])' 2>/dev/null || true)"
  [[ -n "$BOT_NAME" ]] && break
  echo 'Token 无效，请重新复制（格式类似 123456789:AAE...）。'; TOKEN=''
done
[[ -n "$KEEP" ]] && { BOT_NAME='你的机器人'; echo '保留服务器上原来的 Token 和管理员。'; } || echo "机器人: $BOT_NAME"

# ── 3. Admin Telegram ID ───────────────────────────────────────────────────────
say '3/6 你的 Telegram ID（管理员）'
ADMINS="${ADMIN_IDS:-}"
if [[ -n "$KEEP" ]]; then
  echo '跳过（沿用原来的设置）。'
elif [[ -z "$ADMINS" ]]; then
  # A running bot would consume the update first; this is only for first setup.
  curl -fsS "https://api.telegram.org/bot$TOKEN/deleteWebhook" >/dev/null || true
  echo "现在打开 Telegram，给 $BOT_NAME 发送 /start。"
  for _ in $(seq 1 40); do
    ADMINS="$(curl -fsS "https://api.telegram.org/bot$TOKEN/getUpdates?timeout=3&allowed_updates=%5B%22message%22%5D" 2>/dev/null |
      python3 -c 'import json,sys
ids=[u["message"]["from"]["id"] for u in json.load(sys.stdin).get("result",[]) if u.get("message",{}).get("chat",{}).get("type")=="private"]
print(ids[-1] if ids else "")' 2>/dev/null || true)"
    [[ -n "$ADMINS" ]] && break
    sleep 2
  done
  [[ -n "$ADMINS" ]] || ADMINS="$(ask '没收到消息。请输入你的数字 Telegram ID（可用 @userinfobot 查询）: ')"
fi
if [[ -n "$ADMINS" ]]; then
  [[ "$ADMINS" =~ ^[0-9\ ,]+$ ]] || die "Telegram ID 应该是数字: $ADMINS"
  ADMINS="$(printf '%s' "$ADMINS" | tr -d ' ')"
  echo "管理员 ID: $ADMINS"
fi

# ── 4. Free-tier VM ────────────────────────────────────────────────────────────
say '4/6 免费服务器 (e2-micro)'
if [[ -z "$ZONE" ]]; then
  if ! gcloud compute networks describe default >/dev/null 2>&1; then
    gcloud compute networks create default --subnet-mode=auto --quiet
  fi
  if ! gcloud compute firewall-rules describe gram-allow-ssh >/dev/null 2>&1; then
    gcloud compute firewall-rules create gram-allow-ssh --network=default --allow=tcp:22 \
      --target-tags=gram --description='SSH for gram setup and updates' --quiet >/dev/null
  fi
  for zone in "${ZONES[@]}"; do
    echo "尝试在 $zone 创建 $VM ..."
    if gcloud compute instances create "$VM" --zone="$zone" \
      --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size=30GB --boot-disk-type=pd-standard --tags=gram \
      --no-service-account --no-scopes --quiet >/dev/null; then
      ZONE="$zone"; break
    fi
  done
  [[ -n "$ZONE" ]] || die '免费区域暂时没有可用机器，过一会儿再运行一次。'
else
  echo "已存在: $VM ($ZONE)，将更新机器人。"
fi
ssh_vm() {
  gcloud compute ssh "$VM" --zone="$ZONE" --quiet \
    --ssh-flag='-o ConnectTimeout=10' --ssh-flag='-o ServerAliveInterval=30' --command="$1"
}
echo '等待服务器启动...'
for _ in $(seq 1 30); do ssh_vm true >/dev/null 2>&1 && break; sleep 10; done
ssh_vm true >/dev/null || die '连不上服务器，稍后重新运行这条命令即可（会接着做）。'

# ── 5. Install ─────────────────────────────────────────────────────────────────
say '5/6 安装并启动（首次大约 15-25 分钟，请保持这个窗口打开）'
SETTINGS='BOT_MODE=polling\n'
[[ -n "$KEEP" ]] || SETTINGS+="BOT_TOKEN=$TOKEN\n"
[[ -n "$ADMINS" ]] && SETTINGS+="ADMIN_IDS=$ADMINS\n"
[[ -n "${GRAM_TIME_ZONE:-}" ]] && SETTINGS+="TIME_ZONE=$GRAM_TIME_ZONE\n"
printf '%b' "$SETTINGS" |
  ssh_vm 'sudo install -d -m 700 /etc/gram && sudo tee -a /etc/gram/env.install >/dev/null && sudo chmod 600 /etc/gram/env.install'
# The install runs as a systemd unit on the server, so a dropped Cloud Shell connection does
# not stop it; re-running this command just shows its progress again.
ssh_vm "sudo env RAW=$RAW GRAM_REF=$REF bash -s" <<'REMOTE' ||
set -uo pipefail
log=/var/log/gram-install.log status=/var/log/gram-install.status
if systemctl is-active --quiet gram-install; then
  echo '安装已经在进行中，继续显示进度...'
else
  rm -f "$status"
  # The query string skips GitHub's few-minute cache, so a fix pushed a moment ago is used.
  curl -fsSL "$RAW/server-install.sh?t=$(date +%s)" -o /root/gram-install.sh || exit 1
  : > "$log"
  systemd-run --quiet --collect --unit=gram-install --setenv=GRAM_REF="$GRAM_REF" \
    /bin/bash -c "bash /root/gram-install.sh > $log 2>&1; echo \$? > $status" || exit 1
fi
tail -n +1 -F "$log" 2>/dev/null & follower=$!
while [[ ! -s "$status" ]]; do sleep 3; done
sleep 1; kill "$follower" 2>/dev/null
exit "$(cat "$status")"
REMOTE
  die "安装没有完成（或连接断了）。重新运行同一条命令即可，会接着做。
日志: gcloud compute ssh $VM --zone=$ZONE --command='sudo tail -n 100 /var/log/gram-install.log'"

# ── 6. Cost guard ──────────────────────────────────────────────────────────────
say '6/6 费用提醒'
if gcloud services enable billingbudgets.googleapis.com --quiet >/dev/null 2>&1 &&
  ! gcloud billing budgets list --billing-account="$BILLING" --format='value(displayName)' 2>/dev/null | grep -qx gram-cost-alert; then
  gcloud billing budgets create --billing-account="$BILLING" --display-name=gram-cost-alert \
    --budget-amount=1 --threshold-rule=percent=0.01 --threshold-rule=percent=1.0 \
    --filter-projects="projects/$PROJECT" --quiet >/dev/null 2>&1 &&
    echo '已设置: 只要产生任何费用就给你发邮件。' || echo '（没能自动设置费用提醒，可以在 Billing → Budgets 里手动加一个 1 元的预算。）'
fi

cat <<DONE

✅ 完成！给 $BOT_NAME 发 /start 试试，再发 /help 看管理员命令。

以后要更新机器人或换 Token：重新运行同一条命令即可。
查看日志：gcloud compute ssh $VM --zone=$ZONE --command='cd /opt/gram && sudo docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 bot worker'
DONE
