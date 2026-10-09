import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { MistralProvider, makeFetchTransport } from './providers/mistral';
import type { AIProvider, ProviderTransport } from './providers/types';
import { runAgent } from './agent/run';
import { AgentEventSchema } from './agent/schemas';
import { SandboxFileSchema, buildProject } from './sandbox/builder';
import { githubRouter } from './routes/github';
import { exportRouter } from './routes/export';

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
}

export function makeProvider(cfg: ServerConfig, transport?: ProviderTransport): AIProvider | null {
  if (!cfg.mistralApiKey) return null;
  const baseUrl = cfg.mistralBaseUrl ?? 'https://api.mistral.ai/v1';
  const t = transport ?? makeFetchTransport({ apiKey: cfg.mistralApiKey, baseUrl, timeoutMs: cfg.requestTimeoutMs ?? 120_000 });
  return new MistralProvider({ apiKey: cfg.mistralApiKey, model: cfg.mistralModel ?? 'mistral-large-latest', baseUrl }, t);
}

/* jednoduchý in-memory rate limiter (single-user pilot) */
export function makeRateLimiter(maxPerMin: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < 60_000);
    if (list.length >= maxPerMin) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

export function createApp(cfg: ServerConfig, provider: AIProvider | null, opts?: { transport?: ProviderTransport; rateLimit?: (k: string) => boolean }) {
  const app = new Hono();
  /* CORS: lokálny dev (5173 → 8787) — single-user pilot, loopback only */
  app.use('*', cors({ origin: (origin) => origin && origin.startsWith('http://localhost') ? origin : 'http://localhost:5173', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  const rateLimit = opts?.rateLimit ?? makeRateLimiter(cfg.rateLimitPerMin ?? 10);

  app.get('/api/health', c => c.json({ ok: true, ai: provider ? 'mistral' : 'not-configured' }));

  /* M3 sandbox: izolovaný build vygenerovaného projektu (esbuild compile-only,
     kód sa NIKDY nespustí v host procese — výstup je HTML pre sandbox iframe) */
  app.post('/api/sandbox/build', async c => {
    if (!rateLimit('sandbox')) return c.json({ error: 'rate_limit' }, 429);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
    const parsed = SandboxFileSchema.array().max(40).safeParse((body as { files?: unknown })?.files);
    if (!parsed.success) return c.json({ error: 'invalid_files', issues: parsed.error.issues.slice(0, 5) }, 400);
    const result = await buildProject(parsed.data);
    return c.json(result);
  });

  /* Step 4: AUTOFIX — build → errors → AI patch → rebuild (max 2 pokusy) */
  app.post('/api/sandbox/autofix', async c => {
    if (!rateLimit('autofix')) return c.json({ error: 'rate_limit' }, 429);
    if (!provider) return c.json({ error: 'ai_not_configured' }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
    const parsed = SandboxFileSchema.array().max(40).safeParse((body as { files?: unknown })?.files);
    if (!parsed.success) return c.json({ error: 'invalid_files' }, 400);
    const { autofixLoop } = await import('./agent/autofix');
    const result = await autofixLoop(provider, parsed.data);
    return c.json(result);
  });


  // Mount routes
  app.route("/", githubRouter);
  app.route("/", exportRouter);

  app.post('/api/agent/generate', async c => {
    if (!rateLimit('agent')) return c.json({ error: 'rate_limit', message: 'Priveľa požiadaviek, skús o minútu.' }, 429);
    if (!provider) {
      return c.json({
        error: 'ai_not_configured',
        message: 'MISTRAL_API_KEY nie je nastavený na serveri. Exportuj MISTRAL_API_KEY a reštartuj server. Instant Draft mód funguje aj bez neho.',
      }, 503);
    }
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }

    const runId = uid();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(new Error('timeout: generovanie prekročilo limit')), cfg.requestTimeoutMs ?? 120_000);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');

    const stream = new ReadableStream({
      async start(controller) {
        const ctrl = controller as unknown as { enqueue(chunk: Uint8Array): void };
        const send = (ev: unknown) => ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`));
        try {
          for await (const ev of runAgent(body, { runId, provider, signal: abortController.signal, maxFiles: 40 })) {
            const check = AgentEventSchema.safeParse(ev);
            if (check.success) send(check.data);
          }
        } catch (e) {
          send({ type: 'error', code: 'stream_error', message: String(e).slice(0, 400), retriable: true });
        } finally {
          clearTimeout(timeout);
          (controller as unknown as { close(): void }).close();
        }
      },
      cancel() { abortController.abort(new Error('klient zrušil stream')); },
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
      { id: 'components', title: 'Vygeneruj komponenty', detail: 'App + Sidebar + CRM obsah' },
    ],
    filesPlanned: ['package.json', 'index.html', 'src/main.tsx', 'src/App.tsx', 'src/index.css'],
  });
  const filesJson = JSON.stringify({
    files: [
      { path: 'package.json', content: JSON.stringify({ name: 'crm-app', private: true, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', '@vitejs/plugin-react': '^4.3.4', typescript: '~5.6.2', vite: '^6.0.5' }, scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' } }, null, 2), action: 'create' },
      { path: 'index.html', content: '<!doctype html>\n<html lang="sk"><head><meta charset="UTF-8"/><title>CRM</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>', action: 'create' },
      { path: 'src/main.tsx', content: 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\ncreateRoot(document.getElementById("root")!).render(<App />);', action: 'create' },
      { path: 'src/App.tsx', content: 'const customers = [\n  { id: 1, name: "ACME s.r.o.", status: "aktívny" },\n  { id: 2, name: "Beta Corp", status: "nový" },\n];\nconst tasks = [\n  { id: 1, title: "Pripraviť ponuku", done: false },\n  { id: 2, title: "Odoslať faktúru", done: true },\n];\nexport default function App() {\n  return (\n    <div style={{ display: "flex" }}>\n      <nav style={{ width: 200, background: "#1e293b", color: "#fff", padding: 16 }}>\n        <h2>CRM</h2>\n        <ul>\n          <li>Zákazníci</li>\n          <li>Úlohy</li>\n          <li>Nastavenia</li>\n        </ul>\n      </nav>\n      <main style={{ padding: 16 }}>\n        <h1>Zákazníci</h1>\n        {customers.map(c => <div key={c.id}><b>{c.name}</b> <span>{c.status}</span></div>)}\n        <h1>Úlohy</h1>\n        {tasks.map(t => <div key={t.id}><input type="checkbox" defaultChecked={t.done} /> {t.title}</div>)}\n      </main>\n    </div>\n  );\n}', action: 'create' },
      { path: 'src/index.css', content: 'body { margin: 0; font-family: system-ui, sans-serif; }', action: 'create' },
    ],
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
      let call = isPlanCall ? 0 : 1;
      lastRun = runKey;
      await new Promise(r => setTimeout(r, 30)); // reálna async medzera
      return { text: call === 0 ? planJson : filesJson, usage: { promptTokens: 100, completionTokens: 500 } };
    },
    async *stream(messages): AsyncGenerator<CompletionChunk> {
      const isPlanCall = messages[0]?.content.includes('plánuješ');
      const text = isPlanCall ? planJson : filesJson;
      for (const ch of text) yield { delta: ch };
      yield { finishReason: 'stop' };
    },
  };
}

/* ---------- štart servera (keď je spustený priamo) ---------- */
if (process.argv[1] && process.argv[1].endsWith('server/index.ts') || process.env.LOV_SERVER === '1') {
  const cfg: ServerConfig = {
    mistralApiKey: process.env.MISTRAL_API_KEY,
    mistralModel: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
    mistralBaseUrl: process.env.MISTRAL_BASE_URL,
    port: Number(process.env.PORT ?? 8787),
    bind: '127.0.0.1',
  };
  const provider = process.env.MOCK_AI === '1' ? makeMockProvider() : makeProvider(cfg);
  const app = createApp(cfg, provider);
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind });
  console.log(`[Forge AI] server na http://127.0.0.1:${cfg.port} · AI: ${provider ? 'mistral (' + (cfg.mistralModel ?? '') + ')' : 'NOT CONFIGURED'}`);
}
