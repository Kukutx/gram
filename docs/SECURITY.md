# 安全设计与检查清单

> v1.5 已用数据库一次性挑战替代仅凭无状态签名删除；错误日志/Sentry 采用白名单，命令具有事务回执，回复及操作历史参与级联删除。下方 v1.4 历史说明以 [UPGRADE_1_5.md](UPGRADE_1_5.md) 和当前实现为准。

## Bot Token 与 Webhook

- `BOT_TOKEN` **仅**来自运行环境或 GCP Secret Manager，绝不写进源码、URL 路径、前端或日志。
- `WEBHOOK_SECRET` 要符合 Telegram 的 Secret Token 字符集，随机生成。Fastify `onRequest` 先做等时密钥校验，避免未授权请求触发 grammY 首次 `getMe()`；grammY `webhookCallback` 二次校验 `X-Telegram-Bot-Api-Secret-Token`。
- Cloud Run 需允许 Telegram 公网访问服务，但不能以此为理由添加未鉴权的后台管理接口。仅 `/telegram/webhook` 接收 Telegram 更新。
- 生产环境只使用 Webhook 模式；本地 Polling 模式会先删除 Webhook，故使用同一个 Bot Token 的多环境会冲突。强烈建议开发 / 测试 / 生产分别用不同 Bot Token。

## 用户资料与管理权限

- 只在**私聊**记录 Telegram 用户 ID、用户名、名字、语言、最后活跃时间以及主动发送的反馈。
- `/stats`、`/feedbacks` 必须由 `ADMIN_TELEGRAM_ID` 匹配后在私聊中访问。
- `/delete_my_data` 删除用户及关联反馈；数据库 FK Cascade。已推送给管理员的消息不能由数据库删除操作撤销，需在隐私政策中说明。
- PostgreSQL 使用应用专属、最小权限账号；生产环境开启 Cloud SQL 备份 / PITR。

## Redis / BullMQ

- **BullMQ 专用 Redis 必须使用 `maxmemory-policy=noeviction`**（Memorystore 默认不是这个值）；并监控 Redis 内存、连接与持久性。
- Redis 仅在受控网络中使用。Cloud Run 到 Memorystore 的连接经由 Direct VPC egress；勿将 Redis 暴露公网。
- 队列消息**只存 feedbackId**，不在 Redis Job Payload 中复制用户反馈原文。
- BullMQ Job ID 固定，提交重复 Telegram 更新时队列层尽量去重；保留完成记录 7 天。已完成/失败但数据库仍待通知的任务由 Worker 在退避后重试。
- 给 Worker 设置独立运行与监控；重要财务/支付类业务不能依赖此项目的简单通知幂等语义。

## 运行时及运维

- Docker 运行时使用非 root 用户。
- 禁止向公开 HTTP API 暴露管理员读写功能。`/metrics` 仅在设置 `METRICS_TOKEN` 后存在，使用 Bearer Token。
- Pino 结构化日志默认不记录消息正文，敏感 Header 在日志中脱敏。
- 定期升级 Node LTS、grammY、Prisma 7、BullMQ 等依赖，定期评估 `pnpm audit`。
- 第一次联网运行 `pnpm install` 后**立即提交锁文件**；部署应改为 `--frozen-lockfile`。
- GCP Secret Manager 使用按 Secret 授权，定期轮换密钥；CI 推荐 Workload Identity Federation，避免永久 JSON Service Account Key。

## 明确的可扩展边界

- 反馈依赖 Telegram Webhook 的至少一次投递；跨 Postgres/Redis 的原子事务不存在。当前版本通过“持久化唯一源更新 ID + 数据库失败返回 5xx + 独立 Worker 补偿”，并在 Worker 中定期扫描 `Feedback.notifiedAt IS NULL`，补回数据库已保存但 Redis 尚未入队的任务。若 Worker 没有运行、任务已进入永久失败状态或数据库本身损坏，仍需告警与人工恢复。高价值复杂业务建议设计正式的事务 Outbox / 事件表。
- 对外 Telegram `sendMessage` 没有跨网络和 DB 的 exactly-once 保证。Worker 在“发送成功、更新数据库失败”的窗口可能重复通知。
- 用户菜单和语言切换是示例功能，不是全面的风控系统。要支持公开大群高频流量，还需要独立分布式限流、审计以及告警设计。

## v1.2 强化与剩余风险

- 多 Worker 通知必须先获取有期限的数据库租约；租约和 `notifiedAt` 由数据库原子条件更新保护，不依赖 Redis 原子性。租约过期时长 5 分钟；如果外部 API 长时间无响应并超过租约，其他 Worker 仍可能重新发送。Telegram 外部消息的 exactly-once 无法保证。
- Redis 固定窗口限流**默认关闭**；管理员按需设置每 Telegram User ID 每分钟上限，仅私聊；管理员和数据访问/删除命令例外。没有 Redis 时只能单进程防护，Redis 故障时会自动降级，不是全局防洪系统。群管理、付款、高价值操作仍需独立授权和防重规则。
- 可选定时清理由常驻 Worker 执行，默认关闭；启用后删除**包括未发送通知的过期反馈**。告知用户数据保留期限，但备份、管理员已接收通知及其他下游副本必须按对应运营政策另行处理。
- `/my_data` 只给数据主体在 Telegram 私聊发送摘要，不等价于完整数据可携带性导出。严格隐私权利履行要另外设计受认证的完整导出和备份删除机制。
- `/metrics` Bearer 令牌采用等时字符串比较；仍建议在 GCP 网络层限制访问来源，并保护 Token。

## v1.3 隐私导出

`/export_my_data` 严格限定私聊，数据库查询使用来自 Telegram Bot API 的 `from.id` 查找内部 `userId`，所有分页查询都包含该用户的 `userId` 过滤；游标不参与鉴权，不可指定他人 Telegram ID。导出文件可能包含反馈正文和个人资料，不应被应用日志捕获或另行发送给管理员。具体协议和使用边界见 [PRIVACY_EXPORT.md](PRIVACY_EXPORT.md)。

### 发布供应链

没有真实 `pnpm-lock.yaml` 的源码仓库不得启动生产构建或 GCP 发布；使用 `pnpm deps:lock` 联网生成，提交版本控制后在 Docker 里使用 `--frozen-lockfile`。参见 [RELEASE_POLICY.md](RELEASE_POLICY.md)。

## v1.4 数据删除确认与通知预览防护

- `/delete_my_data` 不是立即删除：私聊显示按钮，确认码由 Bot Token HMAC 签名，绑定 `Telegram from.id` 和 5 分钟有效期。用户不能拿自己的按钮删除别人账户；不保存 HMAC/Token 到数据库，Token 轮换后旧按钮无效。
- 删除确认/取消和个人数据导出绕过可选应用层用户限流，以防用户被错误锁定在数据删除流程之外。
- 管理员接收反馈使用纯文本且关闭 Web 页面预览。仍需注意通知正文和 JSON 导出是私人数据，不应转发或记入日志。
- 确认码并不阻止截屏、转发或备份问题；删除仅作用于本服务 PostgreSQL 当前记录，不包括已发送到 Telegram 的消息或备份中的旧副本。
- Webhook 单连接只是降低乱序的默认保护；Telegram 更新可能重试，跨数据库与 Telegram 的“恰好一次”仍不可保证。
