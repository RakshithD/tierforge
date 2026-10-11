import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // black-box e2e needs a live API + worker on a fake enrichment server; run via `npm run test:e2e`
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
