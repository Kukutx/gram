# Changelog

## v1.5.0 — 2026-11-09

- 修复 ioredis/NodeNext、Fastify unknown 错误类型、Webhook URL 可选性、Vitest matcher 和 ESLint；生成真实 pnpm 锁文件并修复 minimatch 开发依赖公告。
- 错误日志使用白名单；Sentry 丢弃原始异常、请求、正文、身份、标签与上下文。
- 新增事务命令回执和按用户并发控制；删除确认升级为可撤销、一次性数据库挑战，回调应答失败不再阻断数据删除。
- 新增反馈受理、回复 Outbox、解决、结案、重新打开、状态查询、投递人工处置和回复导出；数据删除级联覆盖回复及历史。
- Worker 支持 PostgreSQL-only，Redis 为可选加速；维护独立运行，增加有界关停、版本心跳、受保护健康检查及外部告警模板。
- 新增第三次 SQL migration；升级前先迁移，启用新投递状态前停止旧 Worker。详情见 UPGRADE_1_5.md。
- CI 包含真实 PostgreSQL/Redis 集成测试、格式和依赖审计；CD 依赖同一提交质量检查，支持摘要镜像、Secret 版本固定、发布后验证与失败恢复。
- 本地/容器结果和真实 Telegram/GCP 待验收边界见 CLOSURE_1_5.md；Cloudflare 方案分析见 BACKEND_CHOICE.md。

## v1.4.0 — 2026-10-13

- `/delete_my_data` 增加用户绑定、五分钟有效的 HMAC 二次确认，避免误触直接删除；Bot Token 轮换后签名自动失效。
- 隐私命令包括 `/export_my_data` 和删除确认/取消按钮不再被 Redis/本地限流拦截。
- 管理员新增 `/status`：查询未投递反馈数、积压严重程度/年龄、Redis 队列可达性；Worker 发现超过一小时的积压可每小时发一次严重日志及可选 Sentry 告警。
- 发送管理员通知关闭链接预览，避免不可信反馈文字中的 URL 触发第三方抓取。
- Webhook `WEBHOOK_MAX_CONNECTIONS` 默认 1，支持 1–100 可调，降低有状态反馈交互的并行乱序风险；不将其宣称为严格顺序或 exactly-once。
- Bot/Worker/Redis 通知生产者在启动阶段部分失败时也会尝试关闭所有已建连接；正常关停分组件隔离错误。并修正 Pino 带连字符字段的密钥请求头脱敏路径。
- BullMQ 最低版本要求更新为 `^5.66.0`，对应手动 retry 重置次数 API；CI 改为对真实已提交锁文件使用 `--frozen-lockfile`，并增加 Prisma Schema 校验。
- 增加签名确认、限流例外的 Vitest 与离线断言；新增 `PRODUCTION_READINESS.md`、`UPGRADE_1_4.md`。
- **无新的 Prisma SQL 迁移；仍只有 grammY 一种 Telegram Bot 框架。**
- npm 安装、完整类型检查、Vitest/Docker 构建、Telegram/GCP 实际联调仍需联网及凭据，不能声明为已经通过。

## v1.3.0 — 2026-10-13

- 在唯一 Bot 框架 grammY 中增加私聊命令 `/export_my_data`：JSON 分页导出、每页 50 条、基于 `(createdAt,id)` 的不透明游标；SQL 始终使用当前 Telegram ID 关联的 `userId`，不会根据游标授权。
- 管理员通知改用 Unicode/UTF-16 保守长度检查，防止异常文本或未来模板修改突破 Telegram 4096 字符上限；确保不截断代理对。
- 新增 `pnpm outbox:status`，聚合输出待通知数量、活跃租约、最旧积压年龄与 BullMQ 队列可达性；积压超过一小时退出码 2（可用于告警）。
- Webhook 在监听前执行 `await bot.init()`；Bot 初始化或监听阶段失败时清理数据库/Redis 连接。
- 生产 Docker/GCP 发布要求真实 `pnpm-lock.yaml` 并使用 `--frozen-lockfile`；增加 `pnpm deps:lock` 及 GitHub Actions 手动生成锁文件的工作流。
- 增加隐私导出、通知文本、积压诊断单元测试、离线断言和操作说明。
- **无新增 Prisma 数据库迁移**，保留 v1.2 的数据模型和 grammY 唯一框架。
- 未完成真实 npm 安装、端到端联调及 GCP 发布；详见 `docs/VALIDATION.md`。

