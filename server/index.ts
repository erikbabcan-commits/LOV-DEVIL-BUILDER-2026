import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { MistralProvider, makeFetchTransport } from './providers/mistral';
import type { AIProvider, ProviderTransport } from './providers/types';
import { runAgent } from './agent/run';
import { AgentEventSchema } from './agent/schemas';
import { SandboxFileSchema, buildProject } from './sandbox/builder';
import { allowedOrigins } from './security/oauthPolicy';
import { githubRouter } from './routes/githubSecure';
import { exportRouter } from './routes/export';
import { LocalBudgetGuard } from './security/budget';
import { containsPotentialSecret, redactSecrets } from './security/secrets';
import { authRouter } from './auth/routes';
import { makeAuthMiddleware, getUserFromContext } from './auth/middleware';
import type { DbLike } from './db/pool';
import type { QuotaStore } from './security/quotaStore';
import { makeInMemoryRateLimiter, type AsyncRateLimiter } from './security/rateLimit';

/* server-side uid (neimportuje client kód) */
const uid = () => Math.random().toString(36).slice(2, 9);

/* Hono backend — server-only Mistral integrácia.
   Trust boundary (single-user pilot): server počúva len na 127.0.0.1,
   MISTRAL_API_KEY je len v serverovom prostredí, klient ho nikdy nevidí. */

export interface ServerConfig {
  mistralApiKey?: string;
  mistralModel?: string;
  mistralBaseUrl?: string;
  port?: number;
  bind?: string;
  rateLimitPerMin?: number;
  requestTimeoutMs?: number;
  aiGenerationEnabled?: boolean;
  publicDeployment?: boolean;
  maxConcurrentRuns?: number;
  maxRunsPerDay?: number;
}

export function makeProvider(cfg: ServerConfig, transport?: ProviderTransport): AIProvider | null {
  if (!cfg.mistralApiKey) return null;
  const baseUrl = cfg.mistralBaseUrl ?? 'https://api.mistral.ai/v1';
  const t =
    transport ??
    makeFetchTransport({
      apiKey: cfg.mistralApiKey,
      baseUrl,
      timeoutMs: cfg.requestTimeoutMs ?? 120_000
    });
  return new MistralProvider(
    { apiKey: cfg.mistralApiKey, model: cfg.mistralModel ?? 'mistral-large-latest', baseUrl },
    t
  );
}

/* jednoduchý in-memory rate limiter (single-user pilot) */
export function makeRateLimiter(maxPerMin: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= maxPerMin) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

