# 项目架构与扩展边界

> v1.5：Redis/BullMQ 为可选加速层；独立 Worker 可仅连接 PostgreSQL 处理通知及维护。新增反馈处理、回复 Outbox、一次性删除挑战、命令回执和版本心跳。当前部署建议见 [BACKEND_CHOICE.md](BACKEND_CHOICE.md)。后续按版本标注的小节为历史设计演进。

```text
                          Telegram Bot API
                                 │
                         HTTPS Webhook POST
                                 │
                        ┌────────▼────────┐
                        │ GCP Cloud Run   │  /live /ready /metrics
                        │ Fastify + grammY│
                        └────────┬────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
       Cloud SQL PostgreSQL            Memorystore Redis
       Prisma 7 Driver Adapter          BullMQ (feedbackId)
       Users / Feedback                       │
                  ▲                           ▼
                  └──────────────── Cloud Run Worker Pool
                                      │
                                      ▼
                                Telegram Bot API
                               管理员反馈消息通知
```

## 为什么只保留一个 Bot 框架

Telegram 消息入口、命令、回调键盘以及 Telegram API 都由 **grammY** 负责。Fastify 只提供 Webhook HTTP 接口；Prisma 仅负责持久化；BullMQ 负责异步工作。它们不是替代的 TG 框架。

## 数据边界

- PostgreSQL 是持久业务事实来源，保存用户语言、待反馈状态和已提交反馈。
- Redis 只承担**队列**，不被当作业务数据的主存储。`Feedback.notifiedAt` 同时是简化的持久待通知 Outbox 标记，Worker 定期补偿扫描和冷却重试 BullMQ 终态任务。
- `feedback.sourceUpdateId` 用来去重 Telegram 的重复 Update；更新状态及反馈保存使用一个 PostgreSQL 事务。
- 配置和密钥只从环境变量注入，生产部署由 Secret Manager 管理。

## 部署进程边界

- Webhook 服务：接收 Telegram Update，执行轻量处理，确认数据库事务完成后返回 HTTP 结果。Redis 入队为最佳努力；专职 Worker 后续补偿。
- Worker：持续执行 BullMQ 任务，向管理员发送消息，将结果写回 PostgreSQL。必须独立持续运行。
- Migrator：独立 Cloud Run Job，仅用于迁移，**不可**在 Webhook 每次启动时自动运行迁移。

## 未来演进注意

这不是“分布式恰好一次处理”系统。要对高价值业务保证跨系统最终投递，可增加 Postgres Transactional Outbox + 专职投递器。扩展到多 Bot 时，需要为数据表增加 `botId`，把 `(botId, sourceUpdateId)` 作为唯一键，并对队列名、Webhook path、管理权限做 Bot 维度隔离。当前项目有意保持单 Bot，避免错误地把示例包装为已完成的多租户系统。

## v1.2：扩容、隐私和限流

- 每条未通知反馈发送前需要在 PostgreSQL 中原子获取 5 分钟租约（`deliveryLeaseToken` / `deliveryLeaseUntil`），保证同时只有一个有效租约持有者。发送成功后按租约 Token 置 `notifiedAt`；失败则仅持有者能够释放租约。**外部 Telegram 消息不具备真正的 exactly-once 语义。**
- Worker 扫描使用 `(createdAt, id)` keyset，不依赖被扫描记录仍然存在。组合索引 `(notifiedAt, createdAt, id)` 缩小扫描成本。
- Webhook 层限流优先用 Redis Lua 原子计数，允许多 Cloud Run 实例共享计数；Redis 不可用时仅实行进程内有限限流，不能宣称仍然严格全局限流。
- `FEEDBACK_RETENTION_DAYS` 默认 0（不开启）。在管理员明确设置大于 0 时，仅独立 Worker 执行分批清理，包含未通知反馈。隐私通知同步显示期限。
- 未擅自添加 Next.js / ASP.NET 或新的 Telegram 框架。

## v1.3 可维护性扩展

- `src/domain/telegram-text.ts`：UTF-16 保守消息长度裁剪，保护 Telegram 出站消息不被过长 Unicode 文本拒绝。
- `src/privacy/export.ts`：按用户过滤的 JSON 分页导出，不建立额外数据副本表；不透明游标只代表位置，不代表授权。
- `src/observability/outbox-health.ts` 与 `scripts/outbox-status.ts`：聚合积压、延迟和队列可达性，供运维观测。
- v1.3 不新增数据表与基础设施产品；仍只有 grammY 一个 TG Bot 框架。

## v1.4 容错与隐私交互

- `/delete_my_data` 使用纯 grammY InlineKeyboard，按钮含 5 分钟有效的用户专属 HMAC。跨实例校验不依赖内存 Session，避免误触导致立即删除；Bot Token 轮换会使待确认按钮失效。
- 个人数据导出、隐私命令和删除确认/取消回调不会被可选限流拦截。
- Webhook 注册默认单连接以降低按人会话乱序，但**严格顺序和 exactly-once 不由 Bot API 保证**；提高连接数需要重新验证幂等与排序。
- Worker 对超过一小时的未通知反馈输出严重告警，并针对重复告警做单进程一小时冷却；定期人工/监控检查仍然不可省略。
