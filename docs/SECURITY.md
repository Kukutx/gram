# 安全设计

## Token 与 Webhook

- `BOT_TOKEN`、`WEBHOOK_SECRET`、`METRICS_TOKEN` 和数据库密码只从环境变量或 Secret Manager 注入，不进入源码、URL、日志或镜像。`.env` 已被 Git 和 Docker 构建忽略。
- Webhook 请求先在 Fastify `onRequest` 中做等时 Secret 校验，未授权请求不会触达 grammY；grammY 再校验一次 `X-Telegram-Bot-Api-Secret-Token`。
- Compose 部署时 Caddy 只对外暴露 webhook 路径；健康和指标端口只绑定本机回环。`/metrics` 与 `/ops/health` 需要 Bearer `METRICS_TOKEN`（至少 24 字符，等时比较）。
- 开发、测试、生产使用不同的 Bot Token：polling 会删除同一 Token 上已注册的 webhook。

## 权限模型

- **管理员**：`ADMIN_IDS` 中的用户在与机器人的私聊里可以使用管理命令。
- **客服群**：`ADMIN_CHAT_ID` 群里的**每一位真人成员**都被视为客服，可以查看工单、回复用户、封禁用户。群成员资格就是授权，只拉信任的人进群，并关闭群邀请链接。
- 非管理员发管理命令：私聊回复「无权」，在其他群里静默忽略。通知按钮会再次校验权限，转发出去的按钮在别处也无法使用。
- 管理员不能被 `/ban`。被封禁的用户仍能使用隐私命令（查看、导出、删除自己的数据）。

## 数据最小化

- 只保存私聊用户的 Telegram ID、用户名、名字、语言、活跃时间，以及用户主动发给客服的内容。附件只保存 Telegram `file_id`，不下载文件。
- 日志用白名单字段，不含消息正文、用户名和请求头中的密钥。Sentry 事件会丢弃请求、正文、用户身份和上下文。
- 命令回执只存 update ID 和结果，7 天后清理。
- 数据库账号最小权限：运行账号只需 DML；迁移使用单独账号（GCP 脚本支持 `GCP_MIGRATOR_SERVICE_ACCOUNT`）。

## 防滥用

- `RATE_LIMIT_PER_MINUTE` 按用户限流，在任何数据库访问之前执行。配置 `REDIS_URL` 后多实例共享计数，Redis 故障时退回进程内限流。管理员和隐私命令不受限。
- 单条文字不超过 4000 字，所有出站文本按 Telegram 的 4096 字符上限（按 UTF-16 计）安全截断，不会拆开 emoji，通知关闭链接预览。
- 被封禁的用户收不到任何回复，避免被用来刷消息。

## 删除确认

`/delete_my_data` 显示按钮，确认数据同时满足以下条件才会生效：用 Bot Token 做 HMAC 签名、绑定用户、5 分钟内有效、数据库中的一次性 nonce 尚未使用。取消或删除都会撤销 nonce。回调应答失败不会阻止已经授权的删除。删除后旧按钮重放无效，即使同一用户重新注册也一样。

## 已知边界

- Telegram 发送与数据库确认之间无法做到恰好一次：崩溃窗口内一条消息可能重发一次。不要在此基础上直接承载支付等有副作用的业务。
- 已发到 Telegram 的消息、用户下载的导出文件、数据库备份不会因删除而撤回，隐私说明已告知用户。
- 运行时容器使用非 root 用户。依赖通过已提交的 `pnpm-lock.yaml` 固定，CI 执行 `pnpm audit`。
