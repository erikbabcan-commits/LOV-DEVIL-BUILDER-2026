import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { MistralProvider, makeFetchTransport } from './providers/mistral';
import type { AIProvider, ProviderTransport } from './providers/types';
import { runAgent } from './agent/run';
import { AgentEventSchema } from './agent/schemas';
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
  const rateLimit = opts?.rateLimit ?? makeRateLimiter(cfg.rateLimitPerMin ?? 10);

  app.get('/api/health', c => c.json({ ok: true, ai: provider ? 'mistral' : 'not-configured' }));

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

/* ---------- štart servera (keď je spustený priamo) ---------- */
if (process.argv[1] && process.argv[1].endsWith('server/index.ts') || process.env.LOV_SERVER === '1') {
  const cfg: ServerConfig = {
    mistralApiKey: process.env.MISTRAL_API_KEY,
    mistralModel: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
    mistralBaseUrl: process.env.MISTRAL_BASE_URL,
    port: Number(process.env.PORT ?? 8787),
    bind: '127.0.0.1',
  };
  const provider = makeProvider(cfg);
  const app = createApp(cfg, provider);
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind });
  console.log(`[Forge AI] server na http://127.0.0.1:${cfg.port} · AI: ${provider ? 'mistral (' + (cfg.mistralModel ?? '') + ')' : 'NOT CONFIGURED'}`);
}
