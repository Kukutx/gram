import { spawnSync } from 'node:child_process';

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL)
  throw new Error(
    'Set TEST_DATABASE_URL and TEST_REDIS_URL to isolated test services; integration checks must not silently skip.',
  );
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/database.integration.test.ts',
    'tests/workflows.integration.test.ts',
    'tests/worker.integration.test.ts',
  ],
  { stdio: 'inherit', env: process.env },
);
process.exitCode = result.status ?? 1;
