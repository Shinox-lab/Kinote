// Browser pass of the Slice 2 live check: the console (vite dev) against a REAL stack (real Docling).
//   LIVE_WEB_PORT=5180 API_HOST_PORT=8800 COLLAB_HOST_PORT=1300 \
//     pnpm exec playwright test -c docs/live-checks/playwright.live.config.ts
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.LIVE_WEB_PORT ?? 5180);

export default defineConfig({
  testDir: '.',
  testMatch: 'browser-pass.spec.ts',
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  outputDir: '../../test-results/live',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1300, height: 900 }, screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1300, height: 900 } } }],
  webServer: {
    command: `pnpm --filter @living-wiki/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
