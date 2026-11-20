# grammY Telegram 客服机器人

TypeScript / Node.js 24 / grammY / Fastify / PostgreSQL / Prisma。用户在私聊里提交问题（文字或附件），客服在私聊或客服群里回复，双方可以多轮往来；所有发出的消息都经过 PostgreSQL 发件箱，可重试、可追踪。

运行只需要 **PostgreSQL + Bot 进程 + Worker 进程**。Redis 可选，只用于多实例共享限流。

## 功能

- 用户：`/feedback` 提交（或 `INTAKE_MODE=direct` 直接发消息），支持图片、文件、语音、视频等；「回复」客服消息即可补充；`/my_feedbacks`、`/ticket <编号>` 查看进度；中英双语；资料导出与一次性确认删除。
- 客服：多个管理员（`ADMIN_IDS`）或一个客服群（`ADMIN_CHAT_ID`），群可开「每个工单一个话题」（`ADMIN_USE_TOPICS`）。直接回复通知或在话题里打字就是回复用户；通知带「受理 / 已解决 / 结案」按钮。
- 管理命令：`/tickets`（分页筛选）、`/ticket`、`/search`、`/reply`、`/assign`、`/resolve`、`/close`、`/reopen`、`/set_status`、`/ban`、`/unban`、`/deliveries`、`/delivery`、`/stats`、`/status`。工单用短编号 `#12`，在话题里或回复通知时可省略。
- 可靠性：命令回执与按用户串行化防重放；发件箱按聊天保序、跨聊天并行，`LISTEN/NOTIFY` 即时唤醒，指数退避重试，永久失败停放待人工处理。
- 观测：日志和 Sentry 不含消息正文与凭据；`/live`、`/ready`、受保护的 `/ops/health` 与 Prometheus `/metrics`。

外部消息投递在「Telegram 已发送、数据库确认前进程崩溃」的窗口仍可能重复一次，这是 Telegram API 的限制。

## 本地运行

安装 Node.js 24、pnpm 10.21.0、Docker，并从 BotFather 创建一个测试用 Bot。

```bash
cp .env.example .env
# 填写 BOT_TOKEN、DATABASE_URL；把自己的 Telegram ID 填进 ADMIN_IDS（给机器人发 /id 可查）
docker compose up -d postgres
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm dev
# 第二个终端：所有消息发送、保留清理和心跳都由 Worker 负责
pnpm dev:worker
pnpm doctor   # 自检：数据库、迁移、Telegram、客服群权限
```

发送 `/help` 查看命令。生产和测试必须使用不同 Bot Token；本地 polling 会删除当前 Token 的 Webhook。

### 使用客服群

1. 建一个超级群，把机器人拉进去并设为管理员（话题模式还需开启群「话题」并给机器人「管理话题」权限）。
2. 在群里发 `/id` 拿到群 ID（负数），填入 `ADMIN_CHAT_ID`；需要话题时设 `ADMIN_USE_TOPICS=true`。
3. 群里所有成员都能处理工单，只拉信任的客服进群。运行 `pnpm commands:sync` 让群里显示管理命令菜单。

## 验证

```bash
pnpm release:verify
pnpm audit --audit-level moderate
docker build -t grammy-bot:staging .
```

集成测试必须指向一个隔离、已迁移的测试数据库；`pnpm test:integration` 缺少配置时会直接失败。

```bash
DATABASE_URL=postgresql://.../grammy_test pnpm db:deploy
TEST_DATABASE_URL=postgresql://.../grammy_test pnpm test:integration
```

## 部署

生产环境运行 Bot 和 Worker 两个进程，迁移单独执行。Worker 负责发送所有消息，必须一直运行。

- **完全免费的云服务器**：在 Oracle Cloud Shell 运行 `bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/oracle-free.sh)`，见 [Oracle 永久免费服务器一键部署](docs/DEPLOY.md#oracle-永久免费服务器一键部署)。
- **Google Cloud 免费服务器**（公网 IP 约 3.6 美元/月）：打开 [Cloud Shell](https://shell.cloud.google.com) 运行 `bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/gcp-free.sh)`，按提示粘贴 Token 即可，见 [GCP 免费服务器一键部署](docs/DEPLOY.md#gcp-免费服务器一键部署)。
- **任意一台服务器**：填好 `.env` 后运行 `bash deploy/up.sh`。这一步会完成构建、迁移、启动和自检，默认 polling 模式，不需要域名。详见 [部署指南](docs/DEPLOY.md)，其中包括 webhook + 自动 HTTPS、备份恢复、从 v1.5 升级和上线检查清单。
- **Google Cloud**：Cloud Run + Cloud SQL，支持 GitHub Actions 审批发布，见 [GCP_DEPLOY.md](docs/GCP_DEPLOY.md)。
- **其他平台**：使用同一个 Dockerfile，见 [部署指南](docs/DEPLOY.md#选哪种方式)。

## 文档

- [架构](docs/ARCHITECTURE.md)：数据模型、更新处理顺序、发件箱与并发、目录结构、扩展方式。
- [运维手册](docs/OPERATIONS.md)：健康检查、客服日常、发送失败处理、隐私请求、常见问题。
- [安全](docs/SECURITY.md)、[个人数据导出](docs/PRIVACY_EXPORT.md)、[发布与依赖锁定](docs/RELEASE_POLICY.md)。
- v1.x 历史文档在 [docs/history](docs/history/README.md)。

不要把真实 Token 放进源码、命令行参数、URL 或日志。所有配置都通过环境变量或 Secret Manager 注入。
