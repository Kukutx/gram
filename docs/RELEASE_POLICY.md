# 生产发布与依赖锁定

仓库里已经提交了真实的锁文件。CI 会运行格式检查、依赖审计和真实 PostgreSQL 集成测试，CD 依赖同一提交的 CI 结果。

## 为什么必须要 `pnpm-lock.yaml`

仅有 `package.json` 中的主版本范围不能锁住传递依赖，可能导致昨天与今天同一提交构建出不同镜像。生产 Dockerfile 和 `scripts/gcp/deploy.sh` 会在缺少真实锁文件时退出。不要复制一个手工拼凑的锁文件。

- 联网本地：`pnpm deps:lock` -> `git add pnpm-lock.yaml && git commit ...`。
- 没有本地 npm 网络：在 GitHub Actions 手动触发 **Generate dependency lockfile (manual)**，下载工件中的 `pnpm-lock.yaml`，纳入 Git 后继续 CI/CD。
- 生产镜像：`pnpm install --frozen-lockfile`，安装内容必须与锁文件一致。
- CI 也严格要求仓库**已有提交的锁文件**，不会在检查阶段临时生成；否则 CI 和生产 CD 均明确拒绝。

## 发布门槛

1. 提交匹配代码的锁文件并经过 PR review。
2. 运行 `pnpm release:verify` 及 Docker 构建。CI 集成测试连接**独立的** PostgreSQL。
3. 在 staging 用真实的 Telegram Bot Token 走一遍：提交工单、客服回复（私聊和群话题各一次）、用户再回复、按钮结案、隐私导出，以及停掉 Worker 再恢复。
4. 备份 Cloud SQL，手动批准 production CD；优先保留上一版 Cloud Run/Worker 镜像以便快速回滚。
5. 发布后观察 `outbox:status`、`/ops/health`、Worker 日志、Sentry，以及发件箱积压和停放数量。

## 操作边界

Worker 必须常驻，所有消息都由它发送；停掉 Worker 会让待发消息在 PostgreSQL 里累积。Telegram 和 PostgreSQL 之间无法保证恰好一次投递，故障时可能有一条消息重复发送。

上线检查清单见 [DEPLOY.md](DEPLOY.md#上线检查清单)。
