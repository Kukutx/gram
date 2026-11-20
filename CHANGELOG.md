# Changelog

## Unreleased

### 工单模型 v2（数据库迁移 `20261120000000_tickets_v2`）

- 数据模型：反馈改为「工单 + 对话消息」。每个工单有短编号（#12），用户与客服可以多轮往来；所有发出的消息统一进 `Delivery` 发件箱，旧数据（反馈、回复、事件、未送达通知）在迁移中原样转换。
- 多管理员：`ADMIN_IDS` 支持多个管理员（旧的 `ADMIN_TELEGRAM_ID` 仍可用并自动合并）。
- 客服群：设置 `ADMIN_CHAT_ID` 后通知发到群里，群成员都能处理；`ADMIN_USE_TOPICS=true` 时每个工单一个话题，在话题里直接打字就是回复用户。
- 不用命令也能回复：管理员直接「回复」通知消息即可发给用户；用户「回复」客服消息即补充到同一工单（已解决/已结案的工单会自动重新打开）。通知带「受理 / 已解决 / 结案」按钮。
- 附件：支持图片、文件、视频、语音、音频、动图、贴纸和圆形视频，双向转发（只保存 Telegram 文件 ID，不下载文件）。
- `INTAKE_MODE=direct`：用户无需 /feedback，直接发消息即可联系客服。`NOTIFY_USER_ON_STATUS` 控制是否通知用户状态变化。
- 管理命令：`/tickets [状态|all] [页]` 分页列表、`/search`、`/ban`、`/unban`；`/ticket`、`/reply`、`/resolve` 等可用 `#编号`，在话题里或回复通知时可省略编号。用户也可用 `/ticket <编号>` 查看自己的工单。
- 投递：去掉 BullMQ，改为 PostgreSQL 发件箱 + `LISTEN/NOTIFY` 即时唤醒；同一聊天严格按顺序，不同聊天并行（`DELIVERY_CONCURRENCY`）；临时错误按指数退避重试，永久错误（被拉黑等）停放待人工处理。Redis 只剩跨实例限流一个用途，可不配。
- 运维：`pnpm doctor` 增加迁移、NOTIFY 触发器、客服群权限与话题检查；`pnpm outbox:status` 按状态统计发件箱；新增 `grammy_bot_delivery_outcomes_total` 指标。
- 网络错误不再被自动重试无限挂起：机器人把失败交给 Telegram 重投，Worker 交给发件箱退避。
- 删除离线冒烟脚本（已被单元测试覆盖），集成测试不再需要 Redis。

### 通用部署与文档

- `deploy/compose.yaml` + `deploy/up.sh`：任意 Docker 主机一条命令完成构建、迁移、启动（健康检查）、命令菜单同步和自检；webhook 模式附带 Caddy 自动 HTTPS，只暴露 webhook 路径。`deploy/backup.sh` 定时备份并轮换。
- 运维命令移到 `src/cli/`，随镜像发布（`node dist/cli/doctor.js` 等），容器里也能自检。
- GCP 发布脚本支持 `GCP_ADMIN_IDS`（多个）、`GCP_ADMIN_CHAT_ID`、`GCP_ADMIN_USE_TOPICS`、`GCP_INTAKE_MODE`、`GCP_DEFAULT_LANGUAGE`，并在任何云操作前校验。
- 文档整合为 README、DEPLOY、GCP_DEPLOY、ARCHITECTURE、OPERATIONS、SECURITY、PRIVACY_EXPORT、RELEASE_POLICY；v1.x 文档移入 `docs/history/`。CI 去掉 Redis 服务。

### 稳定性与结构

- 修复：long polling 模式下任一更新处理出错会让 grammY 停止轮询、进程退出；现在记录并跳过该更新。
- 性能：每条更新只加载一次用户（与命令回执并行查询），`lastSeenAt` 每 5 分钟最多写一次；语言不再在同一更新中重复查询；`/ops/health` 与 `/metrics` 的健康查询缓存 5 秒。
- 结构：`create-bot.ts` 拆分为中间件和 general / privacy / feedback / admin 四个功能模块；投递租约逻辑合并为一份（反馈与回复共用），时间常量集中到 `config/constants.ts`。
- 多语言：所有用户和管理员可见文本移入语言包（含通知、工单详情、投递状态），英文包缺键或占位符不一致会在类型检查或测试中失败；新增 `DEFAULT_LANGUAGE`。
- 命令：`/help` 与 Telegram 命令菜单由同一注册表生成，管理员命令只对管理员显示。
- 运维：polling 模式也提供 `/live`、`/ready`、`/ops/health`、`/metrics`；Worker 可通过 `WORKER_HEALTH_PORT` 暴露探活端口。
- CI：只在 develop/main 推送和 PR 上运行并取消过期 PR 运行；安全扫描改为监听 develop。删除已失效的 `MANIFEST.sha256`。

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
