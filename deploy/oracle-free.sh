#!/usr/bin/env bash
# One command, run in Oracle Cloud Shell (Oracle Cloud console → the >_ icon at the top right):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/oracle-free.sh)
#
# It creates (or reuses) a network and one Always Free server in your home region
# (Ampere A1: 2 OCPUs, 12 GB; falls back to the 1 GB AMD micro if Arm capacity is out),
# finds your Telegram ID, installs Docker and starts the bot with its own PostgreSQL.
# Re-run it any time to update the bot or change the token.
#
# Optional overrides: OCI_TENANCY, GRAM_VM, GRAM_REF, GRAM_OCPUS, GRAM_MEMORY_GB, BOT_TOKEN, ADMIN_IDS.
set -euo pipefail

VM="${GRAM_VM:-gram-bot}"
REF="${GRAM_REF:-develop}"
RAW="https://raw.githubusercontent.com/Kukutx/gram/$REF/deploy"
OCPUS="${GRAM_OCPUS:-2}"
MEMORY_GB="${GRAM_MEMORY_GB:-12}"
KEY="$HOME/.ssh/gram_oci"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
ask() { local reply; read -r -p "$1" reply < /dev/tty; printf '%s' "$reply"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
command -v oci >/dev/null || die 'Run this in Oracle Cloud Shell: Oracle Cloud console → the >_ icon at the top right.'

# ── 1. Account and network ─────────────────────────────────────────────────────
say '1/6 账号和网络'
# Cloud Shell's CLI is pre-authenticated; its config file names the tenancy for each region profile.
TENANCY="${OCI_TENANCY:-$(python3 -c 'import configparser, sys
c = configparser.ConfigParser(); c.read(sys.argv[1])
section = sys.argv[2] if c.has_section(sys.argv[2]) else (c.sections() or ["DEFAULT"])[0]
print(c.get(section, "tenancy", fallback=c.defaults().get("tenancy", "")))' \
  "${OCI_CLI_CONFIG_FILE:-/etc/oci/config}" "${OCI_CLI_PROFILE:-DEFAULT}" 2>/dev/null || true)}"
[[ "$TENANCY" == ocid1.tenancy.* ]] || die '找不到账号信息。请在 Oracle Cloud 网页右上角的 >_ Cloud Shell 里运行（或设置 OCI_TENANCY）。'
# Always Free servers exist only in the home region, whatever region the console shows.
HOME_REGION="$(oci iam region-subscription list --tenancy-id "$TENANCY" 2>/dev/null |
  json 'print(next((r["region-name"] for r in d["data"] if r.get("is-home-region")),""))' 2>/dev/null || true)"
[[ -n "$HOME_REGION" ]] && export OCI_CLI_REGION="$HOME_REGION"
echo "主区域: ${HOME_REGION:-（未知，使用当前区域）}"

INSTANCE="$(oci compute instance list -c "$TENANCY" --display-name "$VM" --all 2>/dev/null |
  json 'print(next((i["id"] for i in d.get("data",[]) if i["lifecycle-state"] in ("RUNNING","STARTING","PROVISIONING","STOPPED","STOPPING")),""))' 2>/dev/null || true)"

VCN="$(oci network vcn list -c "$TENANCY" --display-name gram-vcn --lifecycle-state AVAILABLE 2>/dev/null |
  json 'print(d["data"][0]["id"] if d.get("data") else "")' 2>/dev/null || true)"
if [[ -z "$VCN" ]]; then
  echo '创建网络 gram-vcn ...'
  VCN="$(oci network vcn create -c "$TENANCY" --cidr-blocks '["10.0.0.0/16"]' --display-name gram-vcn \
    --dns-label gram --wait-for-state AVAILABLE 2>/dev/null | json 'print(d["data"]["id"])')"
fi
SUBNET="$(oci network subnet list -c "$TENANCY" --vcn-id "$VCN" --display-name gram-subnet 2>/dev/null |
  json 'print(d["data"][0]["id"] if d.get("data") else "")' 2>/dev/null || true)"
if [[ -z "$SUBNET" ]]; then
  ROUTES="$(oci network vcn get --vcn-id "$VCN" | json 'print(d["data"]["default-route-table-id"])')"
  GATEWAY="$(oci network internet-gateway create -c "$TENANCY" --vcn-id "$VCN" --is-enabled true \
    --display-name gram-igw --wait-for-state AVAILABLE 2>/dev/null | json 'print(d["data"]["id"])')"
  oci network route-table update --rt-id "$ROUTES" --force --wait-for-state AVAILABLE \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$GATEWAY\"}]" >/dev/null
  # The VCN's default security list allows SSH in and everything out, which is all polling needs.
  SUBNET="$(oci network subnet create -c "$TENANCY" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 \
    --display-name gram-subnet --dns-label bot --wait-for-state AVAILABLE 2>/dev/null | json 'print(d["data"]["id"])')"