export function createApp(
  cfg: ServerConfig,
  provider: AIProvider | null,
  opts?: {
    transport?: ProviderTransport;
    rateLimit?: (k: string) => boolean;
    budget?: LocalBudgetGuard;
    /** WS-1: ak je zadané, auth je zapnutý — všetko okrem /api/health a /api/auth/* vyžaduje prihlásenie. */
    auth?: { db: DbLike; jwtSecret: string; quota: QuotaStore };
    /** Async limiter pre agent/autofix (Redis keď je REDIS_URL; inak per-user memory). */
    agentRateLimit?: AsyncRateLimiter;
  }
) {
  const app = new Hono();
  const trustedOrigins = new Set([...allowedOrigins(), 'http://localhost:5173', 'http://127.0.0.1:5173']);
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !trustedOrigins.has(origin)) return c.json({ error: 'origin_not_allowed' }, 403);
    return next();
  });
  /* CORS: lokálny dev (5173 → 8787) — single-user pilot, loopback only */
  app.use(
    '*',
    cors({
      origin: (origin) => (trustedOrigins.has(origin) ? origin : undefined),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-CSRF-Token'],
      credentials: true
    })
  );
  const rateLimit = opts?.rateLimit ?? makeRateLimiter(cfg.rateLimitPerMin ?? 10);
  const agentRateLimit: AsyncRateLimiter =
    opts?.agentRateLimit ??
    (opts?.rateLimit ? async (k: string) => opts.rateLimit!(k) : makeInMemoryRateLimiter(cfg.rateLimitPerMin ?? 10));
  const budget = opts?.budget ?? new LocalBudgetGuard({ maxConcurrent: cfg.maxConcurrentRuns ?? 2, maxRunsPerDay: cfg.maxRunsPerDay ?? 30 });
  const aiAllowed = () => cfg.aiGenerationEnabled !== false && cfg.publicDeployment !== true;

  /* WS-1: auth middleware (iba keď je opts.auth zapnuté — inak pilot mód bez zmien) */
  if (opts?.auth) {
    app.use('/api/*', makeAuthMiddleware(opts.auth.jwtSecret));
    app.route('/', authRouter(opts.auth));
  }

  app.get('/api/health', (c) => c.json({ ok: true, ai: provider ? 'mistral' : 'not-configured' }));

  /* M3 compile-only build vygenerovaného projektu (esbuild v host procese,
     bez runtime izolácie; výstup je HTML pre sandbox iframe). */
  app.post('/api/sandbox/build', async (c) => {
    if (cfg.publicDeployment) return c.json({ error: 'public_runtime_not_authorized' }, 503);
    if (!rateLimit('sandbox')) return c.json({ error: 'rate_limit' }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    const parsed = SandboxFileSchema.array()
      .max(40)
      .safeParse((body as { files?: unknown })?.files);
    if (!parsed.success)
      return c.json({ error: 'invalid_files', issues: parsed.error.issues.slice(0, 5) }, 400);
    const result = await buildProject(parsed.data);
    return c.json(result);
  });

  /* Step 4: AUTOFIX — build → errors → AI patch → rebuild (max 2 pokusy) */
  app.post('/api/sandbox/autofix', async (c) => {
    if (!aiAllowed()) return c.json({ error: 'ai_disabled' }, 503);
    const autoUser = opts?.auth ? getUserFromContext(c) : null;
    if (!(await agentRateLimit(autoUser ? `autofix:${autoUser.id}` : 'autofix'))) return c.json({ error: 'rate_limit' }, 429);
    if (!provider) return c.json({ error: 'ai_not_configured' }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    const parsed = SandboxFileSchema.array()
      .max(40)
      .safeParse((body as { files?: unknown })?.files);
    if (!parsed.success) return c.json({ error: 'invalid_files' }, 400);
    if (parsed.data.some(f => containsPotentialSecret(f.path) || containsPotentialSecret(f.content))) return c.json({ error: 'secret_in_context' }, 400);
    const admission = budget.acquire();
    if (!admission.ok) return c.json({ error: 'BUDGET_EXCEEDED', reason: admission.reason }, 429);
    try {
      const { autofixLoop } = await import('./agent/autofix');
      const result = await autofixLoop(provider, parsed.data);
      return c.json(JSON.parse(redactSecrets(JSON.stringify(result))));
    } finally { admission.release(); }
  });

  // Mount routes
  app.route('/', githubRouter);
  app.route('/', exportRouter);

  app.post('/api/agent/generate', async (c) => {
    if (!aiAllowed()) return c.json({ error: 'ai_disabled' }, 503);
    /* WS-1: per-user rate limit + trvalá kvóta; bez auth fallback na pilot mód */
    const authUser = opts?.auth ? getUserFromContext(c) : null;
    const limiterKey = authUser ? `agent:${authUser.id}` : 'agent';
    if (!(await agentRateLimit(limiterKey)))
      return c.json({ error: 'rate_limit', message: 'Priveľa požiadaviek, skús o minútu.' }, 429);
    if (opts?.auth && authUser) {
      const consumed = await opts.auth.quota.consume(authUser.id);
      if (!consumed.ok) {
        return c.json(
          {
            error: 'quota_exceeded',
            quota: consumed.snapshot,
            message: 'Vyčerpal si mesačnú kvótu generácií. Plán Pro ti ju zvýši na 200.'
          },
          429
        );
      }
    }
    if (!provider) {
      return c.json(
        {
          error: 'ai_not_configured',
          message:
            'MISTRAL_API_KEY nie je nastavený na serveri. Exportuj MISTRAL_API_KEY a reštartuj server. Instant Draft mód funguje aj bez neho.'
        },
        503
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }

    if (containsPotentialSecret(JSON.stringify(body))) return c.json({ error: 'secret_in_context' }, 400);
    const admission = budget.acquire();
    if (!admission.ok) return c.json({ error: 'BUDGET_EXCEEDED', reason: admission.reason }, 429);
    const runId = uid();
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(new Error('timeout: generovanie prekročilo limit')),
      cfg.requestTimeoutMs ?? 120_000
    );

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');

    const stream = new ReadableStream({
      async start(controller) {
        const ctrl = controller as unknown as { enqueue(chunk: Uint8Array): void };
        const send = (ev: unknown) =>
          ctrl.enqueue(new TextEncoder().encode(`data: ${redactSecrets(JSON.stringify(ev))}\n\n`));
        try {
          for await (const ev of runAgent(body, {
            runId,
            provider,
            signal: abortController.signal,
            maxFiles: 40
          })) {
            const check = AgentEventSchema.safeParse(ev);
            if (check.success) send(check.data);
          }
        } catch (e) {
          send({
            type: 'error',
            code: 'stream_error',
            message: redactSecrets(String(e)).slice(0, 400),
            retriable: true
          });
        } finally {
          clearTimeout(timeout);
          admission.release();
          (controller as unknown as { close(): void }).close();
        }
      },
      cancel() {
        abortController.abort(new Error('klient zrušil stream'));
        admission.release();
      }
    });
    return new Response(stream, { headers: c.res.headers });
  });

  return app;
}

/* ---------- MOCK provider (CI E2E: deterministický, ale cez reálne HTTP/SSE) ---------- */
import type { CompletionChunk } from './providers/types';

export function makeMockProvider(): AIProvider {
  const planJson = JSON.stringify({
    summary: 'CRM dashboard so sidebar, zákazníkmi a úlohami',
    steps: [
      { id: 'scaffold', title: 'Vytvor štruktúru projektu', detail: 'package.json + entry súbory' },
      { id: 'components', title: 'Vygeneruj komponenty', detail: 'App + Sidebar + CRM obsah' }
    ],
    filesPlanned: ['package.json', 'index.html', 'src/main.tsx', 'src/App.tsx', 'src/index.css']
  });
  const filesJson = JSON.stringify({
    files: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'crm-app',
            private: true,
            dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
            devDependencies: {
              '@types/react': '^18.3.12',
              '@types/react-dom': '^18.3.1',
              '@vitejs/plugin-react': '^4.3.4',
              typescript: '~5.6.2',
              vite: '^6.0.5'
            },
            scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' }
          },
          null,
          2
        ),
        action: 'create'
      },
      {
        path: 'index.html',
        content:
          '<!doctype html>\n<html lang="sk"><head><meta charset="UTF-8"/><title>CRM</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
        action: 'create'
      },
      {
        path: 'src/main.tsx',
        content:
          'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\ncreateRoot(document.getElementById("root")!).render(<App />);',
        action: 'create'
      },
      {
        path: 'src/App.tsx',
        content:
          'const customers = [\n  { id: 1, name: "ACME s.r.o.", status: "aktívny" },\n  { id: 2, name: "Beta Corp", status: "nový" },\n];\nconst tasks = [\n  { id: 1, title: "Pripraviť ponuku", done: false },\n  { id: 2, title: "Odoslať faktúru", done: true },\n];\nexport default function App() {\n  return (\n    <div style={{ display: "flex" }}>\n      <nav style={{ width: 200, background: "#1e293b", color: "#fff", padding: 16 }}>\n        <h2>CRM</h2>\n        <ul>\n          <li>Zákazníci</li>\n          <li>Úlohy</li>\n          <li>Nastavenia</li>\n        </ul>\n      </nav>\n      <main style={{ padding: 16 }}>\n        <h1>Zákazníci</h1>\n        {customers.map(c => <div key={c.id}><b>{c.name}</b> <span>{c.status}</span></div>)}\n        <h1>Úlohy</h1>\n        {tasks.map(t => <div key={t.id}><input type="checkbox" defaultChecked={t.done} /> {t.title}</div>)}\n      </main>\n    </div>\n  );\n}',
        action: 'create'
      },
      {
        path: 'src/index.css',
        content: 'body { margin: 0; font-family: system-ui, sans-serif; }',
        action: 'create'
      }
    ]
  });
  /* per-run counter: každý generate run začína plan → files (E2E determinizmus) */
  const runCounters = new WeakMap<object, number>();
  let lastRun: object | null = null;
  return {
    name: 'mock-mistral',
    model: 'mock-large',
    async complete(messages) {
      const runKey = messages as object;
      /* nový run detekovaný ak system prompt je PLAN (prvý call v run-e) */
      const isPlanCall = messages[0]?.content.includes('plánuješ');
      const call = isPlanCall ? 0 : 1;
      lastRun = runKey;
      await new Promise((r) => setTimeout(r, 30)); // reálna async medzera
      return {
        text: call === 0 ? planJson : filesJson,
        usage: { promptTokens: 100, completionTokens: 500 }
      };
    },
    async *stream(messages): AsyncGenerator<CompletionChunk> {
      const isPlanCall = messages[0]?.content.includes('plánuješ');
      const text = isPlanCall ? planJson : filesJson;
      for (const ch of text) yield { delta: ch };
      yield { finishReason: 'stop' };
    }
  };
}

