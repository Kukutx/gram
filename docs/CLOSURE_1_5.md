# v1.5 闭环与验证记录

完成记录：2026-11-09（Europe/Rome）。工作开始于 2026-11-06；原源码已移动到 `A:/Project/ProjectWaiting/Viper/gram`，本轮在新目录继续完成。原始审查结果保留在 PROJECT_AUDIT_2026-11-06.md，描述修复前状态。

## 交付结果

已补齐单 Bot、单管理员的反馈处理流程：提交 → 受理 → 持久化回复 → 异步送达 → 解决 → 结案/重新打开，并提供用户状态查询和管理员故障处置。

已修复构建/类型/lint/断言、错误日志泄露、删除回调失败阻断、旧命令重放与删除确认复用等问题。维护 Worker 可仅使用 PostgreSQL；Redis 为可选加速。新增第三次 SQL migration，部署前必须先迁移。旧 Worker 不理解暂停/阻塞状态，启用新投递控制前必须停用旧 Worker。

## 实际执行证据

| 检查                                 | 结果                         | 范围                                                      |
| ------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| pnpm 10.21.0 frozen install          | 通过                         | 真实 pnpm-lock.yaml；移动目录后重新安装以修复本地依赖链接 |
| Prisma generate / validate           | 通过                         | Prisma 7.10.1                                             |
| PostgreSQL 17 migration deploy       | 通过                         | 三次迁移；独立测试容器                                    |
| Prisma migrate diff                  | 无差异                       | 数据库与 schema.prisma 一致                               |
| 完整类型检查、ESLint、格式检查、编译 | 通过                         | 源码、脚本与测试；没有通过排除失败文件绕过检查            |
| 离线冒烟                             | 42 项断言通过                | 纯函数与有限数据库替身                                    |
| Windows 全量测试                     | 64 通过，7 个 Linux 测试跳过 | PostgreSQL 17 和 Redis 7 真实连接                         |
| Linux 容器全量测试                   | 71 通过，0 跳过，18 个文件   | 包括 7 个部署脚本合同测试                                 |
| 强制集成测试入口                     | 18 通过                      | 缺少 TEST_DATABASE_URL 或 TEST_REDIS_URL 时直接失败       |
| 依赖审计                             | 无已知漏洞命中               | 本次锁定依赖树，含开发依赖；不等同于永久无漏洞            |
| Bot 运行镜像构建                     | 通过                         | 冻结安装、生产编译、裁剪开发依赖、非 root 用户 app        |
| Migrator/验证工具镜像构建及迁移执行  | 通过                         | 已补 OpenSSL/CA 证书，消除原缺失提示                      |
| HTTP 运行镜像冒烟                    | 通过                         | 8 项检查，另核实数据库仅有一条对应反馈                    |
| HTTP/Worker 容器关停                 | 均退出 0，未 OOM             | 使用 SIGTERM，十秒预算内正常结束                          |
| Shell 语法                           | 通过                         | scripts/gcp/deploy.sh                                     |

HTTP 冒烟覆盖 `/live`、`/ready`、`/ops/health` 无鉴权拒绝及正确鉴权/当前发布心跳、Webhook 无密钥拒绝、正确密钥命令、保存反馈和命令重放。API 传输由只挂载到测试容器的合成 Telegram 替身完成，生产源码没有加入跳过鉴权或伪造 botInfo 的开关。**这不是与真实 Telegram 的联调。**

数据库和队列测试覆盖：并发重复更新、竞争租约、旧状态拒绝、数据与回复分页隔离、级联删除、取消/消费 nonce、账户重建后旧确认拒绝、回调应答失败仍删除、Webhook 回复失败后重放不覆盖后续取消、管理员越权拒绝、临时错误冷却、永久错误阻塞及人工恢复、Redis 不可用时维护与关停、Redis 出队与补偿、不同发布版本心跳隔离。

部署测试使用合成 gcloud/docker/python3 命令替身，验证调用与控制流程：摘要镜像、监控秘密不被清掉、Secret 数字版本、源码 revision 不匹配拒绝、staging 摘要不重建、Worker 部署或发布后验证失败时尝试恢复 Bot/Worker 配置、bootstrap 与 verified 状态区分。**它们没有验证真实 GCP IAM、组织策略、网络或 API 服务端行为。**

## 原审查 15 项对照

