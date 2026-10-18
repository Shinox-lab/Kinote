import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/*.pg.test.ts', '**/node_modules/**', 'e2e/**'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@living-wiki/contracts': r('./packages/contracts/src/index.ts'),
      '@living-wiki/core': r('./packages/core/src/index.ts'),
      '@living-wiki/db': r('./packages/db/src/index.ts'),
      '@living-wiki/shared': r('./packages/shared/src/index.ts'),
      '@living-wiki/api': r('./apps/api/src/server.ts'),
      '@living-wiki/collab': r('./apps/collab/src/server.ts'),
      '@living-wiki/worker': r('./apps/worker/src/runner.ts'),
      '@living-wiki/web': r('./apps/web/src/App.tsx'),
    },
  },
});
