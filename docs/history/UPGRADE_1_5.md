# v1.4 → v1.5 升级与使用

先备份数据库，再执行 `pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm db:deploy`，最后部署 Bot 和 Worker。

本版本新增 `20261106000000_close_workflows` SQL 迁移：命令回执、删除挑战、投递状态与失败信息、反馈状态/负责人、回复 Outbox、操作历史和运行心跳。迁移保留已有数据，将已通知记录标成 sent。新增字段允许旧版短暂共存，但旧 Worker 不识别 paused/blocked/dismissed，因此启用新投递控制前必须停止旧 Worker；不要把 1.4 Worker 当作可长期混跑的兼容节点。

旧 v1 删除按钮不再有效，请重新执行 `/delete_my_data`。新 v2 按钮需同时满足 HMAC 校验和数据库中的有效挑战；取消、消费或账户重建后旧按钮均不能再删除数据。已处理命令重复到达时可能得到“该请求已处理”的提示，不重复修改状态。

## 用户流程

1. `/feedback` 后发送文字；Bot 返回反馈 ID。
2. `/my_feedbacks` 查看最近反馈状态：open、in_progress、resolved、closed。
3. 管理员回复会直接发到原私聊；不保证即时处理或固定响应时间。
4. `/export_my_data` 分页导出用户资料和反馈；`/export_my_replies` 单独分页导出管理员回复。每页 50 条，跨页不是数据库快照。
5. `/delete_my_data` 二次确认后，用户、反馈、回复和相关处理历史级联删除。

## 管理员流程（仅配置的管理员私聊）

| 命令                                                   | 用途                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `/feedbacks`                                           | 最近反馈与 ID                                        |
| `/ticket <id>`                                         | 正文、状态、负责人、最近回复和处理历史、发送错误     |
| `/assign <id>`                                         | 分配给当前管理员并标为处理中                         |
| `/reply <id> <文字>`                                   | 持久化回复，异步发送给用户                           |
| `/resolve <id>`                                        | 标记已解决                                           |
| `/close <id>`                                          | 结案；结案后拒绝新回复                               |
| `/reopen <id>`                                         | 重新打开                                             |
| `/set_status <id> open\|in_progress\|resolved\|closed` | 显式调整状态                                         |
| `/deliveries`                                          | 最早的 blocked/paused 反馈通知与回复，每类最多 10 条 |
| `/delivery feedback\|reply <id> retry\|pause\|dismiss` | 重试、暂停或终止待发送记录                           |
| `/status`                                              | 积压、阻塞数量、Worker/清理/分发心跳                 |

401/403/400 被保存为 blocked，避免永久错误不断重试；修复 Token、用户封禁或管理员未启动 Bot 等原因后再 retry。暂时错误保留一分钟冷却，再自动补偿；正在投递的记录不能被人工并发改写。回复“已排队”表示已写入数据库，送达需看 ticket 的 replies 状态。

当前是单 Bot、单配置管理员；没有擅自增加多人管理权限。删除已发送消息、跨系统恰好一次和法律意义上的全副本删除不在该流程的保证范围内。

## Worker 与监控

`pnpm dev:worker` / `node dist/worker.js` 既执行通知也执行维护。无需 Redis 或管理员也能执行保留清理；有管理员、无 Redis 时直接从 PostgreSQL Outbox 投递。启用 Redis 时补偿生产者和消费者采用独立连接，清理与心跳独立调度，关停有总时间上限。

`/ready` 只检查 PostgreSQL。设置 METRICS_TOKEN 后，外部使用 Bearer Token 访问 `/ops/health`：Worker 停止、分发停止、blocked 投递、严重积压或清理延迟会返回 503；`/metrics` 提供对应数值。`RELEASE_ID` 非空时只接受当前发布版本的心跳。配置外部监控使用 `ops/prometheus-alerts.yml`，或定期运行 `node scripts/probe-http.mjs`。报警接收渠道仍需运营方真实配置并演练。

命令回执不保存消息正文或 Telegram 身份，由维护任务清理七天前记录。备份恢复后应先在隔离环境恢复、重放恢复点之后登记的数据删除请求、确认投递记录，最后才开启通知；否则可能恢复已删除资料或重复发送。运营方应在独立的受控系统登记恢复点后的删除请求，限制访问并制定销毁期限。

## 发布与回滚

生产 CD 先调用同一提交的完整 CI，含 PostgreSQL/Redis 测试和 Docker 构建。部署脚本使用不可变镜像摘要、固定数字 Secret 版本，支持已验证 staging 摘要晋级并校验源码 revision 标签；部署失败会尝试恢复之前导出的 Bot/Worker 配置，SQL 不自动回滚。首次部署没有旧版本可恢复，失败时必须按日志处理。

新增必需 GCP Secret 引用：`GCP_METRICS_TOKEN_SECRET`。Redis 默认关闭（GCP_REDIS_ENABLED=0）；Sentry 可选，使用增量更新秘密，避免重部署清掉既有监控设置。明确禁用 Redis 会删除其秘密绑定。首次尚未注册 Webhook 时显式使用 GCP_BOOTSTRAP=1；注册后将该值改回 0，重新运行 verifier Job。bootstrap 结果不能当作 Telegram 完整验收。

发布后验证 Job 会检查 getMe、Webhook URL、当前版本心跳、数据库和 HTTP 健康。真实发送/接收及故障演练仍需 staging Bot 与云账号，本地模拟 Telegram 传输不代表已完成云端验收。
