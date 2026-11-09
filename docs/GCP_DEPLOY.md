# GCP 部署手册：Cloud Run + Cloud SQL + Memorystore + Secret Manager

> **v1.5 优先说明**：Redis 已可选（GCP_REDIS_ENABLED=0 为默认），Worker 无 Redis 时从 PostgreSQL 投递。新增必需 `GCP_METRICS_TOKEN_SECRET`，可选 Sentry/隐私联系配置；生产 Secret 版本必须为数字。首次创建、摘要晋级、验证 Job 和回滚规则以 [UPGRADE_1_5.md](UPGRADE_1_5.md) 为准。以下 Redis 资源和权限只在启用时需要。

**这是纯 grammY 方案**。Cloud Run 托管 Webhook，Cloud SQL 保存业务数据，Memorystore 保存 BullMQ 队列，独立 Cloud Run Worker Pool 发送管理员通知。GCP 为 Webhook 服务提供 HTTPS；无需再部署 Nginx/Caddy，也无需 Vercel 或 .NET。

此方案可能产生持续费用（尤其是 Cloud SQL、Memorystore 和常驻 Worker Pool）。根据你的预算自行选择实例类型。创建云资源和授权属于你的 GCP 账号操作；项目没有内置任何云凭据。

## 1. 前提

- 绑定计费账号的 GCP Project；安装并登录 `gcloud`。
- 启用 `run.googleapis.com`、`cloudbuild.googleapis.com`、`artifactregistry.googleapis.com`、`sqladmin.googleapis.com`、`secretmanager.googleapis.com`、`redis.googleapis.com`、`compute.googleapis.com`。
- 一个 Cloud SQL for PostgreSQL 实例（推荐 PostgreSQL 17），数据库名 `grammy_bot`，应用账号 `bot`。
- 一个 Memorystore for Redis 实例，和 Cloud Run 相同或邻近区域；记录内部 IP/端口。**必须将 `maxmemory-policy` 改为 `noeviction`**（默认 `volatile-lru`，不符合 BullMQ 队列要求）。
- 有权限的 Cloud Run 服务账号，至少包含 Cloud SQL Client 和对 **四个指定秘密** 的 Secret Manager Secret Accessor 权限。生产强烈建议运行身份和迁移身份分开，分别使用最小权限数据库账号。Cloud Build 服务账号还需要构建和 Artifact Registry 推送权限。
- 同网络下可用的 VPC / Subnet（启用 Cloud Run Direct VPC egress，至少满足区域 IP 范围要求）。
- Artifact Registry Docker repository，例如 `telegram-bots`。

官方文档：

