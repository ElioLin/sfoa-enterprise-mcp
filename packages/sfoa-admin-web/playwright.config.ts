import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/admin-fullstack.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'yarn dev',
    url: 'http://127.0.0.1:5173/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
