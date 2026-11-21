import { defineConfig } from '@playwright/test';

/* Agent 10 (wave 4): chaos E2E suite. Loopback only, own ports >= 3002 (never 3000),
   pg-mem + mock/fixture AI provider, no .env, no real keys, no external network. */
const env = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 3002 || value === 3000) throw new Error(name + ' must be a port >= 3002');
  return String(value);
};
const API = env('CHAOS_API_PORT', 3012), WEB = env('CHAOS_WEB_PORT', 3013);
const PUBLIC = env('CHAOS_PUBLIC_PORT', 3014), JOBS_WEB = env('CHAOS_JOBS_WEB_PORT', 3015);
const ports = { CHAOS_API_PORT: API, CHAOS_WEB_PORT: WEB, CHAOS_PUBLIC_PORT: PUBLIC, CHAOS_JOBS_WEB_PORT: JOBS_WEB };
/* Explicitly blank provider keys so an inherited shell variable can never reach a real provider. */
const noKeys = { MISTRAL_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DATABASE_URL: '', REDIS_URL: '', STRIPE_SECRET_KEY: '', AGENT_JOBS_WORKER: '' };
const vite = (port: string, extra: Record<string, string>) => ({
  command: 'node node_modules/vite/bin/vite.js --config tests/e2e/chaos/vite.chaos.config.ts',
  cwd: '../../../',
  url: `http://localhost:${port}/`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { ...ports, ...noKeys, CHAOS_WEB_PORT: port, VITE_API_PROXY_TARGET: `http://127.0.0.1:${API}`, ...extra },
});

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: Number(process.env.CHAOS_TEST_TIMEOUT ?? 120_000),
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure', viewport: { width: 1280, height: 800 } },
  webServer: [
    {
      command: 'node --import tsx tests/fixtures/chaosUiServer.ts',
      cwd: '../../../',
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...ports, ...noKeys, CHAOS_UI_FIXTURE: '1', NODE_ENV: 'test', LOV_SERVER: '0' },
    },
    /* Default client: SSE /api/agent/generate (durable client flag off). */
    vite(WEB, { VITE_AGENT_JOBS_CLIENT: '0' }),
    /* Durable client flag on: POST /api/agent/jobs first (server has no worker → 503 agent_jobs_disabled). */
    vite(JOBS_WEB, { VITE_AGENT_JOBS_CLIENT: '1' }),
  ],
});
