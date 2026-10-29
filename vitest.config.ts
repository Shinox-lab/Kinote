import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/*.pg.test.ts', '**/node_modules/**', 'e2e/**'],
    testTimeout: 30000,
    env: {
      COLLAB_TOKEN_SECRET: 'test-collab-token-secret-0123456789abcdef',
    },
  },
  resolve: {
    alias: {
      '@kinote/contracts': r('./packages/contracts/src/index.ts'),
      '@kinote/core': r('./packages/core/src/index.ts'),
      '@kinote/db/testing': r('./packages/db/src/testing.ts'),
      '@kinote/db': r('./packages/db/src/index.ts'),
      '@kinote/shared': r('./packages/shared/src/index.ts'),
      '@kinote/api': r('./apps/api/src/server.ts'),
      '@kinote/collab': r('./apps/collab/src/server.ts'),
      '@kinote/worker': r('./apps/worker/src/runner.ts'),
    },
  },
});