fi
echo '网络已就绪。'

# ── 2. Bot token ───────────────────────────────────────────────────────────────
say '2/6 机器人 Token'
TOKEN="${BOT_TOKEN:-}"
KEEP=''
while true; do
  if [[ -z "$TOKEN" ]]; then
    hint='粘贴 BotFather 给你的 Token（输入时不显示），按回车: '
    [[ -n "$INSTANCE" ]] && hint='粘贴新的 Token（输入时不显示）；不换 Token 直接按回车: '
    read -r -s -p "$hint" TOKEN < /dev/tty; echo
  fi
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  if [[ -z "$TOKEN" && -n "$INSTANCE" ]]; then KEEP=1; break; fi
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

# ── 4. Always Free server ──────────────────────────────────────────────────────
say '4/6 免费服务器'
# Oracle Cloud Shell runs in FIPS mode, which rejects ed25519 keys; RSA works everywhere.
[[ -f "$KEY" && -f "$KEY.pub" ]] || { mkdir -p "$HOME/.ssh" && rm -f "$KEY" "$KEY.pub" &&
  ssh-keygen -q -t rsa -b 4096 -N '' -C gram -f "$KEY"; }
latest_ubuntu() { # latest_ubuntu SHAPE: newest Ubuntu 24.04 image for that shape (Arm or x86)
  oci compute image list -c "$TENANCY" --operating-system 'Canonical Ubuntu' --operating-system-version 24.04 \
    --shape "$1" --sort-by TIMECREATED --sort-order DESC --all 2>/dev/null |
    json 'print(next((i["id"] for i in d.get("data",[]) if "Minimal" not in i["display-name"]),""))'
}
launch() { # launch SHAPE AD [SHAPE_CONFIG]: prints the instance id, or the error on stderr
  local image out
  image="$(latest_ubuntu "$1")"; [[ -n "$image" ]] || { echo '找不到 Ubuntu 镜像' >&2; return 1; }
  out="$(oci compute instance launch -c "$TENANCY" --availability-domain "$2" --shape "$1" ${3:+--shape-config "$3"} \
    --image-id "$image" --subnet-id "$SUBNET" --assign-public-ip true --display-name "$VM" \
    --boot-volume-size-in-gbs 50 --ssh-authorized-keys-file "$KEY.pub" \
    --wait-for-state RUNNING --max-wait-seconds 900 2>&1)" || { printf '%s\n' "$out" | { grep -m1 '"message"' || tail -n1; } >&2; return 1; }
  printf '%s' "$out" | sed -n '/^{/,$p' | json 'print(d["data"]["id"])'
}
if [[ -z "$INSTANCE" ]]; then
  mapfile -t ADS < <(oci iam availability-domain list -c "$TENANCY" | json 'print("\n".join(a["name"] for a in d["data"]))')
  for ad in "${ADS[@]}"; do
    echo "尝试 Arm 服务器（${OCPUS} 核 ${MEMORY_GB} GB）: $ad ..."
    INSTANCE="$(launch VM.Standard.A1.Flex "$ad" "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}")" && break || INSTANCE=''
  done
  if [[ -z "$INSTANCE" ]]; then
    for ad in "${ADS[@]}"; do
      echo "Arm 暂时没有空闲，改用 1 GB 的 AMD 免费机器: $ad ..."
      INSTANCE="$(launch VM.Standard.E2.1.Micro "$ad")" && break || INSTANCE=''
    done
  fi
  [[ -n "$INSTANCE" ]] || die '免费服务器暂时都没有空闲（Oracle 常见情况）。过一两个小时再运行同一条命令即可。'
else
  echo "已存在: $VM，将更新机器人。"
  oci compute instance action --instance-id "$INSTANCE" --action START --wait-for-state RUNNING >/dev/null 2>&1 || true
fi
IP="$(oci compute instance list-vnics --instance-id "$INSTANCE" | json 'print(d["data"][0].get("public-ip") or "")')"
[[ -n "$IP" ]] || die '服务器没有公网 IP。'
echo "服务器 IP: $IP"
ssh_vm() {
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/gram_known_hosts" \
    -o ConnectTimeout=10 -o ServerAliveInterval=30 -o BatchMode=yes "ubuntu@$IP" "$1"
}
echo '等待服务器启动...'
for _ in $(seq 1 30); do ssh_vm true >/dev/null 2>&1 && break; sleep 10; done
ssh_vm true >/dev/null || die "连不上服务器。稍后重新运行这条命令即可（会接着做）。
如果是换了 Cloud Shell 导致钥匙丢失，需要在控制台删除 $VM 后重新运行。"

