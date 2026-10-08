import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  reporter: [['line'], ['list']],
  outputDir: 'test-results',
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure', viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
