import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3200';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Starts the built API and web app unless they are already running (e.g. `npm run dev`).
  webServer: [
    {
      command: 'npm run start -w @convo/api',
      cwd: '../..',
      url: 'http://localhost:4200/health',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: 'npm run start -w @convo/web',
      cwd: '../..',
      url: `${baseURL}/login`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
