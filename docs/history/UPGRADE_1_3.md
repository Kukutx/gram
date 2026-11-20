# 升级到 v1.3.0

本版本保持 **grammY + TypeScript** 单一 Telegram 框架。由 v1.2.0 升级到 v1.3.0 **没有数据库 Schema 更改**，不新增 Prisma migration；已部署 v1.2.0 仍需要保留原有两份 SQL migration。

## 升级步骤

1. 备份现有 PostgreSQL 数据并记录 Cloud Run、Worker Pool 的当前镜像与版本；不要把 `.env` / Secret Manager 的密钥放进源码。
2. 在联网的本地或可信 CI 执行 `pnpm deps:lock`。若本地无法访问 npm，可在 GitHub Actions 手动运行 `Generate dependency lockfile (manual)`，下载工件中的 `pnpm-lock.yaml` 并提交仓库。不要手工编造锁文件。
3. 执行 `pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm check` 与 `pnpm smoke:offline`。测试库必须与生产数据库隔离。
4. 在 staging 部署 Webhook 服务和 Worker，检查 `/ready`、`pnpm doctor`、`pnpm outbox:status`、`/feedback`、管理员通知、`/export_my_data`。先让 v1.3 的初始化、命令和 Unicode 测试通过。
5. 使用 `scripts/gcp/deploy.sh` 或手动批准的 GitHub Actions CD 发布；`pnpm commands:sync` 将新命令注册到 BotFather 可见的命令列表中。
6. 查看 Redis、PostgreSQL、Telegram API 日志。尤其确认无异常重复通知、未处理反馈积压和导出请求失败。

## v1.3 变更的兼容性

- 数据库：不新增表或字段；v1.2 的 `Feedback.deliveryLease*` 字段继续保留。
- 机器人：新增 `/export_my_data [cursor]`，不改变已有命令含义。新增导出文件需用户本人保存；Bot 不在对象存储持久化该 JSON。
- 生产镜像：**没有真实 `pnpm-lock.yaml` 会拒绝构建**。这是有意的安全约束。`pnpm install` 单独运行并不等于锁文件已提交到 Git。
- Webhook：在 Fastify 开始监听之前先校验 `bot.init()`；当 Telegram API 无法访问时服务会拒绝启动，便于 Cloud Run 探针和滚动更新识别失败。
- Worker：对外发送的通知内容可能在超长时附加 `…` 截断；保留 PostgreSQL 原始反馈供管理员查看。

## 回滚

可将 Cloud Run 与 Worker Pool 恢复到之前确认健康的 v1.2 镜像，不需要数据库回滚。不要在回滚时撤销 v1.2 所需字段；`pnpm-lock.yaml` 应与对应代码版本一起回滚。**已向 Telegram 发送的消息无法通过数据库回滚撤销**。

## 不能视为完成的验证

离线校验不代表 npm 类型检查、完整 Vitest、Prisma generate/migrate、Docker 构建、Telegram/GCP 真机联调。上述验证须由联网 CI 和你的实际部署环境完成。
