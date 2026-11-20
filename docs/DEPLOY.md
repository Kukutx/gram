# 部署

机器人由三部分组成，任何能跑 Docker 或 Node.js 24 的地方都能部署：

| 组件       | 作用                                                         | 数量                    |
| ---------- | ------------------------------------------------------------ | ----------------------- |
| PostgreSQL | 唯一的数据源：用户、工单、消息、发件箱                       | 1（14 及以上，推荐 17） |
| Bot        | 接收 Telegram 更新（polling 或 webhook），写数据库后立即返回 | polling 只能 1 个       |
| Worker     | 发送所有消息、清理过期数据、写心跳                           | 1 个即可，多个也安全    |
| 迁移       | `prisma migrate deploy`，每次升级先跑一次                    | 一次性任务              |

Redis 可选，只在多个 Bot 实例需要共享限流时使用。

## 选哪种方式

- **一台服务器（VPS、家里的机器、云主机）**：用下面的 Docker Compose，一条命令完成。默认 polling 模式，不需要域名、不开放端口。
- **Google Cloud（Cloud Run + Cloud SQL）**：见 [GCP_DEPLOY.md](GCP_DEPLOY.md)，带 GitHub Actions 审批发布。
- **其他平台（Railway、Fly.io、Render、Kubernetes 等）**：用同一个 Dockerfile。镜像 target `runtime` 跑 Bot（`node dist/index.js`）和 Worker（`node dist/worker.js`），target `migrations` 跑迁移；环境变量见 [.env.example](../.env.example)。平台的连接池如果是事务模式（PgBouncer、Supabase pooler），设 `OUTBOX_LISTEN=false`。

## Docker Compose（任意服务器）

需要 Docker 24+ 和 Compose v2。

```bash
git clone https://github.com/Kukutx/gram.git && cd gram
cp .env.example .env
```

编辑 `.env`，至少填：

```dotenv
BOT_TOKEN=从 BotFather 获取
POSTGRES_PASSWORD=一个随机密码       # openssl rand -hex 24
ADMIN_IDS=你的 Telegram ID          # 给机器人发 /id 可查
```

然后：

```bash
bash deploy/up.sh
```

脚本会构建镜像、启动 PostgreSQL、执行迁移、启动 Bot 和 Worker（等到健康检查通过）、同步命令菜单，最后运行自检 `doctor`，每项显示 PASS/FAIL。之后给机器人发 `/start` 试一下。

升级：`git pull && bash deploy/up.sh`。迁移总是先跑，失败时 Bot 和 Worker 不会用新版本启动。

### Webhook 模式（可选）

polling 已经够用；有域名、想要更低延迟或多实例时再用 webhook。在 `.env` 里加上：

```dotenv
BOT_MODE=webhook
DOMAIN=bot.example.com
PUBLIC_URL=https://bot.example.com
WEBHOOK_SECRET=随机串        # openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
```

把域名解析到服务器并开放 80/443 端口，再运行 `bash deploy/up.sh`。脚本会多启动一个 Caddy，自动申请 HTTPS 证书，只对外暴露 webhook 路径，并向 Telegram 注册 webhook。

### 使用已有的数据库

在 `.env` 设置 `EXTERNAL_DATABASE_URL=postgresql://...`，Bot、Worker 和迁移都会连它。自带的 postgres 容器仍会启动（`POSTGRES_PASSWORD` 仍需填写），但不再使用。

### 备份与恢复

```bash
bash deploy/backup.sh                 # 写入 deploy/backups/，默认保留最近 14 份（KEEP=30 可改）
# 每天 3:15 自动备份：
# 15 3 * * * cd /srv/gram && bash deploy/backup.sh
```

恢复（会覆盖当前数据，先停 Worker，避免把恢复出的待发消息重复发送）：

```bash
docker compose --env-file .env -f deploy/compose.yaml stop worker
gunzip -c deploy/backups/<文件>.sql.gz | docker compose --env-file .env -f deploy/compose.yaml exec -T postgres psql -U bot -d grammy_bot
docker compose --env-file .env -f deploy/compose.yaml start worker
```

备份要再复制到服务器以外的地方。恢复后，先重新执行备份时间点之后用户提出的删除请求（见 [OPERATIONS.md](OPERATIONS.md)）。

### 日常命令

```bash
alias gram='docker compose --env-file .env -f deploy/compose.yaml'
gram ps                                   # 状态与健康
gram logs -f bot worker                   # 日志（不含消息正文）
gram run --rm --no-deps bot node dist/cli/doctor.js         # 自检
gram run --rm --no-deps bot node dist/cli/outbox-status.js  # 发件箱统计
gram restart worker
```

## 设置客服群（可选）

1. 新建超级群，把机器人拉进去并设为**管理员**。不是管理员的话，机器人看不到群里的普通回复。
2. 想要每个工单一个话题：在群设置里开启「话题」，并给机器人「管理话题」权限。
3. 在群里发 `/id`，把负数群 ID 填到 `ADMIN_CHAT_ID`。需要话题时设 `ADMIN_USE_TOPICS=true`。重新部署。
4. 群里**所有成员**都可以处理工单，只拉信任的客服进群。`ADMIN_IDS` 里的人在私聊中也能使用管理命令。
5. `doctor` 会检查群是否可达、机器人是否为管理员、话题是否开启以及权限是否足够。

## 从 v1.5 升级

1. 备份数据库。
2. 停掉旧 Worker。旧 Worker 不认识新表，必须在迁移前停掉。
3. 执行迁移（Compose 部署时 `up.sh` 会自动执行）。迁移会把每条反馈转成一个工单，把管理员回复转成工单消息，把未送达的通知和回复转成待发消息，并保留操作历史。旧的反馈 ID 仍然可以用来查找工单。
4. 启动新版本的 Bot 和 Worker。Worker 启动时会把旧的未送达管理员通知分发给当前配置的管理员或客服群。
5. `ADMIN_TELEGRAM_ID` 仍然有效，但建议改成 `ADMIN_IDS`。`REDIS_URL` 现在只用于限流，不用限流时可以删掉。

## 上线检查清单

- [ ] `doctor` 全部 PASS；`/start`、`/feedback`、客服回复、用户再回复、结案通知都在真实 Telegram 里走通一遍。
- [ ] 生产和测试使用不同的 Bot Token，`.env` 不进 Git（`.gitignore` 已包含）。
- [ ] 设置了 `SUPPORT_CONTACT`，需要时设置 `PRIVACY_POLICY_URL`。`FEEDBACK_RETENTION_DAYS` 是有意选择的值。
- [ ] 每天自动备份，并且至少做过一次恢复演练。
- [ ] 外部监控每分钟检查 `/ops/health`（需要 `METRICS_TOKEN`），或用 `scripts/probe-http.mjs`。停掉 Worker 演练一次，确认告警能送到人。
- [ ] 服务器磁盘、内存告警；Docker 日志已限制大小（compose 中每个服务最多 50 MB）。