/* ---------- štart servera (keď je spustený priamo) ---------- */
if (
  (process.argv[1] && process.argv[1].endsWith('server/index.ts')) ||
  process.env.LOV_SERVER === '1'
) {
  const cfg: ServerConfig = {
    mistralApiKey: process.env.MISTRAL_API_KEY,
    mistralModel: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
    mistralBaseUrl: process.env.MISTRAL_BASE_URL,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS ? Number(process.env.REQUEST_TIMEOUT_MS) : undefined,
    port: Number(process.env.PORT ?? 8787),
    // BIND=0.0.0.0 pre behind-proxy (Docker/VPS); default ostáva loopback.
    bind: process.env.BIND ?? '127.0.0.1',
    aiGenerationEnabled: process.env.AI_GENERATION_ENABLED !== '0',
    publicDeployment: process.env.NODE_ENV === 'production'
  };
  if (cfg.publicDeployment) throw new Error('Public deployment blocked: auth and durable quotas not configured.');
  const provider = process.env.MOCK_AI === '1' ? makeMockProvider() : makeProvider(cfg);

  /* WS-1: AUTH_ENABLED=1 → Postgres + JWT + trvalé kvóty + Redis limiter (fail-fast). */
  let authWiring: { db: DbLike; jwtSecret: string; quota: QuotaStore } | undefined;
  let agentLimiter: AsyncRateLimiter | undefined;
  if (process.env.AUTH_ENABLED === '1') {
    const databaseUrl = process.env.DATABASE_URL;
    const jwtSecret = process.env.JWT_SECRET;
    if (!databaseUrl || !jwtSecret || jwtSecret.length < 32)
      throw new Error('AUTH_ENABLED=1 vyžaduje DATABASE_URL a JWT_SECRET (min 32 znakov).');
    const { makeDb } = await import('./db/pool');
    const { applyMigrations } = await import('./db/migrate');
    const { PostgresQuotaStore } = await import('./security/quotaStore');
    const { loadRedis, makeRedisRateLimiter, makeInMemoryRateLimiter } = await import('./security/rateLimit');
    const db = makeDb(databaseUrl);
    const applied = await applyMigrations(db);
    console.log(`[Forge AI] auth: ON · migrácie: ${applied.join(', ') || '(žiadne)'}`);
    authWiring = { db, jwtSecret, quota: new PostgresQuotaStore(db) };
    const redis = await loadRedis(process.env.REDIS_URL);
    agentLimiter = redis
      ? makeRedisRateLimiter(redis, cfg.rateLimitPerMin ?? 10)
      : makeInMemoryRateLimiter(cfg.rateLimitPerMin ?? 10);
    console.log(`[Forge AI] rate limiter: ${redis ? 'redis' : 'memory'} · kvóty: postgres (free 10/pro 200 mesačne)`);
  }

  const app = createApp(cfg, provider, { auth: authWiring, agentRateLimit: agentLimiter });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind });
  console.log(
    `[Forge AI] server na http://127.0.0.1:${cfg.port} · AI: ${provider ? 'mistral (' + (cfg.mistralModel ?? '') + ')' : 'NOT CONFIGURED'}`
  );
}
