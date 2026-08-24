import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/admin-fullstack.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.SFOA_P5_E2E_WEB_URL ?? 'http://127.0.0.1:15173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-fullstack', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