- [Cloud Run 与 Cloud SQL](https://cloud.google.com/sql/docs/postgres/connect-run)
- [Cloud Run 与 Redis（Direct VPC egress）](https://cloud.google.com/memorystore/docs/redis/connect-redis-instance-cloud-run)
- [Cloud Run Secret Manager](https://cloud.google.com/run/docs/configuring/services/secrets)
- [Cloud Run Worker Pools](https://cloud.google.com/run/docs/deploy-worker-pools)

## 2. Secret Manager：必须是实际密钥

创建以下 Secret Manager Secrets（名字可自定义，但要同步修改 `.env.gcp`）。部署时建议固定数字版本，不要一直引用 `latest`：

| Secret                  | 内容                                      | 注意                              |
| ----------------------- | ----------------------------------------- | --------------------------------- |
| `grammy-bot-token`      | BotFather token                           | 不能提交 Git                      |
| `grammy-database-url`   | Cloud SQL PostgreSQL 连接串               | 用户名、URL 编码密码、Unix socket |
| `grammy-webhook-secret` | 随机 24–256 字符的 `[A-Za-z0-9_-]` 字符串 | 保护 Webhook                      |
| `grammy-redis-url`      | `redis://10.x.x.x:6379` 或 `rediss://...` | 用正确的内部 IP/TLS 配置          |

例如为本项目生成随机 Webhook 密钥：

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

**Cloud SQL Unix Socket URL（需 URL 编码特殊字符）**：

```text
postgresql://bot:URL_ENCODED_PASSWORD@localhost:5432/grammy_bot?host=%2Fcloudsql%2FPROJECT%3AREGION%3AINSTANCE
```

`PROJECT:REGION:INSTANCE` 必须换成真正的 `connectionName`。测试你环境下 `pg` 驱动和 Prisma Migrate CLI 都能连接这个地址；Cloud SQL unix socket 由 Cloud Run 的 `--add-cloudsql-instances` 提供。长密码中的 `@`、`:`、`/` 等要做 URL 编码。

可在 Cloud Shell 使用以下模式创建 Secret，避免把秘密作为命令参数写入 shell 历史：

```bash
gcloud secrets create grammy-bot-token --replication-policy=automatic
# 在 stdin 中输入内容，按 Ctrl+D 结束；其他三个 Secret 类似
gcloud secrets versions add grammy-bot-token --data-file=-
```

必须为运行身份设置适当 IAM，例如：

```bash
# 示例；替换 PROJECT_ID、SERVICE_ACCOUNT、SECRET 名称
# 为每个必要 Secret 单独授权，比全项目 Secret Accessor 更安全。
gcloud secrets add-iam-policy-binding grammy-bot-token \
  --member="serviceAccount:SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:SERVICE_ACCOUNT" \
  --role=roles/cloudsql.client
```

### Redis 队列策略（必须设置）

Google Memorystore for Redis 默认采用 `volatile-lru`，BullMQ 要求 `noeviction`。若是已有实例，请执行下面**显式的云端修改命令**，替换实例名称和区域：

```bash
gcloud redis instances update REDIS_INSTANCE --region=REGION \
  --update-redis-config=maxmemory-policy=noeviction
```

可通过 `gcloud redis instances describe REDIS_INSTANCE --region=REGION` 验证配置。应用的 `pnpm doctor` 同样会检查 `INFO memory` 中的 `maxmemory_policy`，而不调用 Memorystore 禁用的 `CONFIG` 命令。

## 3. 部署配置

在项目根目录：

```bash
cp .env.gcp.example .env.gcp
# 编辑 .env.gcp 中的项目、区域、服务账号、Redis 网络、Secret 名称和固定数字版本
bash scripts/gcp/deploy.sh
```

部署脚本会：

1. 使用 Cloud Build 构建并推送 Bot 镜像和独立 Migrator 镜像。
2. 用 Cloud Run Job 运行 `prisma migrate deploy`，保证首版 SQL schema 已部署。
3. 部署 Webhook Cloud Run 服务（公开 HTTPS、双层密钥校验、连接 Cloud SQL；配置独立的启动、存活和就绪探针）。
4. 部署 **独立 Worker Pool**（一个 Worker 实例，处理 BullMQ、扫描未通知反馈以补偿遗漏），避免 HTTP 服务的请求外后台任务丢失。
5. 输出 Cloud Run 服务 URL（不输出 Token/密码）。

`GCP_MIGRATOR_SERVICE_ACCOUNT` 和 `GCP_MIGRATION_DATABASE_URL_SECRET` 是可选的独立迁移身份与数据库密钥；设置后迁移不复用运行时的数据库 DML 凭据，属于生产推荐配置。具体权限仍需在 GCP 和 PostgreSQL 中预先创建。

如果你没有 Worker Pool 权限或该区域暂不支持，HTTP Bot 仍可继续运行，但 Redis 队列里的通知任务**不会被消费**；必须改用可持续运行的 Worker 进程，再开放通知能力。脚本把 Worker 部署失败视为整体部署失败，不会静默宣称成功。

## 4. 注册 Telegram Webhook

Webhook 注册是独立的显式步骤，避免在每次扩缩容时反复调用 Bot API。先在可信本地终端配置真实 `.env` 中的 `BOT_TOKEN`、`BOT_MODE=webhook`、`WEBHOOK_SECRET`（与 Secret Manager 一致），运行：

```bash
pnpm webhook:set -- https://YOUR_CLOUD_RUN_SERVICE_URL
pnpm commands:sync
```

脚本使用 Bot API `setWebhook`，包括 `secret_token`、`allowed_updates`、`max_connections`。云服务路由为 `/telegram/webhook`。Webhook 配置后，不能再用同一 Bot Token 启动本地 `pnpm dev`（Polling）。

## 5. 验证

```bash
curl -i https://YOUR_CLOUD_RUN_SERVICE_URL/live
curl -i https://YOUR_CLOUD_RUN_SERVICE_URL/ready
```

- `/live` 仅证明进程可响应；`/ready` 验证持久存储 PostgreSQL。Redis 不可用不会错误地使保存反馈的 Webhook 离线，但会通过诊断/日志/队列指标暴露。
- Telegram 私聊 `/start` `/feedback`；管理员 `/stats` `/feedbacks`。
- Redis Worker 若未运行，则反馈仍保存在 DB，通知任务会待处理。
- Cloud Logging 查看异常；Sentry 与 Prometheus 根据 `.env` 按需启用。

## 6. 发布与回滚

**发布顺序**：先数据库迁移，后应用服务，再 Worker；Schema 变更尽量采用 Expand → Migrate → Contract，确保旧版和新版可短暂并存。脚本每次构建唯一 UTC 时间镜像 Tag，回滚时可从 Cloud Run 指向较早的**兼容版本镜像**；不会自动回滚数据库迁移。

数据库应启用自动备份和 Point-in-time Recovery（PITR）。在生产使用管理员账号恢复数据前先测试备份恢复流程。运行时密码应按周期轮换并遵循最小权限。

> 本脚本依赖 Cloud CLI 的现行参数，请在正式发布前先在单独的 GCP 测试项目执行。不同账号的 IAM、组织策略、VPC 子网和资源配额无法在下载包内预先验证。

## v1.2 运营配置和 GitHub Actions

`GCP_RATE_LIMIT_PER_MINUTE` 默认 0（禁用）。按需设置正整数后配合既有 Redis 使所有 Cloud Run 实例共享计数。Redis 故障时自动降级为进程内限流。

`GCP_FEEDBACK_RETENTION_DAYS` 默认 0（禁用自动删除）。如果改为正整数，**独立 Worker** 每分钟批量删除达到期限的反馈，包含未通知反馈；请先评估保留义务和备份策略。脚本会把两个非秘密值注入 Bot/Worker 环境变量。

`scripts/gcp/deploy.sh` 既可读取本地 `.env.gcp`，也可以从已导出的 `GCP_*` 环境变量运行。新增 `.github/workflows/cd-gcp.yml` 使用后者实现 **GitHub Environment 审核后人工发布**，配合 GCP Workload Identity Federation。详见 [GITHUB_GCP_CI.md](GITHUB_GCP_CI.md)。

滚动发布 v1.2 时一定先应用 `prisma/migrations/20261012010000_delivery_lease_and_scan`；完整迁移指引参见 [UPGRADE_1_2.md](UPGRADE_1_2.md)。

## v1.3 生产发布锁文件门槛

生产 Docker 构建和 `scripts/gcp/deploy.sh` 强制要求仓库中存在**真实 `pnpm-lock.yaml`**。首次安装请在联网环境运行 `pnpm deps:lock` 并提交该文件；GitHub Actions 还提供手动执行的锁文件生成工作流。没有锁文件时发布会被明确拒绝。Webhook 容器在启动监听前先向 Telegram 调用 `getMe` 完成 grammY 初始化；若无效 Token 或暂时无法联系 Telegram，部署不应视为健康。详见 [RELEASE_POLICY.md](RELEASE_POLICY.md) 和 [UPGRADE_1_3.md](UPGRADE_1_3.md)。

## v1.4 新增操作提示

- 在执行 `pnpm webhook:set` 的受信任操作环境中，`WEBHOOK_MAX_CONNECTIONS` 默认 `1`；它只影响 Telegram 的注册配置，需要**重新执行 setWebhook** 才会应用。降低并行更新竞争，但不保证所有侧效应绝对有序。
- Worker 每十分钟检查最早未投递的反馈，积压年龄 >= 一小时时记严重日志，并且最多每小时通过 Sentry 发一次同类事件；将此日志关联 Cloud Monitoring 告警。
- 新的 GitHub CI 强制 `pnpm install --frozen-lockfile`，务必先提交由联网包管理器真实生成的锁文件。
- v1.4 没有新 SQL Schema 迁移；回滚依旧遵循“镜像回滚，数据库保持向前兼容”的流程。
