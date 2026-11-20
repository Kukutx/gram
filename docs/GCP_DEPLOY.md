# GCP 部署：Cloud Run + Cloud SQL + Secret Manager

Bot 跑在 Cloud Run 服务上（webhook 模式，HTTPS 由 GCP 提供），Worker 跑在常驻的 Cloud Run Worker Pool 上，数据在 Cloud SQL for PostgreSQL，密钥在 Secret Manager。Memorystore Redis 可选，只用于多实例共享限流，默认不启用。

这些资源会持续计费，费用主要来自 Cloud SQL 和常驻 Worker Pool。只有一台机器的话，[Docker Compose 部署](DEPLOY.md) 更简单也更便宜。

## 1. 准备资源

- 绑定了结算账号的项目，并已登录 `gcloud`。
- 启用以下 API：`run`、`cloudbuild`、`artifactregistry`、`sqladmin`、`secretmanager`、`compute`。使用 Redis 时还要启用 `redis`。
- Cloud SQL for PostgreSQL（推荐 17），数据库 `grammy_bot`，以及一个应用账号。建议另建一个只用于迁移的账号。
- Artifact Registry Docker 仓库，例如 `telegram-bots`。
- Cloud Run 运行服务账号，授予 Cloud SQL Client 角色，并对下列每个 Secret 单独授予 Secret Accessor。
- 一个可用于 Direct VPC egress 的 VPC 和子网。

## 2. Secret Manager

| Secret（名字可自定）    | 内容                                              |
| ----------------------- | ------------------------------------------------- |
| `grammy-bot-token`      | BotFather Token                                   |
| `grammy-database-url`   | Cloud SQL 连接串（见下）                          |
| `grammy-webhook-secret` | 24–256 位 `[A-Za-z0-9_-]` 随机串                  |
| `grammy-metrics-token`  | 24 位以上随机串，保护 `/ops/health` 与 `/metrics` |
| `grammy-redis-url`      | 仅在 `GCP_REDIS_ENABLED=1` 时需要                 |

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'       # 生成随机串
gcloud secrets create grammy-bot-token --replication-policy=automatic
gcloud secrets versions add grammy-bot-token --data-file=-  # 从 stdin 输入，Ctrl+D 结束
```

Cloud SQL 的 Unix socket 连接串（密码中的特殊字符需要 URL 编码）：

```text
postgresql://bot:URL_ENCODED_PASSWORD@localhost:5432/grammy_bot?host=%2Fcloudsql%2FPROJECT%3AREGION%3AINSTANCE
```

Unix socket 连接是会话连接，Worker 的 `LISTEN/NOTIFY` 可以正常工作。如果改用事务模式的连接池，请设 `OUTBOX_LISTEN=false`。

## 3. 部署

```bash
cp .env.gcp.example .env.gcp
# 填写项目、区域、服务账号、网络、Secret 名称及数字版本、GCP_ADMIN_IDS / GCP_ADMIN_CHAT_ID
bash scripts/gcp/deploy.sh
```

脚本按以下顺序执行，任何一步失败都会自动恢复上一版服务和 Worker 配置：

1. Cloud Build 构建 Bot 镜像和迁移镜像，并解析成不可变的摘要。
2. 用 Cloud Run Job 执行 `prisma migrate deploy`。
3. 部署 webhook 服务：公开 HTTPS，配置启动、存活和就绪探针。
4. 部署 Worker Pool（1 个实例，执行 `node dist/worker.js`）。
5. 运行验证 Job：检查 webhook 地址与运行健康（Worker 心跳等）。
6. 写出 `deployment-record.json`，包含镜像、上一版镜像和状态（prepared / failed / bootstrap / verified）。

Secret 必须固定为数字版本。首次部署还没有注册 webhook，先设 `GCP_BOOTSTRAP=1`，注册之后改回 0 再部署一次。

## 4. 注册 webhook 与命令菜单

在可信的本地终端里，`.env` 填入相同的 `BOT_TOKEN`、`WEBHOOK_SECRET` 和 `ADMIN_IDS` / `ADMIN_CHAT_ID`，然后执行：

```bash
pnpm webhook:set -- https://YOUR_SERVICE_URL
pnpm commands:sync
pnpm doctor          # 也可以在 Cloud Run Job 中执行 node dist/cli/doctor.js
```

## 5. 验证

- `curl https://YOUR_SERVICE_URL/ready` 返回 200。
- `curl -H "Authorization: Bearer $METRICS_TOKEN" https://YOUR_SERVICE_URL/ops/health`，确认 `healthy: true`。
- 在 Telegram 里走一遍：`/start` → `/feedback` → 管理员收到通知 → 回复 → 用户收到回复 → 点「已解决」。

## 可选设置（`.env.gcp`）

| 变量                              | 默认      | 说明                                                       |
| --------------------------------- | --------- | ---------------------------------------------------------- |
| `GCP_ADMIN_IDS`                   | —         | 管理员 ID，空格分隔（旧名 `GCP_ADMIN_TELEGRAM_ID` 仍可用） |
| `GCP_ADMIN_CHAT_ID`               | —         | 客服群 ID（负数）                                          |
| `GCP_ADMIN_USE_TOPICS`            | `false`   | 每个工单一个话题                                           |
| `GCP_INTAKE_MODE`                 | `command` | `direct`：用户直接发消息即可                               |
| `GCP_DEFAULT_LANGUAGE`            | `zh`      | `zh` 或 `en`                                               |
| `GCP_RATE_LIMIT_PER_MINUTE`       | `0`       | 每用户每分钟请求数上限；多实例共享需要 Redis               |
| `GCP_FEEDBACK_RETENTION_DAYS`     | `0`       | 工单无活动多少天后删除；0 表示永不删除                     |
| `GCP_MIGRATOR_SERVICE_ACCOUNT` 等 | —         | 迁移专用身份与数据库账号（推荐）                           |

GitHub Actions 审批发布（Workload Identity Federation，不使用 JSON 密钥）见 [GITHUB_GCP_CI.md](GITHUB_GCP_CI.md)。

## 发布与回滚

迁移只向前兼容；回滚时把服务和 Worker 指回较早的兼容镜像，数据库不回滚。Cloud SQL 开启自动备份和 PITR，并定期做恢复演练。
