# 架构

```text
 Telegram ──update──▶ Bot（grammY + Fastify）──事务──▶ PostgreSQL ◀──LISTEN/NOTIFY── Worker ──send──▶ Telegram
                      写入工单、消息和待发记录                   Ticket / TicketMessage           按聊天保序发送
                      然后立即返回                               Delivery（发件箱）               重试、停放、心跳、清理
```

一条原则：**Bot 进程从不直接给别人发消息**。用户发来的内容、客服的回复、状态通知，都先和对应的 `Delivery` 行在同一个数据库事务里写入，再由 Worker 发出。这样 Bot 处理一条更新只需要一次事务；Telegram 暂时不可用、进程重启或部署时，消息都不会丢。

## 进程

| 进程   | 入口                    | 职责                                                                            |
| ------ | ----------------------- | ------------------------------------------------------------------------------- |
| Bot    | `src/index.ts`          | polling 或 webhook 接收更新；`/live` `/ready` `/ops/health` `/metrics`          |
| Worker | `src/worker.ts`         | 发件箱分发、旧通知扩展、保留期清理、回执清理、心跳、运行告警；可选探活端口      |
| 迁移   | `prisma migrate deploy` | 每次发布前单独执行，应用不会在启动时自动迁移                                    |
| CLI    | `src/cli/*.ts`          | `doctor`、webhook 注册、命令菜单同步、发件箱和健康统计，打包进镜像的 `dist/cli` |

## 数据模型（`prisma/schema.prisma`）

- `TelegramUser`：私聊用户资料、语言、`/feedback` 等待状态、封禁时间、最近一次状态变更的 update ID。
- `Ticket`：自增短编号 `number`、状态 `open → in_progress → resolved/closed`、受理人、客服群话题 ID、`lastMessageAt`（列表排序和保留期都用它）。
- `TicketMessage`：方向（inbound 用户→客服 / outbound 客服→用户）、作者、文字、附件类型和 Telegram 文件 ID、来源 update ID（唯一，用于防重放）。`authorId = 0` 表示系统通知。
- `Delivery`：一条消息发往一个聊天的记录。状态 `pending / sent / blocked / paused / dismissed`，租约、尝试次数、错误码，以及发送后的 Telegram message ID（用户或客服「回复」这条消息时，靠它找回工单）。
- `TicketEvent`：审计记录，包括受理、状态变更、回复、发送控制、用户重开。
- `CommandReceipt`：已处理的命令 update ID，7 天后清理，不含用户 ID 和正文。
- `RuntimeHeartbeat`：Worker、分发和清理的心跳，`/ops/health` 用它判断后台是否在工作。

删除用户会级联删除其工单、消息、待发记录和事件。

## 一条更新的处理顺序（`src/bot/create-bot.ts`）

1. `observe`：计时与计数，日志里只记 update ID。
2. `baseContext`：语言、翻译函数，判断是否管理员（`ADMIN_IDS` 的私聊，或客服群里的任何人）。
3. `rateLimit`：在任何数据库访问之前执行；管理员和隐私命令不受限。
4. `userContext`：私聊时一次性加载用户（每 5 分钟最多写一次 `lastSeenAt`），并检查这条更新是否已经处理过。
5. `banFilter`：被封禁的用户静默忽略，但隐私命令仍然可用。
6. 功能模块，按顺序：`general`（start/help/语言）→ `privacy`（查看、导出、删除）→ `admin`（管理命令）→ `support`（客服在话题里打字或回复通知，以及通知按钮）→ `intake`（用户提交和补充，私聊兜底）。

## 并发与幂等

- **按用户串行**：同一用户的状态变更在 `pg_advisory_xact_lock(telegramId)` 下执行，并发重复的更新不会创建两个工单。
- **按更新幂等**：消息以 `sourceUpdateId` 唯一；命令以 `CommandReceipt` 记录；比用户最近一次状态变更更旧的更新会被识别为过期。webhook 重投、polling 重试都安全。
- **发件箱分发**（`src/db/outbox.ts`）：每次扫描用 `DISTINCT ON ("chatId")` 只取每个聊天**最早**的一条待发记录并加 5 分钟租约。同一聊天的消息严格按顺序发出，不同聊天并行（`DELIVERY_CONCURRENCY`）。多个 Worker 同时运行也不会重复领取。
- **失败处理**（`src/delivery/sender.ts`）：
  - 400/401/403 视为永久失败，记录停放为 `blocked`，等待 `/delivery` 人工处理。
  - 其他错误按 10 秒 × 2ⁿ（最长 1 小时）退避，连续 12 次后停放。
  - 话题被删时清掉话题 ID，下次发送会新建话题。
  - 关停时中断的发送会归还租约，不计入失败次数。
- **唤醒**：插入 `Delivery` 的语句级触发器发出 `NOTIFY gram_outbox`，Worker 收到后立即扫描；同时每 `OUTBOX_POLL_MS` 兜底扫描一次。
- **一致性边界**：Telegram 已发送、数据库确认前进程崩溃，这条消息在租约到期后会再发一次。外部 API 不可能做到恰好一次。

## 客服路由

- 收件人：设置了 `ADMIN_CHAT_ID` 时发到客服群；否则发给 `ADMIN_IDS` 里的每个人。
- 话题模式下，Worker 首次给某工单发群消息时创建话题（`#12 @user`），之后都发到这个话题。
- 客服的回复会映射到工单，有三种方式：
  1. 回复某条通知：按「聊天 + 消息 ID」在 `Delivery` 里查找。
  2. 在话题里发言：按 `Ticket.adminThreadId` 查找。
  3. 用命令 `/reply 12 …`。
- 用户回复客服的消息同样按 `Delivery` 找回工单。已解决或已结案的工单会自动重新打开。
- 附件只保存 Telegram `file_id`，转发时直接复用，不下载文件。可带说明文字的类型会把标题写进 caption；贴纸和圆形视频先发标题，再把媒体作为它的回复发出。

## 目录

```text
src/
  bot/            grammY：中间件、功能模块、渲染、命令注册表、收件人、工单引用解析
  cli/            运维命令（doctor、webhook、命令菜单、统计）
  config/         环境变量校验（zod）与常量
  db/             Prisma 客户端、用户、工单、发件箱、命令回执
  delivery/       发件箱分发器（LISTEN/NOTIFY + 轮询）与发送逻辑
  domain/         纯函数：内容提取与校验、多语言、文本长度
  maintenance/    保留期清理
  observability/  日志、Sentry、指标、运行健康
  privacy/        数据导出与删除确认
  security/       限流
deploy/           Docker Compose 生产栈、Caddy、部署与备份脚本
scripts/gcp/      Cloud Run 发布脚本
```

## 扩展时注意

- **多个 Bot 共用一个库**：给表加 `botId`，唯一键改为 `(botId, sourceUpdateId)` 和 `(botId, number)`，`NOTIFY` 通道也按 Bot 区分。
- **新消息类型**：在 `domain/content.ts` 的 `ATTACHMENT_TYPES` 和 `delivery/sender.ts` 的 `MEDIA` 各加一项。数据库字段是字符串，不需要迁移。
- **新语言**：复制 `domain/locales/en.ts`，加入 `LANGUAGES`。缺键会导致类型检查失败，占位符不一致会导致测试失败。
