import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { validateFiles } from '../../../server/agent/run';
import { isSafePath, withinSizeLimits } from '../../../server/security/pathGuard';
import { requestPlan, requestFiles, extractJson } from '../../../server/agent/prompts';
import { MistralProvider, makeFetchTransport } from '../../../server/providers/mistral';
import { createApp, makeProvider, makeRateLimiter } from '../../../server/index';
import type { ProviderTransport } from '../../../server/providers/types';
import type { ServerConfig } from '../../../server/index';

/* Workstream F: deterministické mock testy (CI) — reálny smoke test je separátne. */

function mockTransport(responses: Array<{ status: number; body: unknown } | { sse: string[] }>): ProviderTransport & { calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    async postChat(body: unknown): Promise<Response> {
      calls.push(body);
      const r = responses[Math.min(i++, responses.length - 1)];
      if ('sse' in r) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) { for (const chunk of r.sse) c.enqueue(enc.encode(chunk)); c.close(); },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  };
}

const planJson = JSON.stringify({
  summary: 'CRM dashboard so sidebar',
  steps: [{ id: 'scaffold', title: 'Vytvor štruktúru', detail: 'package.json + entry' }],
  filesPlanned: ['package.json', 'index.html', 'src/main.tsx', 'src/App.tsx', 'src/index.css'],
});
const filesJson = JSON.stringify({
  files: [
    { path: 'package.json', content: '{ "name": "crm" }', action: 'create' },
    { path: 'index.html', content: '<html><body><div id="root"></div></body></html>', action: 'create' },
    { path: 'src/main.tsx', content: 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);', action: 'create' },
    { path: 'src/App.tsx', content: 'export default function App(){ return <h1>CRM</h1>; }', action: 'create' },
    { path: 'src/index.css', content: 'body{margin:0}', action: 'create' },
  ],
});

describe('pathGuard (Workstream D)', () => {
  it('zákaze traversal a absolútne cesty', () => {
    expect(isSafePath('../etc/passwd')).toBe(false);
    expect(isSafePath('src/../../etc')).toBe(false);
    expect(isSafePath('/etc/passwd')).toBe(false);
    expect(isSafePath('C:\\Windows')).toBe(false);
    expect(isSafePath('src//App.tsx')).toBe(false);
    expect(isSafePath('.env')).toBe(false);
  });
  it('povolí projektové cesty', () => {
    expect(isSafePath('package.json')).toBe(true);
    expect(isSafePath('index.html')).toBe(true);
    expect(isSafePath('src/main.tsx')).toBe(true);
    expect(isSafePath('src/components/Sidebar.tsx')).toBe(true);
  });
  it('veľkostné limity', () => {
    expect(withinSizeLimits([{ path: 'a', content: 'x'.repeat(300_000) }]).ok).toBe(false);
    expect(withinSizeLimits([{ path: 'a', content: 'x' }]).ok).toBe(true);
    expect(withinSizeLimits(Array.from({ length: 50 }, (_, i) => ({ path: 'src/f' + i, content: 'x' }))).ok).toBe(false);
  });
});

