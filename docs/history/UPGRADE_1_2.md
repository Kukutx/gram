# v1.1.0 → v1.2.0 升级与回滚

不更换 Bot 框架，仍为 **grammY**。建议先在 GCP 测试项目验证再发布生产。

## 升级顺序

1. 备份 Cloud SQL 并验证恢复能力，保留 v1.1.0 镜像及部署参数。
2. 安装依赖（需要联网）；运行 `pnpm db:generate && pnpm typecheck && pnpm test && pnpm build`。
3. **先迁移数据库**：`pnpm db:deploy`，运行 `20261012010000_delivery_lease_and_scan`。该迁移添加 nullable 租约字段和默认值字段；旧代码对新列不会写入，兼容旧服务短暂运行。
4. GCP 脚本的顺序是数据库迁移 → Bot → Worker。若升级期间不能容忍新旧 Worker 并发导致的重复通知，先停止旧 Worker，再部署新 Worker（会短暂停止通知，数据库 Outbox 会补偿）；**不要长期混跑 v1.1 和 v1.2 Worker**。已存在的 BullMQ Job 将继续用相同 `feedbackId` 处理。
5. 在测试 Bot 执行 `/start`、`/feedback`、管理员 `/feedbacks`、`/my_data`、`/privacy`、`/delete_my_data`；测试两个 Worker 的竞争领取、Redis 断开与恢复。
6. 默认 `RATE_LIMIT_PER_MINUTE=0`，`FEEDBACK_RETENTION_DAYS=0`。**不要未经评估启用自动删除**；确认法律和业务保存要求再选择保留天数。

## 新增字段

- `Feedback.deliveryLeaseToken`：最后领取通知的唯一 Worker 令牌。
- `Feedback.deliveryLeaseUntil`：租约到期时间（UTC）；默认 NULL。
- `Feedback.deliveryAttempts`：数据库层通知领取次数，默认 0。
- `(Feedback.notifiedAt, createdAt, id)`：Outbox 扫描组合索引。

## 回滚

- 若尚未启用自动保留删除，可在 GCP Cloud Run / Worker Pool 回滚至 v1.1.0 对应镜像。**保留新增数据库列**，不要为了代码回滚直接删除列；v1.1 不会使用新字段。
- 如果 v1.2 已在使用租约，不要同时运行不同版本 Worker（v1.1 不识别租约）；回滚时先停止 v1.2 Worker，再启用 v1.1 Worker。
- 回滚镜像不会恢复因 `FEEDBACK_RETENTION_DAYS` 删除的数据；如需恢复，请使用备份并评估隐私与写入一致性。

## 生产注意

- 数据库级互斥防止大部分并发重发，但**发送成功、落库失败**仍可能导致重复管理员消息。
- 无 Redis 会降级成单进程限流；没有 Worker 则通知恢复和保留期限清理都不会执行。
- 仍未进行在线依赖安装、压测和 GCP 实测，请先走 CI 与测试项目。
