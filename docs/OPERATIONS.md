# 运维手册

Bot 和 Worker 两个进程都要一直运行。Worker 停了，用户提交的内容仍然会保存，但没有消息能发出去。

## 健康检查

| 入口                         | 看什么                                                     | 鉴权                   |
| ---------------------------- | ---------------------------------------------------------- | ---------------------- |
| `/live`                      | 进程能否响应                                               | 无                     |
| `/ready`                     | 数据库能否查询                                             | 无                     |
| `/ops/health`                | Worker/分发/清理心跳是否新鲜、停放数、积压和最早待发时间   | `METRICS_TOKEN` Bearer |
| `/metrics`                   | Prometheus 指标（含 `grammy_bot_delivery_outcomes_total`） | `METRICS_TOKEN` Bearer |
| `/status`（Telegram 管理员） | 与 `/ops/health` 相同的信息                                | 管理员                 |
| `doctor`                     | 配置、数据库、迁移、触发器、Telegram、客服群权限           | 运行环境               |
| `outbox:status`              | 发件箱按状态统计；不健康时退出码 2                         | 运行环境               |

心跳超过 120 秒视为不新鲜；设置了 `RELEASE_ID` 时只认当前版本的心跳。`/ops/health` 返回 503 而 `/ready` 返回 200 时，说明 Bot 能收消息，但后台发送或清理出了问题。

外部监控每分钟检查一次 `/ops/health`，也可以用 `scripts/probe-http.mjs`，它只需要 `PUBLIC_URL` 和 `METRICS_TOKEN`。Prometheus 告警规则在 `ops/prometheus-alerts.yml`。上线前停一次 Worker 做演练，确认告警真能送到人。Worker 自身的日志不能证明它停止时有人收到告警。

## 客服日常

- 新工单和用户补充会带「受理 / 已解决 / 结案」按钮。直接**回复**通知，或在工单话题里打字，内容就会发给用户，文字和附件都可以。消息排队后机器人会给你的消息加一个 👌。
- `/tickets` 默认列出进行中的工单，`/tickets all 2` 看全部工单的第 2 页，`/tickets resolved` 按状态筛选。
- `/ticket 12` 查看详情和最近消息；`/search 关键词` 搜索消息内容。
- `/reply 12 内容`、`/assign`、`/resolve`、`/close`、`/reopen`、`/set_status 12 in_progress`：在话题里或回复通知时可以省略编号。
- 结案后不能再回复，需要先 `/reopen`。用户再发消息会自动重开工单。
- `/ban #12` 封禁该工单的用户，`/ban 123456` 按用户 ID 封禁，`/unban` 同理。被封禁的用户发消息不会有任何回应，但隐私命令仍然可用。管理员不能被封禁。

## 发送失败

1. `/status` 查看积压和停放数量，`/deliveries` 列出停放和暂停的记录（含投递 ID、工单号、方向、错误码）。
2. 常见原因：
   - **403**：用户拉黑了机器人，或管理员从没和机器人私聊过。
   - **400**：话题或群设置有问题，或文件已失效。
   - **401**：Token 失效。
3. 修复原因后执行 `/delivery <ID> retry` 重新发送；`pause` 暂停，`dismiss` 放弃。正在发送的记录会返回 busy，稍后再试。
4. 同一聊天里，前面一条没发出去，后面的消息会一直等待。所以某个用户的回复迟迟不到时，先看他有没有停放的记录。
5. 网络错误和 5xx 会自动退避重试，不需要处理；连续失败 12 次后才会停放。

## 隐私与数据

- 用户可以随时使用 `/my_data`、`/export_my_data`（JSON 分页）和 `/delete_my_data`（按钮二次确认，一次性有效）。
- 删除会移除用户记录、工单、消息、待发记录和历史。已经发出的 Telegram 消息、用户下载的导出文件和数据库备份不会因此撤回，隐私说明里已写明。
- `FEEDBACK_RETENTION_DAYS > 0` 时，Worker 每 30 秒清理一批最后活动早于期限的工单（每轮最多 10 批，每批 500 个）。
- 日志和 Sentry 不包含消息正文、用户名或 Token。
- 恢复备份后，先重新执行备份时间点之后的删除请求，再启动 Worker，避免复活已删除的数据或重发旧消息。

## 发布与回滚

- 顺序永远是：迁移 → Bot → Worker。迁移只向前兼容，回滚时只回滚镜像，不回滚数据库。
- Compose：`bash deploy/up.sh`。GCP：`scripts/gcp/deploy.sh`，失败时会自动恢复上一版配置，详见 [GCP_DEPLOY.md](GCP_DEPLOY.md)。
- 同一个 Token 只能有一个 polling 进程。出现 409 Conflict 时，检查是否还有旧进程，或者是否已注册了 webhook。

## 常见问题

- **机器人在群里看不到客服的回复**：机器人需要是群管理员（或者在 BotFather 关闭 privacy mode）。运行 `doctor` 检查。
- **话题没有自动创建**：群需要开启话题，机器人需要「管理话题」权限，并且设置了 `ADMIN_USE_TOPICS=true`。
- **消息有延迟**：Worker 是否在运行？`OUTBOX_LISTEN=false` 时最长延迟 `OUTBOX_POLL_MS`。连接池为事务模式时，LISTEN 收不到通知。
- **管理员收不到通知**：管理员必须先私聊机器人发过 `/start`，否则 Telegram 返回 403。
