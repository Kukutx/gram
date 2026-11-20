# 交接说明（给接手的人和 AI 会话）

先读这一页，再读 [README.md](README.md)、[docs/DEPLOY.md](docs/DEPLOY.md)、[docs/OPERATIONS.md](docs/OPERATIONS.md) 和 [CHANGELOG.md](CHANGELOG.md)。最后更新：2026-11-20。

## 这是什么

Telegram 客服 / 工单机器人：grammY + Fastify + PostgreSQL（Prisma 7）。用户私聊机器人提交问题，管理员在 Telegram 里受理、回复、解决。所有发出的消息都走 PostgreSQL 发件箱（`Delivery` 表 + LISTEN/NOTIFY），由 Worker 发送；没有 Redis。默认分支是 `develop`。

## 现在的状态

- **已上线**，运行在 Oracle Cloud 永久免费 Arm 服务器上（Docker Compose，见 `deploy/`）。2026-11-20 在真实 Telegram 里把用户端和管理端的全部命令测过一遍，都正常。
- **服务器每天自动更新**：约 UTC 04:00 从 `develop` 拉取、重建、迁移，失败自动回滚，并在 Telegram 通知管理员（`deploy/auto-update.sh`，`AUTO_UPDATE=false` 可关闭）。所以**改代码只要合并到 `develop`**，第二天服务器就会用上。管理员发 `/status`，第一行的版本号就是正在运行的提交。
- **CI**：GitHub Actions 在 2026-11-20 开启（仓库设置 Actions → Allow all actions），每个 PR 都会跑检查。

## 必须遵守

- **不花钱**：只用永久免费资源。Oracle 账户已升级为按量付费（因为米兰区域免费容量不足），但只用 Always Free 额度，并设了预算提醒。
- 免费的 Arm 额度（4 OCPU / 24 GB）分成两台：一台 1 OCPU / 6 GB 给本机器人，另一份留给主人的另一个聊天机器人项目。**任何部署命令都要带 `GRAM_OCPUS=1 GRAM_MEMORY_GB=6`。**
- 主人不是技术人员，用中文交流：回复要简短、直白，尽量给"一条命令"的方案，能自己做的就自己做。
- 仓库是公开的：不要提交令牌、密码、IP、邮箱等任何密钥或个人信息。

## 手动重新部署（一般不需要）

在 Oracle Cloud 控制台打开 Cloud Shell，运行：

```bash
GRAM_OCPUS=1 GRAM_MEMORY_GB=6 bash <(curl -fsSL https://raw.githubusercontent.com/Kukutx/gram/develop/deploy/oracle-free.sh)
```

重复运行不会再提问（令牌已保存在服务器上；要换令牌加 `GRAM_CHANGE_TOKEN=1`）。刚合并完时 raw 地址有约 5 分钟缓存，可以把 `develop` 换成具体的提交 SHA。Cloud Shell 是 FIPS 环境（不能用 ed25519 密钥），长时间不动会断开。

## 本地开发

- Node 24 + pnpm。`pnpm install`，然后 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build`（`build` / `typecheck` 需要设置 `DATABASE_URL`）。
- 集成测试需要 PostgreSQL：设置 `TEST_DATABASE_URL`，先 `pnpm exec prisma migrate deploy`，再 `pnpm test:integration`。测试共用一个数据库，所以测试里要用自己的用户 / 聊天 ID，不要依赖别的测试留下的数据。

## 给 AI 会话的提示

- 云端容器连不上 Oracle（代理拦截），服务器只能通过 Cloud Shell 或自动更新来改。
- 真机测试的办法：经主人同意，用 computer use 操作主人电脑上的 Telegram Desktop。管理员就是主人自己的账号，所以给自己的工单回复要用 `/reply <编号> <内容>`（直接回复通知会被当成用户追问）。
- 系统自动发的状态通知存成 `authorId = 0` 的消息（`SYSTEM_AUTHOR`），统计和列表里不算对话。

## 可以继续改进的地方（都不紧急）

- 点了通知下方的按钮后，只更新按钮，通知正文里的状态文字还是旧的。
- 几个旧的 Dependabot PR 已经过时，可以关掉，或者等 Dependabot 重新生成。
- 计划搬进 "Viper" 单仓库；本仓库目前是备份。
