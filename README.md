# grammY Telegram Bot · v1.5.0

TypeScript / Node.js 24 / grammY / Fastify / PostgreSQL / Prisma。支持用户反馈、管理员处理与回复、隐私导出和删除，以及可恢复的异步通知。

默认推荐 **PostgreSQL + 独立 Bot/Worker 进程**。Redis/BullMQ 可选。后端平台选择与 Cloudflare Workers 的适配说明见 [BACKEND_CHOICE](docs/BACKEND_CHOICE.md)。

## 当前交付

- 用户：双语设置、反馈输入/取消、状态查询、资料与回复分页导出、一次性确认删除。
- 管理员：查看反馈、受理、回复、解决、结案、重新打开、投递重试/暂停/终止及状态诊断。
- 可靠性：数据库事务、命令回执与旧状态保护、发送租约、持久 Outbox、可选 BullMQ 加速、独立维护与有界关停。
- 观测：正文/凭据不进入异常日志或 Sentry，受保护的运行健康与 Prometheus 指标、外部告警模板。
- 发布：真实 pnpm 锁文件、质量门禁、3 次 SQL migration、Docker、GitHub Actions 和 GCP 发布/验证/恢复脚本。

这是可运行的单 Bot、单管理员反馈应用，不含支付或多租户系统。外部消息投递仍可能在发送成功但数据库确认失败的窗口重复。

## 本地运行

安装 Node.js 24、pnpm 10.21.0、Docker，并从 BotFather 创建独立测试 Bot。

```bash
cp .env.example .env
# 填写 BOT_TOKEN、DATABASE_URL；管理员功能填写 ADMIN_TELEGRAM_ID
# 不使用 Redis 时清空 REDIS_URL
docker compose up -d postgres
# Optional Redis accelerator: docker compose up -d redis
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm dev
# 第二个终端：通知、保留清理和心跳均由该进程负责
pnpm dev:worker
```

发送 `/help` 查看命令。完整受理、回复和结案用法见 [v1.5 使用及升级说明](docs/UPGRADE_1_5.md)。生产和测试必须使用不同 Bot Token；本地 polling 会删除当前 Token 的 Webhook。

## 验证

```bash
pnpm release:verify
pnpm audit --audit-level moderate
docker build -t grammy-bot:staging .
```

数据库/Redis 集成测试必须指向隔离资源，先迁移测试数据库，再设置 TEST_DATABASE_URL 和 TEST_REDIS_URL。`pnpm test:integration` 在缺少测试数据库配置时明确失败；普通单元测试允许跳过外部依赖测试。

```bash
TEST_DATABASE_URL=postgresql://... TEST_REDIS_URL=redis://... pnpm test:integration
```

本次实际完成与外部待验收事项见 [闭环验证记录](docs/CLOSURE_1_5.md)。此前 v1.4 审查结果保留在 [原始审查报告](docs/PROJECT_AUDIT_2026-11-06.md)，其中失败结果描述的是修复前状态。

## 部署和运维

生产运行两个进程：HTTP Bot（BOT_MODE=webhook）及独立 Worker。迁移作为独立步骤运行。即使不用 Redis，启用通知或保留策略时也必须运行 Worker。

- [GCP 部署](docs/GCP_DEPLOY.md)：Cloud Run + Cloud SQL；Worker Pool 常驻。先阅读 [v1.5 变更](docs/UPGRADE_1_5.md)。
- [运行手册](docs/OPERATIONS.md)：投递故障、外部告警、隐私请求和恢复。
- `/live` 检查进程，`/ready` 检查 PostgreSQL；`/ops/health` 和 `/metrics` 使用 METRICS_TOKEN 的 Bearer 鉴权。
- `pnpm ops:health`、`pnpm outbox:status` 查询运行状态；外部调度器可运行 `node scripts/probe-http.mjs`。
- [生产验收清单](docs/PRODUCTION_READINESS.md) 中云权限、报警接收、真实 Telegram 测试和备份恢复需要部署方完成。

不在源码、终端参数、URL 或日志中放真实 Token。配置通过环境变量或 Secret Manager 注入。
