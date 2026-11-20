# v1.5 当前验证

下方为修复前 v1.4 的历史制作记录。v1.5 已实际联网安装、执行类型检查和真实数据库/Redis 测试；当前完整结果与未完成的外部验收见 [CLOSURE_1_5.md](CLOSURE_1_5.md)。

---

# 验证说明（v1.4.0）

该项目包含完整源码、2 份历史 SQL migration（本次无新 migration）、自动化测试、Docker 与 GCP 部署配置；**没有真实接入 Telegram/GCP**。

## 本次制作环境实际完成的检查

- 本地 TypeScript AST / transpile 检查：**44 个 TypeScript 文件、87 个项目内相对导入、0 个语法/引用错误**；该检查不解析第三方依赖类型。
- `node --experimental-strip-types scripts/offline-smoke.mjs`：**42 项实际断言通过**（本次运行环境 Node.js 22.16 的实验性 type stripping；生产目标仍是 Node.js 24）。覆盖删除确认/限流放行、反馈校验、数据导出、Unicode 长度、积压判断、租约与保留期。
- JSON 配置解析通过、**7 个 YAML** 文件解析通过；`bash -n` Shell 脚本语法检查通过。检查了 Dockerfile 和 GCP 生产脚本中锁文件的强制发布门槛。
- 生成项目 `MANIFEST.sha256`，核验 ZIP CRC、文件路径、归档内容及完整文件清单。

这些是**离线源码、纯函数及打包检查**，不构成类型检查或生产端到端验收。

## 未完成且不能宣称通过的检查

- 无法连接 npm Registry，因此不能生成真实 `pnpm-lock.yaml`、安装依赖、执行完整的 `pnpm typecheck`、Vitest、ESLint、Prisma Client generate/migrate 或 Docker 构建。
- 没有你的 BotFather Token、GCP 权限或数据库凭据，无法验证 Telegram API、Cloud SQL、Memorystore、GCP Worker Pool 与 CI/CD 真正部署。
- 未进行性能负载测试、故障注入、生产安全审计、隐私合规法律审核或 SLA 验收。

## 联网后的验收顺序

1. 安装 Node.js 24、pnpm 10，使用真正的 BotFather Token、**独立测试数据库**。
2. `pnpm deps:lock`，将生成的 `pnpm-lock.yaml` 提交 Git；没有 npm 网络时可用 GitHub Actions 手动工作流生成并下载该文件。
3. `pnpm install --frozen-lockfile && pnpm db:generate && pnpm db:deploy`；随后运行 `pnpm release:verify`。
4. `docker build -t grammy-bot:validation .`，确认生产构建使用锁文件。
5. Long Polling 下启动 `pnpm dev` + `pnpm dev:worker`，测试双语、命令、菜单、反馈、重复更新、`/export_my_data` 的多页分页与恶意游标拒绝、管理员消息及数据删除。
6. 测试 emoji/长消息、Redis 中断、数据库重连、Worker 重启和重复投递；运行 `pnpm outbox:status` 核对积压数量、退出码和恢复。
7. 在 staging 使用 Webhook，校验 Telegram Secret Token、健康检查、HTTPS、Cloud SQL、Memorystore `noeviction`、Secret Manager 和最小权限。
8. 使用 GitHub 生产 Environment 审批发布；检查 `pnpm webhook:status`、`/ready`、Worker 日志、持续积压及数据保留策略。

## 资料

- grammY：https://grammy.dev/
- Prisma 7：https://www.prisma.io/docs/orm/v7
- BullMQ：https://docs.bullmq.io/
- Cloud Run Worker Pools：https://cloud.google.com/run/docs/deploy-worker-pools

## v1.4 新增验收项

- `src/privacy/delete-confirm.ts` 的 HMAC 签名、用户绑定、最长 64 字节 callback、5 分钟失效，以及权限拒绝路径。
- 开启限流后，测试 `/export_my_data` 和 `erase:` 回调不会被误拦截。
- Telegram 用户点击已确认/已过期/已取消按钮和转发给不同用户的按钮，确认不会误删。
- 用实际反馈包含 URL 的数据，检查管理员通知不出现 URL 预览。
- 运行管理员 `/status`、Worker 堵塞/Redis 停机演练，并确认积压日志和 Sentry（如果开启）。
- 真正执行 `pnpm release:verify`、PostgreSQL 集成测试和 Docker Cloud Run 部署验收。
- 更多 Gate 见 `PRODUCTION_READINESS.md`。
