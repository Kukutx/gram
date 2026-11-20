# v1.3 → v1.4 升级指引

**唯一 TG 机器人框架仍为 grammY。** 本次没有新的 PostgreSQL 表、字段或 SQL migration。保留已应用的 v1.2 迁移即可；部署前照常执行 `pnpm db:deploy`。

## 变更

1. `/delete_my_data` 现在先给出 **5 分钟有效、HMAC 签名且绑定 Telegram 用户 ID** 的二次确认按钮。按钮过期后需重新发送命令；取消不会删除数据。签名来自 Bot Token，轮换 Bot Token 会自动使旧按钮失效。
2. 限流开启时，`/export_my_data` 和删除确认/取消按钮可照常使用，避免用户无法履行隐私请求。
3. 管理员私聊新增 `/status`，输出待发送反馈数量、最早未通知年龄和 Redis 队列状态。管理员通知发送时关闭链接预览，避免第三方预览抓取用户反馈中的网址。
4. `pnpm webhook:set` 默认把 `max_connections` 设置为 **1**，降低有状态反馈流程的并行处理乱序风险；新参数 `WEBHOOK_MAX_CONNECTIONS` 支持 1–100。注意：这只是降低乱序概率，**不是严格排序、事务去重或恰好一次**。
5. Worker 超过 1 小时的未通知积压每小时最多记录一次严重事件；有 Sentry DSN 时同步发送 Sentry 消息。改进 Bot / Worker 在启动失败及正常关停时释放连接。
6. BullMQ 的版本下限提升到 5.66.0，以确保手动 `retry(..., { resetAttemptsMade: true })` API 存在。
7. CI 改为需要**已提交的真实** `pnpm-lock.yaml` 并运行 `pnpm install --frozen-lockfile`；增加 Prisma Schema 校验。原 v1.3 ZIP 没有锁文件，首次需要使用 `pnpm deps:lock`（需联网）生成、提交、通过 CI。

## 升级步骤

在受控测试环境：

```bash
# 已安装 Node.js 24 / pnpm 10；设置隔离环境的 .env
pnpm deps:lock                 # 若尚无锁文件：联网生成并将其提交 Git
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:validate
pnpm db:deploy                 # 本次不会新增 Schema 迁移
pnpm check
pnpm smoke:offline
pnpm webhook:status
```

重新部署 Bot 和 Worker 镜像，验证私聊 `/feedback`、`/export_my_data`、`/delete_my_data` 的确认/取消/超时行为，以及管理员 `/status`。如使用 Webhook，更新部署后**明确重新执行** `pnpm webhook:set -- https://YOUR_HOST` 才会生效 `WEBHOOK_MAX_CONNECTIONS`，脚本不会默默改动线上设置。

## 回滚

本次没有 Schema 变更，因此可以将 Bot 和 Worker 回滚到已验证的 v1.3 镜像。回滚会恢复单步删除行为（仍应注意现有数据）；签名按钮在旧版本没有回调处理器，会失效，用户可在旧版本重新发送命令。Webhook `max_connections` 是 Telegram 侧配置，不会随镜像回滚自动改变。

## 尚未解除的限制

- PostgreSQL + Telegram API 跨系统的 exactly-once 不可保证；管理员收到的通知可能重复。
- `max_connections=1` 是吞吐量与顺序风险的取舍；高并发业务必须设计完整的按用户顺序/幂等处理机制，再提高连接数。
- 使用无互联网环境生成的源码包不等于依赖安装、完整 TypeScript/Vitest、Docker/GCP 构建已验收；详见 `VALIDATION.md`。
- 个人数据删除不会抹除 Telegram 已收到的文件、管理员历史通知或 Cloud SQL 备份中的旧副本，运营者须定义单独的备份保留策略。