| 编号 | 问题                | 当前完成项                                                    | 外部待完成项                                 |
| ---- | ------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| 1    | 无锁文件            | 真实锁文件和 frozen 本地/容器构建                             | 提交到实际维护仓库                           |
| 2    | 类型/编译失败       | 完整检查通过                                                  | 实际仓库 CI 运行记录                         |
| 3    | 测试/lint 门禁失败  | 断言、Node globals、规则错误修复；CI 含格式与依赖审计         | 配置仓库分支保护                             |
| 4    | 异常日志泄露        | Pino 白名单、Sentry 严格事件过滤及隐私回归                    | 真实遥测接收端复核                           |
| 5    | 回调失败阻断删除    | 数据库删除先完成，应答尽力；真实数据库/Webhook 回归           | staging 按钮实测                             |
| 6    | Worker Redis 阻塞   | 独立连接和调度、有界等待、取消在途请求、关停时限              | 云平台断网/重启演练                          |
| 7    | CD 未绑定质量       | 同一提交 CI 前置、摘要与 revision、发布验证、恢复脚本         | WIF/IAM/Environment 审批配置、实际发布和恢复 |
| 8    | 命令重放            | 事务回执、按用户序列化及旧更新保护                            | 高负载与乱序验收                             |
| 9    | 确认码复用          | 数据库 nonce 一次消费、可取消、账户重建后失效                 | 真实 Telegram 交互验收                       |
| 10   | 保留清理耦合        | 无 Redis/管理员也运行维护；心跳与延期监控                     | 持续运行 Worker、确定保留政策                |
| 11   | 重部署清掉监控      | 显式配置 Metrics/Sentry Secret、增量更新；默认关闭 Redis      | 创建真实 Secret 与连续部署验证               |
| 12   | 永久失败无人结案    | 错误码/时间/次数、blocked、查询、重试/暂停/终止、操作历史     | 运营值班接管                                 |
| 13   | Worker 停止无人发现 | 数据库版本心跳、外部健康端点、探针及 Prometheus 告警规则      | 真实报警接收与停机演练                       |
| 14   | 故障/并发验证不足   | PostgreSQL 17/Redis 7、Webhook、队列与部署合同测试，71 项通过 | 真实 Telegram 429/5xx、云网络和目标负载验证  |
| 15   | 隐私副本说明不足    | 用户可见中英文说明、联系/策略配置、回复导出、备份恢复处理步骤 | 运营联系人、实际备份/删除请求登记与恢复演练  |

## 如何复现

使用独立测试数据库和 Redis，先执行 `pnpm db:deploy`，将 DATABASE_URL、TEST_DATABASE_URL 和 TEST_REDIS_URL 指向这些资源：

```bash
pnpm install --frozen-lockfile
pnpm release:verify
pnpm test:integration
pnpm audit --audit-level moderate
docker build -t grammy-bot:validation .
docker build --target migrations -t grammy-bot:validation-tools .
```

Windows 会明确跳过 7 个 Linux Shell 测试，应在 Linux CI 或工具镜像中运行全量测试。工具镜像通过 Docker 网络连接测试 PostgreSQL/Redis 后执行 `pnpm test`。只用假 Token 和传输替身的测试不会连接真实 Telegram。

## 上线前仍需实际完成

1. 将源码和锁文件提交到真实 Git 仓库，配置分支保护、生产 Environment 审批及 WIF 最小权限。本目录没有 Git 元数据，未伪造提交或 PR。
2. 提供独立 staging Bot Token、数据库和部署权限，真实验证 getMe、命令、语言菜单、反馈通知与管理员回复、分页导出、按钮取消/删除和旧回调。
3. 创建 Metrics/Sentry 等真实 Secret，配置外部告警接收人，停 Worker/断 Redis/断数据库演练；记录恢复时间与目标。
4. 完成实际 GCP 发布和回滚；首次 bootstrap 后注册 Webhook，关闭 bootstrap 再执行验证 Job。
5. 开启并验证数据库备份/PITR；在独立受控系统登记恢复点之后的删除请求，恢复到隔离环境后重放删除并核实 Outbox，再恢复通知。

## 后续维护与平台建议

当前推荐 Node 容器 + PostgreSQL，低到中等负载默认 PostgreSQL-only。需要 GCP 托管时沿用 Cloud Run/Cloud SQL/Worker Pool；希望自己维护服务器时可部署同一套容器。Cloudflare Workers 可以承载 grammY，但需要 fetch 入口、Queues、scheduled 清理和 Hyperdrive/PostgreSQL 适配；本次没有把未经验证的 Workers 实现混入稳定路径。详见 BACKEND_CHOICE.md。

依赖注册表仍对 ESLint 9、prom-client 15 及部分传递包给出弃用提示。当前锁定版本已通过测试与漏洞审计，未来主版本迁移应单独评估兼容性，不能用一次审计替代持续维护。已发送通知可能重复、在途通知与删除并发、Telegram/备份副本无法自动撤回等边界仍如文档所述。
