import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    coverage: { include: ['src/domain/**/*.ts', 'src/config/**/*.ts'] },
  },
});