describe('validateFiles (Workstream F)', () => {
  it('validné súbory prejdú', () => {
    const r = validateFiles(JSON.parse(filesJson).files, 40);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  it('invalidná cesta → invalid_path chyba', () => {
    const r = validateFiles([{ path: '../../evil', content: 'x', action: 'create' }], 40);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'invalid_path')).toBe(true);
  });
  it('prázdny výstup → empty chyba', () => {
    const r = validateFiles([], 40);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'empty')).toBe(true);
  });
  it('duplicitné cesty → schema chyba', () => {
    const r = validateFiles([
      { path: 'src/App.tsx', content: 'a', action: 'create' },
      { path: 'src/App.tsx', content: 'b', action: 'create' },
    ], 40);
    expect(r.errors.some(e => e.code === 'schema' && e.message.includes('duplicitná'))).toBe(true);
  });
  it('malformed model output → schema chyby, nie crash', () => {
    const r = validateFiles([{ path: 42 }, { nope: true }, 'string'], 40);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('extractJson + prompts (mock transport)', () => {
  it('extractJson toleruje markdown obalenie', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('pre text {"a":{"b":2}} post')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('žiadny json')).toThrow();
  });

  it('requestPlan: validný plán z mock providera', async () => {
    const t = mockTransport([{ status: 200, body: { choices: [{ message: { content: planJson } }], usage: { prompt_tokens: 10, completion_tokens: 20 } } }]);
    const p = new MistralProvider({ apiKey: 'test', model: 'mistral-test' }, t);
    const plan = await requestPlan(p, { projectId: 'p', prompt: 'CRM dashboard', mode: 'create', context: { files: [], history: [] } } as never);
    expect(plan.summary).toContain('CRM');
    expect(plan.filesPlanned).toContain('src/App.tsx');
    // system prompt obsahuje JSON-only inštrukcie
    const firstCall = t.calls[0] as { messages: Array<{ role: string; content: string }> };
    expect(firstCall.messages[0].role).toBe('system');
    expect(firstCall.messages[0].content).toContain('VÝHRADNE JSON');
  });

  it('requestPlan: malformed plán → explicitná chyba', async () => {
    const t = mockTransport([{ status: 200, body: { choices: [{ message: { content: 'blbosť bez json' } }] } }]);
    const p = new MistralProvider({ apiKey: 'test', model: 'm' }, t);
    await expect(requestPlan(p, { projectId: 'p', prompt: 'x', mode: 'create', context: { files: [], history: [] } } as never)).rejects.toThrow(/neobsahuje JSON|nevalidná/);
  });

  it('requestFiles: multi-file výstup', async () => {
    const t = mockTransport([{ status: 200, body: { choices: [{ message: { content: filesJson } }] } }]);
    const p = new MistralProvider({ apiKey: 'test', model: 'm' }, t);
    const files = await requestFiles(p, { projectId: 'p', prompt: 'CRM', mode: 'create', context: { files: [], history: [] } } as never, { summary: 's', steps: [], filesPlanned: [] });
    expect(files.length).toBe(5);
    expect(files.map(f => f.path)).toContain('src/main.tsx');
  });
});

describe('Hono app (Workstream A/D)', () => {
  const cfg: ServerConfig = { mistralApiKey: 'test-key', rateLimitPerMin: 100 };

  it('POST /api/agent/generate: reálne eventy v správnom poradí (run_started → plan → validation → stage → done)', async () => {
    const t = mockTransport([
      { status: 200, body: { choices: [{ message: { content: planJson } }] } },
      { status: 200, body: { choices: [{ message: { content: filesJson } }] } },
    ]);
    const provider = new MistralProvider({ apiKey: 'k', model: 'mock' }, t);
    const app = createApp(cfg, provider);
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', prompt: 'Create a modern CRM dashboard', mode: 'create' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const types = [...text.matchAll(/"type":"([a-z_]+)"/g)].map(m => m[1]);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('plan');
    expect(types).toContain('validation');
    expect(types).toContain('stage');
    expect(types[types.length - 1]).toBe('done');
  });

  it('bez providera → 503 ai_not_configured (nie tichý fallback na šablóny)', async () => {
    const app = createApp({}, null);
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', prompt: 'x', mode: 'create' }),
    });
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error).toBe('ai_not_configured');
  });

  it('invalid request body → bad_request event', async () => {
    const t = mockTransport([{ status: 200, body: {} }]);
    const provider = new MistralProvider({ apiKey: 'k', model: 'm' }, t);
    const app = createApp(cfg, provider);
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: '' }),
    });
    const text = await res.text();
    expect(text).toContain('bad_request');
  });

  it('rate limit: nad limit → 429', async () => {
    const t = mockTransport([{ status: 200, body: { choices: [{ message: { content: planJson } }] } }]);
    const provider = new MistralProvider({ apiKey: 'k', model: 'm' }, t);
    const app = createApp(cfg, provider, { rateLimit: () => false });
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', prompt: 'x', mode: 'create' }),
    });
    expect(res.status).toBe(429);
  });

  it('provider HTTP 500 → retriable error event', async () => {
    const t = mockTransport([{ status: 500, body: { error: 'upstream' } }]);
    const provider = new MistralProvider({ apiKey: 'k', model: 'm' }, t);
    const app = createApp(cfg, provider);
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', prompt: 'x', mode: 'create' }),
    });
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('provider_error');
  });

  it('health endpoint hlási AI stav', async () => {
    const app = createApp({}, null);
    const res = await app.request('/api/health');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.ai).toBe('not-configured');
  });
});

describe('rate limiter', () => {
  it('limituje počet požiadaviek za minútu', () => {
    const rl = makeRateLimiter(2);
    expect(rl('u')).toBe(true);
    expect(rl('u')).toBe(true);
    expect(rl('u')).toBe(false);
    expect(rl('other')).toBe(true);
  });
});
