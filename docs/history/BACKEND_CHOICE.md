# 后端部署选择

评估日期：2026-11-06，2026-11-09 复核官方文档。当前项目本身就是 TypeScript 后端，不需要另加一套后端框架。

## 当前推荐

保留 **Node.js 24 + TypeScript + grammY + PostgreSQL/Prisma**。小到中等规模默认使用 PostgreSQL 持久 Outbox 和独立 Worker，不必启用 Redis。已使用 GCP 时继续 Cloud Run HTTP 服务 + Worker Pool + Cloud SQL；预算优先、能自行维护服务器时，可以在一台容器主机上部署相同的 Bot/Worker，并配备数据库备份和外部监控。

这一选择复用现有事务、租约、迁移与测试，降低当前改造量。Redis/BullMQ 作为可选加速路径保留，只有实际吞吐或队列需求需要时再启用。选托管 PostgreSQL 时应将应用与数据库放在相近区域，核对连接池、备份、恢复和最小权限；本次不替用户创建付费云资源。

## Cloudflare Workers 可以用吗

可以。grammY 有 [Cloudflare Workers Node.js 官方部署入口](https://grammy.dev/hosting/cloudflare-workers-nodejs)。Cloudflare 也支持通过 [Hyperdrive 和 node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/) 访问 PostgreSQL；不必为了使用 Workers 就把数据库换成 D1。

但当前仓库不能直接把 `node dist/index.js` 上传成 Worker。需要实现平台入口，并把常驻调度器改成事件处理器：

| 当前实现                  | Workers 对应实现                                             |
| ------------------------- | ------------------------------------------------------------ |
| Fastify 监听端口          | fetch(Request) + grammY webhook 适配                         |
| 独立常驻 Worker / BullMQ  | Cloudflare Queues 消费处理器                                 |
| 每隔数秒扫描数据库        | Cron scheduled 事件进行补偿与保留清理                        |
| Node 进程级 Prisma 连接池 | 按 Workers 生命周期适配的 PostgreSQL 连接，优先 Hyperdrive   |
| 进程本地限流兜底          | 按平台能力重新验证分布式限流；有严格需要再用 Durable Objects |
| 常驻 Worker 心跳          | 按 queue/scheduled 执行成功时间和积压设置外部监控            |
| 容器环境变量              | Wrangler bindings / secrets                                  |

Cloudflare Queues 采用[至少一次投递](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)，因此数据库幂等和发送租约仍要保留；还要配置死信队列与人工恢复。清理及补偿可由 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 驱动。不能只依靠 HTTP 响应后的临时后台执行来保证投递。

这些是基于官方文档和当前代码的适配判断。没有在本次工作中新增或部署未经验证的 Workers 分支，也没有宣称 Node 兼容模式会自动解决所有依赖和生命周期差异。

## 如何决定

- 想尽快稳定交付当前版本：选择现有 Node 容器方案和 PostgreSQL。
- 明确偏好 Cloudflare、希望把队列和调度交给平台，并接受重新适配和验收：选择 Workers + Queues + Cron + Hyperdrive + PostgreSQL。
- 仅为一个简单 Bot：先用 PostgreSQL-only 模式，避免同时维护多个不必要的基础设施组件。

迁移到 Workers 的完成标准包括：本地 workerd/Wrangler 验证、所有数据与权限回归、实际 PostgreSQL 并发事务、Queues 重复/失败/死信恢复、scheduled 清理、真实 Telegram 联调及平台资源限额测试。当前完成的 Node 测试不能替代这些验收。
