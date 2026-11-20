# v1.5 验收入口

当前本地闭环证据见 [CLOSURE_1_5.md](CLOSURE_1_5.md)。新增迁移、一次性删除、回复流程、PostgreSQL-only Worker、摘要部署及验证 Job 见 [UPGRADE_1_5.md](UPGRADE_1_5.md)。下面清单仍供真实环境验收使用，不能因本地检查通过就自动勾选云端项目。

---

# 生产验收清单 · v1.4.0

这是可操作的发布门槛，不是已经完成的验收报告。**缺少真实 Token/云账号和联网依赖时，不能给“已验证生产可用”的结论。**

## Gate A — 构建和供应链

- [ ] 用 Node.js 24 和 pnpm 10.21.0 生成并**提交** `pnpm-lock.yaml`（不要手动伪造内容）。
- [ ] `pnpm install --frozen-lockfile`、`pnpm db:generate`、`pnpm db:validate`、`pnpm check`、`pnpm smoke:offline` 全部通过。
- [ ] 测试仓库有独立的 `TEST_DATABASE_URL`，不是生产数据库；已成功运行实际 PostgreSQL 集成测试。
- [ ] `docker build -t grammy:staging .`，并确认 Worker 容器 `node dist/worker.js` 可启动。
- [ ] 检查 CodeQL、依赖升级 PR、容器镜像扫描；禁用依赖脚本或更新依赖之前评估影响。

## Gate B — Telegram / 安全

- [ ] 使用 staging Bot Token 完成 grammY getMe/启动、命令同步、键盘回调和私聊业务的真实集成测试。
- [ ] Webhook 无 `X-Telegram-Bot-Api-Secret-Token` 或错误密钥返回 401，有效请求可达。
- [ ] 用 5 分钟内和已过期的删除确认按钮、不同用户操作的按钮做验证；确认删除后反馈和用户数据均不存在。
- [ ] 启用限流后，个人数据导出和删除确认仍可用。确认链接预览不会出现在管理员通知。
- [ ] `WEBHOOK_MAX_CONNECTIONS=1` 为默认值；若改为 >1，必须重做乱序/重复更新故障测试。
- [ ] Secret Manager 仅授予必要服务身份；Webhook Secret、Token 和数据库密码不在 Git / Docker image 中。

## Gate C — 可靠性 / 数据

- [ ] PostgreSQL 自动备份和 PITR 已开启，恢复演练成功；应用数据库身份没有 Schema 修改权限。
- [ ] Redis `maxmemory-policy=noeviction`、TLS/VPC、内存容量和持久化选型符合 BullMQ 官方要求。
- [ ] Redis 停机时反馈仍成功写库，恢复后 Worker 能扫描并送达；终态失败任务能冷却后重试。
- [ ] 运行两个 Worker 做并发租约测试；重复发送窗口的约束和上游外部幂等限制已接受。
- [ ] Sentry 或等价系统能收到严重通知积压事件；`pnpm outbox:status` 可用于定期检查。
- [ ] Cloud Run 服务 liveness/readiness 与 Worker Pool 日志正确；检查长期积压、失败率、数据库连接占用与成本。

## Gate D — 发布 / 回滚

- [ ] 在独立 staging 环境先发布 migrations → Bot → Worker，随后运行 Webhook 联调。
- [ ] Github production Environment 有审批；GCP Workload Identity Federation 不使用长期密钥。
- [ ] 用不可变镜像 tag 发布；保存上一个兼容镜像与 Terraform/资源配置快照（如已管理）。
- [ ] 通过 Cloud SQL 恢复验证、Worker/Redis 灾难恢复演练、模拟 Telegram 429/5xx。
- [ ] 有处理 Bot Token 泄露、数据库故障、任务积压、过量费用和用户数据请求的值班流程。

## 验收边界

通过全部 Gate 后才可考虑生产上线；系统仍需持续升级和监测，无法以一次测试永久保证“零故障”。不要将「离线 TypeScript 语法检查」误称为完整依赖类型检查，也不要将单机通过误称为 GCP 生产验收。
