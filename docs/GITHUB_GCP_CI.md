# GitHub Actions → GCP：仅手动发布，Workload Identity Federation

> v1.5：生产部署前先运行同一提交的复用 CI；新增 GCP_METRICS_TOKEN_SECRET（必需）、Sentry 可选 Secret、GCP_REDIS_ENABLED、联系与隐私策略变量。bootstrap 输入只供首次注册前使用；可提供同一提交、已通过 staging 的 Bot/Migrator 摘要进行晋级。具体参数以 `.env.gcp.example` 和 [UPGRADE_1_5.md](UPGRADE_1_5.md) 为准。

工作流：`.github/workflows/cd-gcp.yml`。使用 OIDC 临时凭证，**不要**上传服务账号 JSON 私钥。

## 你需要在 GCP 准备

1. 一个 Workload Identity Pool / Provider，信任指定 GitHub 仓库及 `environment:production` 对应的 OIDC 属性；务必限制仓库及分支引用，避免任意仓库能冒用云身份。
2. 专用部署 Service Account，赋予 Cloud Build 触发、Cloud Run 服务/Job/Worker Pool 更新、Artifact Registry、部署所需 `iam.serviceAccountUser` 等最小权限。
3. 已存在的 Cloud SQL、Memorystore、Secret Manager、Cloud Run Service Account、网络和 GCP 所需 API；参见 `docs/GCP_DEPLOY.md`。在运行服务身份上逐个 Secret 授权访问。

## 你需要在 GitHub 准备

1. Settings → Environments → `production`，启用 Required reviewers，禁止未审核发布。
2. 仓库或 production Environment 的 **Variables** 设置：`GCP_WIF_PROVIDER`（完整 Provider 资源名），`GCP_DEPLOY_SERVICE_ACCOUNT`（部署服务账号邮箱）。
3. 将 `.env.gcp.example` 内所有 `GCP_...` **非密钥标识和密钥名称**以同名 Variables 提供。建议给 `GCP_*_VERSION` 提供数字版 Secret Manager 版本。
4. Workflows → **GCP production deployment (manual)** → Run workflow；通过生产环境审批后才会运行。工作流只部署云资源，**不会自动注册 Webhook**，避免误切换 Telegram 更新流。

## 保护措施

- 工作流只经 `workflow_dispatch` 触发，不因普通提交自动发布。
- `id-token: write` 只用于 OIDC 身份认证，不包含永久 GCP 服务账号密钥。
- `production-gcp` 并发组避免两个生产部署交叉执行。
- 资源名称、Secret Manager ID 可以位于 GitHub Variables，但真实 Token、数据库密码、Webhook Secret 只存于 GCP Secret Manager。
- GCP 配额、Cloud SQL、VPC、Cloud Run Worker Pool 和 IAM 权限必须先建立；工作流不擅自创建云资源。
