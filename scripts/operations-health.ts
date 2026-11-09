import 'dotenv/config';
import { parseConfig } from '../src/config/env.ts';
import { createPrisma } from '../src/db/client.ts';
import { operationsHealth } from '../src/observability/operations.ts';

const config = parseConfig();
const db = createPrisma(config);
try {
  const health = await operationsHealth(db, config);
  console.log(JSON.stringify(health, null, 2));
  if (!health.healthy) process.exitCode = 2;
} catch {
  console.error('Operational check failed; inspect database connectivity.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
