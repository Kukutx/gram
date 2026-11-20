import 'dotenv/config';
import { parseConfig, hasSupportTeam } from '../src/config/env.ts';
import { createPrisma } from '../src/db/client.ts';
import { operationsHealth } from '../src/observability/operations.ts';

/** An operator diagnostic: outputs only aggregate counts, never message text or secrets. */
async function main(): Promise<void> {
  const config = parseConfig();
  const db = createPrisma(config);
  const now = new Date();
  try {
    await db.$connect();
    const [byStatus, activeLeases, operational] = await Promise.all([
      db.delivery.groupBy({ by: ['status'], _count: { _all: true } }),
      db.delivery.count({ where: { status: 'pending', leaseUntil: { gt: now } } }),
      operationsHealth(db, config, now),
    ]);
    const deliveries = Object.fromEntries(byStatus.map((row) => [row.status, row._count._all]));
    console.log(
      JSON.stringify(
        {
          asOf: now.toISOString(),
          notificationsConfigured: hasSupportTeam(config),
          deliveries,
          activeLeases,
          operational,
        },
        null,
        2,
      ),
    );
    if (!operational.healthy) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  // Avoid accidentally serializing sensitive connection strings.
  console.error('Outbox diagnostic failed; check database connectivity and DATABASE_URL.');
  process.exitCode = 1;
});
