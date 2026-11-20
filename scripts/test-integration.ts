import { spawnSync } from 'node:child_process';

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    'Set TEST_DATABASE_URL to an isolated, migrated test database; integration checks must not silently skip.',
  );
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    // The suites share one outbox; running them one at a time keeps workers from sending each other's rows.
    '--no-file-parallelism',
    'tests/database.integration.test.ts',
    'tests/workflows.integration.test.ts',
    'tests/worker.integration.test.ts',
  ],
  { stdio: 'inherit', env: process.env },
);
process.exitCode = result.status ?? 1;
