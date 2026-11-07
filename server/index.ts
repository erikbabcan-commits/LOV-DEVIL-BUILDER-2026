import {preflightContext} from './agent/context';
import {ContextBudgetError,contextWindow} from './providers/contextBudget';
import { ProviderError } from './providers/errors';
import { ModelSelectionSchema } from '../shared/aiModels';
import { ProviderRegistry, type ModelEntry } from './providers/registry';
import { configuredProviders } from './providers/runtime';
import { createProviderRun } from './providers/run';
import type { ResilienceOptions, ProviderUpdate } from './providers/resilience';
import { readAiPricePolicy, parsePricePolicy, type PricePolicy } from './usage/pricing';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PostgresAiUsageStore, UsageLedgerError, type AiUsageStore, type RunStatus } from './usage/store';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { projectRouter } from './projects/routes';
import { readProjectStoragePolicy, type ProjectStoragePolicy } from './projects/storage';
import { MistralProvider, makeFetchTransport } from './providers/mistral';
import type { AIProvider, ProviderTransport } from './providers/types';
import { runAgent, parseAgentRequest } from './agent/run';
import { consumeGenerationQuota, QuotaAdmissionError } from './security/generationQuota';
import { AgentEventSchema } from './agent/schemas';
import { SandboxFileSchema } from './sandbox/builder';
import { createSandboxExecutor, getSandboxExecutor, type SandboxExecutor } from './sandbox/executor';
import { asSandboxError } from './sandbox/errors';
import { MAX_INPUT_JSON_BYTES, validationFailure } from './sandbox/policy';
import { allowedOrigins } from './security/oauthPolicy';
import { githubRouter } from './routes/githubSecure';
import { githubCloudRouter, isCloudGitHubRoute, type CloudGitHubWiring } from './routes/githubCloud';
import { exportRouter } from './routes/export';
import { LocalBudgetGuard } from './security/budget';
import { containsPotentialSecret, redactSecrets } from './security/secrets';
import { authRouter } from './auth/routes';
import { accountExportRouter } from './auth/accountExport';
import { makeAuthMiddleware, getUserFromContext } from './auth/middleware';
import { makeCloudAuth, validateCloudIssuer, type CloudAuth } from './auth/cloud';
import { readCloudGitHubConfig, makeCloudGitHubWiring } from './integrations/githubRuntime';
import { probeCloudGitHubSchema } from './integrations/githubSchema';
import type { DbLike } from './db/pool';
import type { QuotaStore, QuotaSnapshot } from './security/quotaStore';
import { makeInMemoryRateLimiter, type AsyncRateLimiter } from './security/rateLimit';
import { billingRouter, billingWebhook } from './billing/routes';
import { BillingService, probeBillingSchema } from './billing/service';
import { readBillingConfig, billingMode } from './billing/config';
import { initializeBillingEnvironment } from './billing/service';
import { readPublishConfig } from './publish/config';
import { PublishService, probePublishSchema } from './publish/service';
import { publishRouter } from './publish/routes';
import { publicPublishApp } from './publish/public';
import { makeStripeBillingGateway } from './billing/gateway';

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
  sandboxMode?: 'host' | 'isolated';
  projectStorage?: ProjectStoragePolicy;
  aiPricing?: PricePolicy | null;
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
    providers?: ProviderRegistry;
    resilience?: Pick<ResilienceOptions, 'sleep' | 'random'>;
    rateLimit?: (k: string) => boolean;
    budget?: LocalBudgetGuard;
    /** WS-1: ak je zadané, auth je zapnutý — všetko okrem /api/health a /api/auth/* vyžaduje prihlásenie. */
    auth?: { db: DbLike; jwtSecret: string; quota: QuotaStore; usage?: AiUsageStore; cloudAuth?: CloudAuth; cloudGitHub?: CloudGitHubWiring; billing?: BillingService; publish?: PublishService };
    /** Async limiter pre agent/autofix (Redis keď je REDIS_URL; inak per-user memory). */
    agentRateLimit?: AsyncRateLimiter;
    sandbox?: SandboxExecutor;
  }
) {
  if (cfg.aiPricing) parsePricePolicy(JSON.stringify(cfg.aiPricing.document));
  const providers = opts?.providers ?? new ProviderRegistry(provider ? [{id:'default',label:'AI ('+provider.name+')',provider}] : []);
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
      allowHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
      credentials: true
    })
  );
  const rateLimit = opts?.rateLimit ?? makeRateLimiter(cfg.rateLimitPerMin ?? 10);
  const agentRateLimit: AsyncRateLimiter =
    opts?.agentRateLimit ??
    (opts?.rateLimit ? async (k: string) => opts.rateLimit!(k) : makeInMemoryRateLimiter(cfg.rateLimitPerMin ?? 10));
  const budget = opts?.budget ?? new LocalBudgetGuard({ maxConcurrent: cfg.maxConcurrentRuns ?? 2, maxRunsPerDay: cfg.maxRunsPerDay ?? 30 });
  const usageStore = opts?.auth ? opts.auth.usage ?? new PostgresAiUsageStore(opts.auth.db, undefined, cfg.aiPricing ?? null) : null;
  const aiAllowed = () => cfg.aiGenerationEnabled !== false && cfg.publicDeployment !== true;
  const sandbox = opts?.sandbox ?? (cfg.sandboxMode
    ? createSandboxExecutor({ ...process.env, SANDBOX_MODE: cfg.sandboxMode }) : getSandboxExecutor());

  app.use('/api/billing/webhook', bodyLimit({ maxSize: 512 * 1024, onError: c => c.json({ error: 'billing_input_limit' }, 413) }));
  app.post('/api/billing/webhook', billingWebhook(opts?.auth?.billing ?? null));
  app.use('/api/billing/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'billing_input_limit' }, 413) }));
  /* WS-1: auth middleware (iba keď je opts.auth zapnuté — inak pilot mód bez zmien) */
  if (opts?.auth) {
    if (opts.auth.cloudGitHub && !opts.auth.cloudAuth) throw new Error('Cloud GitHub requires Cloud authentication');
    app.use('/api/*', makeAuthMiddleware(opts.auth.jwtSecret, opts.auth.cloudAuth, opts.auth.cloudGitHub ? isCloudGitHubRoute : undefined, opts.auth.db));
    app.route('/', authRouter(opts.auth));
    app.route('/', accountExportRouter(opts.auth.db, opts?.rateLimit ?? makeRateLimiter(60)));
    app.route('/', projectRouter(opts.auth.db, rateLimit, cfg.projectStorage));
    if (opts.auth.cloudGitHub) app.route('/', githubCloudRouter(opts.auth.cloudGitHub, rateLimit));
  }
  app.route('/', billingRouter(opts?.auth?.billing ?? null, rateLimit));
  app.route('/', publishRouter(opts?.auth?.publish ?? null, rateLimit));

  app.get('/api/ai-usage', async c => {
    c.header('Cache-Control', 'no-store');
    const auth = opts?.auth;
    const user = getUserFromContext(c);
    if (!auth || !user || !usageStore) return c.json({ error: 'usage_unavailable' }, 503);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_query' }, 400);
    if (!rateLimit('ai-usage:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    try {
      const report = await usageStore.report(user.id);
      // A successful job's last transition is publication. Use the same UTC
      // window and keep the AI report readable if the publish read fails.
      const result = await auth.db.query(
        `SELECT COUNT(*) AS deployments FROM publish_jobs
         WHERE owner_id = $1 AND state = 'published' AND updated_at >= $2 AND updated_at < $3`,
        [user.id, new Date(report.periodStart + 'T00:00:00Z'), new Date(report.periodEnd + 'T00:00:00Z')],
      ).catch(() => null);
      const publishedDeployments = Number(result?.rows[0]?.deployments);
      return c.json(Number.isSafeInteger(publishedDeployments) && publishedDeployments >= 0
        ? { ...report, publishedDeployments } : report);
    } catch { return c.json({ error: 'usage_unavailable' }, 503); }
  });

  app.get('/api/ai-models', c => {
    c.header('Cache-Control','no-store');
    if (new URL(c.req.url).search) return c.json({error:'invalid_query'},400);
    const user = opts?.auth ? getUserFromContext(c) : null;
    if (!rateLimit('ai-models:'+(user?.id??'pilot'))) return c.json({error:'rate_limit'},429);
    return c.json(aiAllowed()?providers.catalog():{defaultId:null,models:[]});
  });
  app.get('/api/health', (c) => c.json({ ok: true, ai: providers.defaultProvider?.name ?? 'not-configured', auth: opts?.auth ? 'enabled' : 'disabled' }));
  app.use('/api/sandbox/*', bodyLimit({ maxSize: MAX_INPUT_JSON_BYTES,
    onError: c => c.json({ error: 'sandbox_input_limit' }, 413) }));
  app.get('/api/sandbox/ready', async c => {
    const status = await sandbox.ready();
    return c.json(status, status.ready ? 200 : 503);
  });

  /* Compile-only build cez spoločný executor; výsledné HTML je pre sandbox iframe. */
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
      return c.json({ error: 'invalid_files', issues: JSON.parse(redactSecrets(JSON.stringify(parsed.error.issues.slice(0, 5)))) }, 400);
    const invalid = validationFailure(parsed.data);
    if (invalid) return c.json(invalid);
    try { return c.json(await sandbox.execute(parsed.data, c.req.raw.signal)); }
    catch (error) {
      const safe = asSandboxError(error);
      // Existing preview clients display errors[]; keep the human-readable infra message there too.
      return c.json({ error: safe.code, message: safe.message, errors: [{ file: '-', message: safe.message }] }, safe.status);
    }
  });

  /* Step 4: AUTOFIX — build → errors → AI patch → rebuild (max 2 pokusy) */
  app.post('/api/sandbox/autofix', async (c) => {
    if (!aiAllowed()) return c.json({ error: 'ai_disabled' }, 503);
    const autoUser = opts?.auth ? getUserFromContext(c) : null;
    if (!(await agentRateLimit(autoUser ? `autofix:${autoUser.id}` : 'autofix'))) return c.json({ error: 'rate_limit' }, 429);
    if (!providers.defaultProvider) return c.json({ error: 'ai_not_configured' }, 503);
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
    const selection = ModelSelectionSchema.safeParse(body);
    let autoRoute: ModelEntry[];
    try { if (!selection.success) throw new Error('invalid_model'); autoRoute=providers.route(selection.data.modelId,selection.data.allowFallback,selection.data.fallbackIds); }
    catch { return c.json({error:'invalid_model'},400); }
    if (parsed.data.some(f => containsPotentialSecret(f.path) || containsPotentialSecret(f.content))) return c.json({ error: 'secret_in_context' }, 400);
    const admission = budget.acquire();
    if (!admission.ok) return c.json({ error: 'BUDGET_EXCEEDED', reason: admission.reason }, 429);
    let autoQuota: QuotaSnapshot | undefined;
    const autoRun = { userId: autoUser?.id ?? '', id: randomUUID(), kind: 'autofix' as const };
    const autoUpdates: ProviderUpdate[] = [];
    const autoMeter = createProviderRun(autoRoute,usageStore,autoRun,{...opts?.resilience,onUpdate:event=>autoUpdates.push(event)});
    let autoFinished = false;
    try {
      const { autofixLoop } = await import('./agent/autofix');
      const result = await autofixLoop(autoMeter.provider, parsed.data, { executor: sandbox, signal: c.req.raw.signal,
        beforeAi: async () => {
          if (opts?.auth && autoUser && !autoQuota) autoQuota = await consumeGenerationQuota(opts.auth.quota, autoUser.id, () => usageStore!.admit(autoRun, opts.auth!.quota));
        },
      });
      if (autoQuota && autoMeter) { await autoMeter.finish(c.req.raw.signal.aborted ? 'cancelled' : result.ok ? 'succeeded' : 'failed'); autoFinished = true; }
      return c.json(JSON.parse(redactSecrets(JSON.stringify({ ...result, ...(autoUpdates.length ? {providerUpdates:autoUpdates} : {}), ...(autoQuota && autoUser ? { quotaUpdate: { userId: autoUser.id, quota: autoQuota } } : {}) }))));
    } catch (error) {
      if (error instanceof ContextBudgetError) return c.json({error:'context_limit',message:error.message},413);
      if (error instanceof UsageLedgerError) return c.json({ error: 'quota_unavailable', message: error.message }, 503);
      if (error instanceof QuotaAdmissionError) return c.json({ error: error.code, message: error.message, ...(error.quota && autoUser ? { quota: error.quota, userId: autoUser.id } : {}) }, error.status);
      const safe = asSandboxError(error);
      return c.json({ error: safe.code, message: safe.message }, safe.status);
    } finally {
      if (autoQuota && autoMeter && !autoFinished) { try { await autoMeter.finish('incomplete'); } catch { /* retained as unknown */ } }
      admission.release();
    }
  });

  // Mount routes
  app.route('/', githubRouter);
  app.route('/', exportRouter);

  app.use('/api/agent/generate', bodyLimit({ maxSize: 8_000_000, onError: c => c.json({ error: 'agent_input_limit' }, 413) }));
  app.post('/api/agent/generate', async (c) => {
    if (!aiAllowed()) return c.json({ error: 'ai_disabled' }, 503);
    const authUser = opts?.auth ? getUserFromContext(c) : null;
    if (!(await agentRateLimit(authUser ? `agent:${authUser.id}` : 'agent')))
      return c.json({ error: 'rate_limit', message: 'Priveľa požiadaviek, skús o minútu.' }, 429);
    if (!providers.defaultProvider) return c.json({ error: 'ai_not_configured', message: 'AI engine teraz nie je dostupný. Použi Instant Draft alebo skús neskôr.' }, 503);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
    const input = parseAgentRequest(body);
    if (!input.ok) return c.json({ error: input.error.code, message: input.error.message }, 400);
    let route: ModelEntry[];
    try { route=providers.route(input.request.modelId,input.request.allowFallback,input.request.fallbackIds); }
    catch { return c.json({error:'invalid_model'},400); }
    try{preflightContext(input.request,{contextWindowTokens:Math.min(...route.map(entry=>contextWindow(entry.provider)))});}
    catch(error){if(error instanceof ContextBudgetError)return c.json({error:'context_limit'},413);throw error;}
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 400);
    const admission = budget.acquire();
    if (!admission.ok) return c.json({ error: 'BUDGET_EXCEEDED', reason: admission.reason }, 429);
    const runId = randomUUID();
    const run = { userId: authUser?.id ?? '', id: runId, kind: 'generation' as const };
    let providerUpdate: (event: ProviderUpdate) => void = () => {};
    const meter = createProviderRun(route,usageStore,run,{...opts?.resilience,onUpdate:event=>providerUpdate(event)});
    try {
      if (opts?.auth && authUser) await consumeGenerationQuota(opts.auth.quota, authUser.id, () => usageStore!.admit(run, opts.auth!.quota));
    } catch (error) {
      admission.discard();
      if (error instanceof QuotaAdmissionError) return c.json({ error: error.code, message: error.message, ...(error.quota && authUser ? { quota: error.quota, userId: authUser.id } : {}) }, error.status);
      return c.json({ error: 'quota_unavailable' }, 503);
    }
    const abortController = new AbortController();
    const clientSignal = c.req.raw.signal;
    const onAbort = () => abortController.abort(new Error('klient zrušil požiadavku'));
    clientSignal.addEventListener('abort', onAbort, { once: true });
    if (clientSignal.aborted) onAbort();
    const timeout = setTimeout(() => abortController.abort(new ProviderError('timeout')), cfg.requestTimeoutMs ?? 120_000);
    const cleanup = () => { clearTimeout(timeout); clientSignal.removeEventListener('abort', onAbort); };
    let outputClosed = false;
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let finished = false;
        const send = (event: unknown) => {
          if (!outputClosed) controller.enqueue(new TextEncoder().encode(`data: ${redactSecrets(JSON.stringify(event))}\n\n`));
        };
        providerUpdate = event => { const checked=AgentEventSchema.safeParse(event); if(checked.success) send(checked.data); };
        try {
          for await (const event of runAgent(input.request, { runId, provider: meter.provider, signal: abortController.signal, maxFiles: 40 })) {
            if (['done', 'error', 'cancelled'].includes(event.type) && meter) {
              const status: RunStatus = event.type === 'done' ? 'succeeded' : event.type === 'cancelled' ? 'cancelled' : 'failed';
              await meter.finish(status); finished = true;
            }
            const checked = AgentEventSchema.safeParse(event);
            if (checked.success) send(checked.data);
          }
        } catch (error) {
          send({ type: 'error', code: 'stream_error', message: error instanceof UsageLedgerError ? error.message : 'Generovanie sa prerušilo. Projekt zostal zachovaný.', retriable: true });
        } finally {
          if (meter && !finished) { try { await meter.finish('incomplete'); } catch { /* unknown remains visible */ } }
          cleanup();
          // Hold concurrency until the provider has actually stopped, including
          // providers that do not immediately honour cancellation.
          admission.release();
          if (!outputClosed) { outputClosed = true; controller.close(); }
        }
      },
      cancel() {
        outputClosed = true;
        abortController.abort(new Error('klient zrušil stream'));
        cleanup();
      },
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
  return {
    name: 'mock-mistral',
    model: 'mock-large',
    async complete(messages) {
      // Detect the explicit plan response contract, not an obsolete prompt phrase.
      if(messages[0]?.content.includes('Forge Intent Router')){
        // Deterministic development fixture only, not a model-quality evaluator.
        const input=JSON.parse(messages[1].content) as {prompt:string;hasProject:boolean};
        const question=/^(prečo|ako|čo|kde|vysvetli|why|how|what|where|explain)\b/i.test(input.prompt);
        const fix=/oprav|chybu|fix|repair|crash/i.test(input.prompt);
        return{text:JSON.stringify({intent:question?'explain':fix?'fix':input.hasProject?'iterate':'create'}),usage:{promptTokens:10,completionTokens:5}};
      }
      if(messages[0]?.content.includes('Forge Edit Planner')){
        const input=JSON.parse(messages[1].content) as {context:{files:Array<{path:string;content:string}>}};
        const target=input.context.files.find(f=>f.path.endsWith('.css'))??input.context.files[0];
        return{text:JSON.stringify({summary:'Cielená testovacia úprava jedného súboru',steps:[{id:'edit',title:'Uprav vybraný súbor'}],filesPlanned:target?[target.path]:[]}),usage:{promptTokens:40,completionTokens:30}};
      }
      if(messages[0]?.content.includes('Forge Build Repair')){
        const input=JSON.parse(messages[1].content) as {files:Array<{path:string;content:string;sha256:string}>},file=input.files.find(file=>file.content.includes('const x = {'));
        return{text:JSON.stringify({version:1,summary:'Syntetická oprava známej testovacej syntax chyby.',changes:file?[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:'const x = {',replace:'const x = {};'}]}]:[]}),usage:{promptTokens:40,completionTokens:30}};
      }
      if(messages[0]?.content.includes('Forge Patch Editor')){
        const input=JSON.parse(messages[1].content) as {plannedFiles:string[];files:Array<{path:string;content:string;sha256:string}>};
        return{text:JSON.stringify({version:1,summary:'Lokálny testovací patch bez zásahu do ostatných súborov.',changes:input.plannedFiles.map(path=>{const file=input.files.find(f=>f.path===path)!;return{path,action:'modify',beforeSha256:file.sha256,edits:[{search:file.content.slice(-120),replace:file.content.slice(-120)+'\n/* Testovacia zmena. */\n'}]};})}),usage:{promptTokens:40,completionTokens:30}};
      }
      const isMemoryCall=messages[0]?.content.includes('Forge Conversation Memory');
      if(isMemoryCall)return{text:JSON.stringify({summary:'Syntetické zhrnutie pre lokálne UI overenie.',decisions:[],openQuestions:[]}),usage:{promptTokens:30,completionTokens:20}};
      const isPlanCall = messages[0]?.content.includes('"filesPlanned"');
      const call = isPlanCall ? 0 : 1;
      await new Promise((r) => setTimeout(r, 30)); // reálna async medzera
      return {
        text: call === 0 ? planJson : filesJson,
        usage: { promptTokens: 100, completionTokens: 500 }
      };
    },
    async *stream(messages): AsyncGenerator<CompletionChunk> {
      if(messages[0]?.content.includes('Forge Explain')){yield{delta:'Toto je lokálna testovacia odpoveď k projektu. Súbory sa nemenili.',model:'mock-large'};yield{finishReason:'stop',usage:{promptTokens:50,completionTokens:30}};return;}
      const isPlanCall = messages[0]?.content.includes('"filesPlanned"');
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
  // Parse before provider, DB or migration side effects. Enabling OAuth does
  // not enable export; each has an explicit, default-off operator switch.
  const cloudGitHubConfig = readCloudGitHubConfig(process.env);
  const billingConfig = readBillingConfig(process.env);
  const publishConfig = readPublishConfig(process.env);
  cfg.projectStorage = readProjectStoragePolicy(process.env);
  cfg.aiPricing = readAiPricePolicy(process.env);
  if (process.env.CLOUD_AUTH_ISSUER) validateCloudIssuer(process.env.CLOUD_AUTH_ISSUER);
  const registry = process.env.MOCK_AI === '1' ? new ProviderRegistry([{id:'default',label:'AI test',provider:makeMockProvider()}]) : configuredProviders(process.env);
  const provider = registry.defaultProvider;

  /* WS-1: AUTH_ENABLED=1 → Postgres + JWT + trvalé kvóty + Redis limiter (fail-fast). */
  let authWiring: { db: DbLike; jwtSecret: string; quota: QuotaStore; usage?: AiUsageStore; cloudAuth?: CloudAuth; cloudGitHub?: CloudGitHubWiring; billing?: BillingService; publish?: PublishService } | undefined;
  let agentLimiter: AsyncRateLimiter | undefined;
  const expectedSchema = process.env.DATABASE_SCHEMA_SHA256;
  if (expectedSchema !== undefined && process.env.AUTH_ENABLED !== '1')
    throw new Error('DATABASE_SCHEMA_SHA256 requires AUTH_ENABLED=1.');
  if (process.env.CLOUD_AUTH_ISSUER && process.env.AUTH_ENABLED !== '1')
    throw new Error('CLOUD_AUTH_ISSUER requires AUTH_ENABLED=1.');
  if (process.env.AUTH_ENABLED === '1') {
    const databaseUrl = process.env.DATABASE_URL;
    const jwtSecret = process.env.JWT_SECRET;
    if (!databaseUrl || !jwtSecret || jwtSecret.length < 32)
      throw new Error('AUTH_ENABLED=1 vyžaduje DATABASE_URL a JWT_SECRET (min 32 znakov).');
    const { makeDb } = await import('./db/pool');
    const { prepareAuthSchema } = await import('./db/migrate');
    const { PostgresQuotaStore } = await import('./security/quotaStore');
    const { loadRedis, makeRedisRateLimiter, makeInMemoryRateLimiter } = await import('./security/rateLimit');
    const db = makeDb(databaseUrl);
    const applied = await prepareAuthSchema(db, expectedSchema);
    console.log(applied === null
      ? '[Forge AI] auth: ON · schéma overená bez migrácií'
      : `[Forge AI] auth: ON · migrácie: ${applied.join(', ') || '(žiadne)'}`);
    if (cloudGitHubConfig && !(await probeCloudGitHubSchema(db, cloudGitHubConfig.exportsEnabled)).ready)
      throw new Error('Cloud GitHub schema is not ready. Run the read-only preflight.');
    if (billingConfig && !(await probeBillingSchema(db, billingMode(billingConfig))).ready)
      throw new Error('Billing schema is not ready. Apply and verify the local billing migration before activation.');
    if (billingConfig) await initializeBillingEnvironment(db, billingMode(billingConfig));
    if (publishConfig && !(await probePublishSchema(db))) throw new Error('Publish schema is not ready.');
    authWiring = { db, jwtSecret, quota: new PostgresQuotaStore(db),
      ...(publishConfig ? { publish: new PublishService(db, publishConfig, createSandboxExecutor(process.env)) } : {}),
      ...(billingConfig ? { billing: new BillingService(db, billingConfig, makeStripeBillingGateway(billingConfig)) } : {}),
      ...(process.env.CLOUD_AUTH_ISSUER ? { cloudAuth: makeCloudAuth(db, process.env.CLOUD_AUTH_ISSUER) } : {}),
      ...(cloudGitHubConfig ? { cloudGitHub: makeCloudGitHubWiring(db, cloudGitHubConfig) } : {}) };
    const redis = await loadRedis(process.env.REDIS_URL);
    agentLimiter = redis
      ? makeRedisRateLimiter(redis, cfg.rateLimitPerMin ?? 10)
      : makeInMemoryRateLimiter(cfg.rateLimitPerMin ?? 10);
    console.log(`[Forge AI] rate limiter: ${redis ? 'redis' : 'memory'} · kvóty: postgres (free 10/pro 200 mesačne)`);
    if (cloudGitHubConfig) console.log(`[Forge AI] Cloud GitHub: ON · public_repo only · exports: ${cloudGitHubConfig.exportsEnabled ? 'ON' : 'OFF'}`);
  }

  if (publishConfig && authWiring?.publish) {
    const publicApp = publicPublishApp(publishConfig, authWiring.db, authWiring.publish.artifacts);
    serve({ fetch: publicApp.fetch, hostname: publishConfig.bind, port: publishConfig.port });
  }
  const app = createApp(cfg, provider, { auth: authWiring, agentRateLimit: agentLimiter, providers: registry });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bind });
  console.log(
    `[Forge AI] server na http://127.0.0.1:${cfg.port} · AI models: ${registry.catalog().models.length}`
  );
}
