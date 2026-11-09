# 生产发布与依赖锁定

> v1.5 已提交真实锁文件到当前工作目录，CI 增加格式、依赖审计和真实 Redis 测试，CD 依赖同一提交 CI。部署、摘要晋级、验证与恢复详见 [UPGRADE_1_5.md](UPGRADE_1_5.md)。当前目录没有 Git 元数据，仍需维护方将变更和锁文件提交到实际仓库。

v1.4.0 严格区分**可审阅源码**和**已经联网构建验收的制品**。

## 为什么必须要 `pnpm-lock.yaml`

仅有 `package.json` 中的主版本范围不能锁住传递依赖，可能导致昨天与今天同一提交构建出不同镜像。生产 Dockerfile 和 `scripts/gcp/deploy.sh` 会在缺少真实锁文件时退出。不要复制一个手工拼凑的锁文件。

- 联网本地：`pnpm deps:lock` -> `git add pnpm-lock.yaml && git commit ...`。
- 没有本地 npm 网络：在 GitHub Actions 手动触发 **Generate dependency lockfile (manual)**，下载工件中的 `pnpm-lock.yaml`，纳入 Git 后继续 CI/CD。
- 生产镜像：`pnpm install --frozen-lockfile`，安装内容必须与锁文件一致。
- CI 也严格要求仓库**已有提交的锁文件**，不会在检查阶段临时生成；否则 CI 和生产 CD 均明确拒绝。

## 发布门槛

1. 提交匹配代码的锁文件并经过 PR review。
2. 运行 `pnpm release:verify` 及 Docker 构建。CI 集成测试连接**独立的** PostgreSQL。
3. 在 staging 使用真实 Telegram Bot Token 验证 Webhook、语言菜单、隐私数据导出、反馈投递与队列重试。
4. 备份 Cloud SQL，手动批准 production CD；优先保留上一版 Cloud Run/Worker 镜像以便快速回滚。
5. 发布后观测 `pnpm outbox:status`、`/ready`、Worker 日志、Sentry 和反馈通知积压。

## 操作边界

Cloud Run Worker Pool 仍需常驻实例才能持续补偿与推送通知；停用 Worker 会导致 PostgreSQL 待通知记录累积。Telegram 与 PostgreSQL 之间不可能由本项目保证物理上的 exactly-once 跨系统消息投递。故障期间可能重复管理员通知，应以反馈 ID 人工/程序去重。

## v1.4 新验收文档

分环境、权限、Telegram/Webhook、数据与恢复的完整检查见 [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)。
