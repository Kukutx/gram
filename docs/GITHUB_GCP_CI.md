# GitHub Actions → GCP：仅手动发布，Workload Identity Federation

> 发布前会先对同一提交运行 CI。需要的变量以 `.env.gcp.example` 为准，包括 `GCP_ADMIN_IDS`、可选的 `GCP_ADMIN_CHAT_ID` / `GCP_ADMIN_USE_TOPICS` / `GCP_INTAKE_MODE`、必填的 `GCP_METRICS_TOKEN_SECRET` 和可选的 Sentry Secret。`bootstrap` 输入只在首次注册 webhook 前使用；也可以把已在 staging 验证过的同一提交镜像摘要直接晋级到生产。

工作流：`.github/workflows/cd-gcp.yml`。使用 OIDC 临时凭证，**不要**上传服务账号 JSON 私钥。

## 你需要在 GCP 准备

1. 一个 Workload Identity Pool / Provider，信任指定 GitHub 仓库及 `environment:production` 对应的 OIDC 属性；务必限制仓库及分支引用，避免任意仓库能冒用云身份。
2. 专用部署 Service Account，赋予 Cloud Build 触发、Cloud Run 服务/Job/Worker Pool 更新、Artifact Registry、部署所需 `iam.serviceAccountUser` 等最小权限。
3. 已存在的 Cloud SQL、Secret Manager、（可选）Memorystore、Cloud Run Service Account、网络和 GCP 所需 API；参见 `docs/GCP_DEPLOY.md`。在运行服务身份上逐个 Secret 授权访问。

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
