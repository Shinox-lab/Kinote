import { defineConfig, devices } from '@playwright/test';

// The built site, served under the same /Kinote/ base path GitHub Pages uses.
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173/Kinote/' },
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173/Kinote/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