## 1.2.0 — 2026-10-12

### Reliability and scale

- PostgreSQL notification leases with unique ownership tokens protect feedback sends from concurrent Worker Pool instances and duplicate queue jobs. A crashed worker relinquishes its lease after five minutes, allowing recovery. External Telegram sends remain at-least-once, never exactly-once.
- Outbox reconciliation now uses keyset pagination `(createdAt, id)` and an explicit composite index; deletion of a cursor row cannot invalidate the next scan.
- Redis-backed atomic per-user fixed-window throttling with bounded per-process fallback; privacy commands bypass throttling. Disabled by default (`RATE_LIMIT_PER_MINUTE=0`) to avoid silently dropping ordinary bot updates.

### Privacy and operations

- `/my_data` private-chat command reveals data inventory to the data subject; `/privacy` now discloses the configured retention period.
- Opt-in `FEEDBACK_RETENTION_DAYS` (default 0) performs batch deletion in the independent Worker, including undelivered records; subject to explicitly configured policy.
- More precise PostgreSQL migration, failure and concurrency regression tests.
- GCP deploy script exposes safe runtime policy knobs and works from exported environment variables as well as `.env.gcp`.
- Manual GitHub Actions GCP release using OIDC Workload Identity Federation, plus CodeQL and Dependabot.

### Limitations

- Full npm install, TypeScript typecheck, Vitest suite, Docker build, Cloud SQL and Telegram live verification still require an online development environment and real credentials.
- Limiting and retention do not replace a legal privacy policy; no guaranteed erasure of backups or notifications already delivered to administrators.

## 1.1.0 — 2026-10-12

### Production reliability

- Redis queue enqueue failure no longer causes Telegram to replay already-committed feedback. PostgreSQL is the authoritative durable outbox.
- Worker reconciles missing BullMQ jobs; explicitly retries terminal failed jobs after exponential cooldown; retries completed jobs when database still indicates an unsent notice.
- A concurrent expiration clean-up can no longer overwrite a newly started feedback interaction.
- `/ready` treats PostgreSQL as required and Redis as a recoverable asynchronous dependency.

### Webhook security

- Fastify rejects incorrect/missing Telegram secret headers in `onRequest` before grammY's first `getMe` API call. grammY still independently verifies the header.
- Error logs now record route identifiers instead of untrusted full request URLs.

### Operations and GCP

- Adds `pnpm doctor` and `pnpm webhook:status`; webhook management commands no longer require the database environment variable.
- Deploy script supports pinned Secret Manager numeric versions and separate optional migration service account/database credentials.
- Cloud Run startup, liveness and readiness probes added, with direct PostgreSQL readiness testing.
- Local Redis explicitly uses `noeviction`; Memorystore instructions and diagnostics check for it via `INFO memory` (not blocked `CONFIG`).
- Adds regression tests for recovery decisions, CLI parsing, Fastify headers and readiness/metrics.

### Known constraints

- Real dependency installation, TypeScript type checking with all packages, API integration and cloud deployment cannot be verified in this offline build environment.
- Outbound Telegram send is at-least-once; delayed retries can repeat admin notifications after send succeeds but marking the database fails.
- Install dependencies online to create `pnpm-lock.yaml`, commit it and then use `--frozen-lockfile` in CI/Docker for reproducible builds.

## 1.0.0 — 2026-10-12

Initial grammY-only Telegram Bot production foundation.