# ── 5. Install ─────────────────────────────────────────────────────────────────
say '5/6 安装并启动（首次大约 10-20 分钟，请保持这个窗口打开）'
SETTINGS='BOT_MODE=polling\n'
[[ -n "$KEEP" ]] || SETTINGS+="BOT_TOKEN=$TOKEN\n"
[[ -n "$ADMINS" ]] && SETTINGS+="ADMIN_IDS=$ADMINS\n"
# Off-server backups: a private bucket (Always Free Object Storage) and a write-only link that
# the server's daily backup uploads to. A reclaimed or broken server then loses no data.
# The link is shown only once, so it is (re)created only when the server does not have it yet.
if ! ssh_vm 'sudo grep -q "^BACKUP_UPLOAD_URL=" /opt/gram/.env' 2>/dev/null; then
  NS="$(oci os ns get -c "$TENANCY" 2>/dev/null | json 'print(d["data"])' 2>/dev/null || true)"
  if [[ -n "$NS" ]]; then
    oci os bucket get -ns "$NS" -bn gram-backups >/dev/null 2>&1 ||
      oci os bucket create -ns "$NS" -c "$TENANCY" --name gram-backups >/dev/null 2>&1 || true
    for par in $(oci os preauth-request list -ns "$NS" -bn gram-backups --all 2>/dev/null |
      json 'print(" ".join(p["id"] for p in d.get("data",[]) if p["name"]=="gram-backup-upload"))' 2>/dev/null); do
      oci os preauth-request delete -ns "$NS" -bn gram-backups --par-id "$par" --force >/dev/null 2>&1 || true
    done
    UPLOAD="$(oci os preauth-request create -ns "$NS" -bn gram-backups --name gram-backup-upload \
      --access-type AnyObjectWrite --time-expires "$(date -u -d '+10 years' +%Y-%m-%dT00:00:00Z)" 2>/dev/null |
      json 'p=d["data"]; print(p.get("full-path") or "https://objectstorage.'"${OCI_CLI_REGION:-${OCI_REGION:-}}"'.oraclecloud.com"+p["access-uri"])' 2>/dev/null || true)"
    if [[ "$UPLOAD" == https://* ]]; then
      SETTINGS+="BACKUP_UPLOAD_URL=$UPLOAD\n"
      echo '每日备份会另外保存一份到 Oracle 存储桶 gram-backups。'
    fi
  fi
fi
printf '%b' "$SETTINGS" |
  ssh_vm 'sudo install -d -m 700 /etc/gram && sudo tee /etc/gram/env.install >/dev/null && sudo chmod 600 /etc/gram/env.install'
# The install runs as a systemd unit on the server, so a dropped Cloud Shell connection does
# not stop it; re-running this command just shows its progress again.
ssh_vm "sudo env RAW=$RAW GRAM_REF=$REF bash -s" <<'REMOTE' ||
set -uo pipefail
log=/var/log/gram-install.log status=/var/log/gram-install.status
if systemctl is-active --quiet gram-install; then
  echo '安装已经在进行中，继续显示进度...'
else
  rm -f "$status"
  curl -fsSL "$RAW/server-install.sh" -o /root/gram-install.sh || exit 1
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
日志: ssh -i $KEY ubuntu@$IP sudo tail -n 100 /var/log/gram-install.log"

# ── 6. Cost guard ──────────────────────────────────────────────────────────────
say '6/6 费用提醒'
if ! oci budgets budget budget list -c "$TENANCY" --all 2>/dev/null | grep -q '"display-name": "gram-cost-alert"'; then
  BUDGET="$(oci budgets budget budget create -c "$TENANCY" --amount 1 --reset-period MONTHLY \
    --target-type COMPARTMENT --targets "[\"$TENANCY\"]" --display-name gram-cost-alert 2>/dev/null |
    json 'print(d["data"]["id"])' 2>/dev/null || true)"
  EMAIL="$(oci iam user get --user-id "${OCI_CS_USER_OCID:-none}" 2>/dev/null | json 'print(d["data"].get("email") or "")' 2>/dev/null || true)"
  if [[ -n "$BUDGET" && -n "$EMAIL" ]] &&
    oci budgets budget alert-rule create --budget-id "$BUDGET" --type ACTUAL --threshold 0.01 \
      --threshold-type ABSOLUTE --recipients "$EMAIL" --display-name any-charge >/dev/null 2>&1; then
    echo "已设置: 只要产生任何费用就发邮件到 $EMAIL。"
  else
    echo '（没能自动设置邮件提醒。免费账号本身不会扣费；升级为按量付费后，可在 Billing → Budgets 里加一个提醒。）'
  fi
fi

cat <<DONE

✅ 完成！给 $BOT_NAME 发 /start 试试，再发 /help 看管理员命令。

以后要更新机器人或换 Token：重新运行同一条命令即可。
查看日志：ssh -i $KEY ubuntu@$IP "cd /opt/gram && sudo docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 bot worker"
DONE
