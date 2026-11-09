# 运维手册 · v1.5

运行两个独立进程：HTTP/Polling Bot 与 Worker。Worker 同时负责通知、命令回执清理、保留清理和心跳；即使不用 Redis，也应持续运行。

## 健康与报警

| 入口                 | 用途                                           | 鉴权                 |
| -------------------- | ---------------------------------------------- | -------------------- |
| `/live`              | HTTP 进程能否响应                              | 无                   |
| `/ready`             | PostgreSQL 能否查询；不检查 Redis              | 无                   |
| `/ops/health`        | Worker/分发/清理心跳、通知阻塞与积压、清理延期 | METRICS_TOKEN Bearer |
| `/metrics`           | 请求、运行时与运行状态指标                     | METRICS_TOKEN Bearer |
| `pnpm ops:health`    | 数据库侧聚合运行检查，异常退出 2               | 运行环境             |
| `pnpm outbox:status` | 运行状态加队列统计；Redis 不可达退出 3         | 运行环境             |

外部监控每分钟检查 `/ops/health`，或运行 `node scripts/probe-http.mjs`（需要 PUBLIC_URL 和 METRICS_TOKEN，不需数据库凭据）。Prometheus 可使用 `ops/prometheus-alerts.yml`。必须实际配置报警接收渠道，停止 Worker 做一次报警演练，并记录响应人。不能用 Worker 自己的日志证明 Worker 停止时仍有人报警。

心跳超过 120 秒不新鲜；启用 RELEASE_ID 时仅接受相同版本的心跳。清理延迟达到五分钟、通知积压达到一小时、存在 blocked 发送等会影响运行健康，但不会故意让仍可保存反馈的 `/ready` 失败。配置 METRICS_TOKEN 后应限制监控访问来源并保护令牌。

## 通知故障处理

PostgreSQL 是通知事实来源。默认不用 Redis，由 Worker 每 15 秒扫描反馈和回复，按数据库租约投递。启用 Redis 时，HTTP 尽力入队；失败仍确认反馈已保存，Worker 独立补偿队列中的缺失或终态任务。暂停、阻塞和已终止记录不会被自动恢复为发送状态。

1. 管理员查看 `/status`、`/deliveries` 和 `/ticket <id>`。
2. 400/401/403 被标为 blocked，保存错误码、时间和尝试次数；修复 Bot Token、管理员未启动 Bot、用户屏蔽等原因后重试。
3. `/delivery feedback|reply <id> retry` 恢复待发送；`pause` 暂停；`dismiss` 终止。正在发送且租约未到期时返回 busy，稍后重新发一条命令。
4. 临时网络/5xx 错误保留一分钟数据库冷却；BullMQ 同时有队列退避。进程崩溃后租约最长五分钟，随后允许恢复。
5. 发送已成功但数据库确认失败仍可能重复；通过反馈/回复 ID 识别。不要据此承担未经扩展的支付或财务副作用。

Redis 仅可在私网/受控网络使用，BullMQ 要求 noeviction。启用 Redis 后出现持续分发失败时检查连接、TLS、内存与 Worker；也可以在完整停用 Redis 路径并更新配置后使用 PostgreSQL-only 模式，不能同时随意切换多个 Token/数据库。

## 用户反馈处理

`/feedbacks` 获取 ID，`/assign <id>` 受理，`/reply <id> <文字>` 保存并排队回复，`/resolve <id>` 解决，`/close <id>` 结案，`/reopen <id>` 重开。结案后拒绝新回复。当前仅支持一个配置管理员。

用户通过 `/my_feedbacks` 查看最近十条；导出历史反馈可使用 `/export_my_data`，管理员回复用 `/export_my_replies`。语言菜单、帮助和输入引导均在 Bot 中提供。不要把管理员收到通知等同于用户问题已解决。

## 数据、隐私与备份

- 先配置 SUPPORT_CONTACT 和适用的 PRIVACY_POLICY_URL；Bot 的隐私命令明确说明数据库、Telegram 副本和备份边界。
- 删除确认既验证签名、用户和有效期，又验证数据库中尚未消费的 nonce。取消及删除会撤销挑战；回调应答失败不阻断授权删除。
- 用户、反馈、回复和处理历史级联删除。已在途通知可能与删除并发，已发送 Telegram 消息和导出文件不能自动撤回。
- 命令回执无消息正文或 Telegram 身份，维护任务批量清理七天前记录。维护停机或积压会延迟清理，应监控心跳和清理延期。
- FEEDBACK_RETENTION_DAYS 为 0 时不自动删反馈；非零会连同回复/处理历史删除到期反馈，包含尚未投递的数据。每次维护最多十批、每批 500 条，每 30 秒调度一次。
- 开启数据库备份/PITR，定期恢复到隔离环境；维护方须在独立受控系统登记备份点之后的数据删除请求。恢复时先重放这些删除请求并检查 Outbox，再开放 Worker，避免复活已删数据或重新发送旧通知。

## 发布与恢复

升级先执行数据库迁移。v1.5 新字段向前添加；旧 Worker 不理解投递控制状态，启用 pause/blocked/dismissed 前必须停止旧 Worker。具体见 `docs/UPGRADE_1_5.md`。

CD 先运行同一提交 CI，随后发布摘要镜像、迁移、Bot、Worker，再执行验证 Job。Secret 使用固定数字版本。首次尚未注册 Webhook 使用显式 bootstrap；注册后必须关闭 bootstrap 并再次验证。仅 getMe 和健康检查不能代替真实用户交互验收。

脚本失败会尝试恢复之前导出的 Bot/Worker 配置，数据库迁移不自动回滚；首次创建没有旧版可恢复。`deployment-record.json` 保存镜像、之前镜像、发布号和 prepared/failed/bootstrap/verified 状态，CI 将其保留为工件。回滚失败应立即人工检查，而不是继续宣告发布成功。

真实故障演练至少包含：错误/缺失 Webhook Secret、反馈保存后 Redis 中断、Worker 崩溃、Telegram 429/5xx、数据库断连、删除后旧回调重放、数据恢复和费用告警。恢复目标与值班责任由运营方明确。

## 常见诊断

- Bot 不响应：检查 Token、Webhook URL、密钥、`/ready` 和更新积压；测试环境不得复用生产 Token。
- 409 Conflict：同一 Token 的 Polling/Webhook 或多个 Polling 进程冲突。
- 数据库失败：检查连接串、连接池、Cloud SQL 挂载/IAM/网络；应用账号只给 DML，迁移使用独立账号。
- `/ops/health` 503 但 `/ready` 200：保存功能可用，但 Worker、投递或清理存在问题。
- Docker/迁移失败：先运行 `pnpm release:verify`，核对锁文件、Node 24 和 OpenSSL；不要在生产使用 db push。
