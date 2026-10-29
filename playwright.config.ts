// Browser specs for the console. Two ways to run them:
//   pnpm e2e:local   E2E_MODE=local: starts e2e/harness/local-stack.ts (api, collab and worker
//                    on PGlite, plus the built console) and stops it afterwards. No Docker.
//   pnpm e2e         brings up the compose stack (infra/e2e.sh), then serves the console with
//                    `vite dev` on 5173 against the stack's api (8787) and collab (1234).
import { defineConfig, devices } from '@playwright/test';

const local = process.env.E2E_MODE === 'local';
const webPort = Number(process.env.E2E_WEB_PORT ?? (local ? 15173 : 5173));
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // The specs share one stack and each builds its own workspace; they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1300, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1300, height: 900 } } }],
  webServer: local
    ? {
        command: 'node --import tsx e2e/harness/local-stack.ts',
        url: baseURL,
        // Ready once the console answers: the harness starts it after the api, collab and worker.
        timeout: 120_000,
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
        stderr: 'pipe',
      }
    : {
        command: `pnpm --filter @kinote/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
        url: baseURL,
        timeout: 120_000,
        // Never adopt a console some other session left on the port: it may proxy to another stack.
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      },
});
