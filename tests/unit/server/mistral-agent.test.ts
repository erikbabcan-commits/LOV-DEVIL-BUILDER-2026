// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MistralProvider, MISTRAL_AGENT_ID_PATTERN } from '../../../server/providers/mistral';
import { configuredProviders, configuredProvidersWithMistralCatalog } from '../../../server/providers/runtime';
import { createApp } from '../../../server/index';
import type { ProviderTransport } from '../../../server/providers/types';

/* MISTRAL_AGENT_ID: voliteľné prepojenie na predkonfigurovaného Mistral Agenta (console.mistral.ai).
   Primárny vstup potom ide cez /v1/agents/completions (agent_id v tele) namiesto /v1/chat/completions. */

const agentId = 'ag:0f0c9e1a-2b3d-4c5f-8a9b-1c2d3e4f5a6b';
const card = (id: string, aliases: string[] = []) => ({
  id, capabilities: { completion_chat: true }, max_context_length: 262144, aliases,
});
const okCompletion = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };

describe('MISTRAL_AGENT_ID pattern', () => {
  it('prijíma ag:<uuid> tvary a odmieta ostatné', () => {
    expect(MISTRAL_AGENT_ID_PATTERN.test(agentId)).toBe(true);
    expect(MISTRAL_AGENT_ID_PATTERN.test('agent-123')).toBe(false);
    expect(MISTRAL_AGENT_ID_PATTERN.test('ag:short')).toBe(false);
    expect(MISTRAL_AGENT_ID_PATTERN.test('ag:hacker<script>')).toBe(false);
    expect(MISTRAL_AGENT_ID_PATTERN.test('sk-1234567890abcdef')).toBe(false);
  });
});

describe('Mistral Agents provider wiring', () => {
  it('complete ide cez /agents/completions s agent_id a bez model', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(okCompletion));
    const providers = configuredProviders({ MISTRAL_API_KEY: 'test-only', MISTRAL_AGENT_ID: agentId }, fetcher);
    const catalog = providers.catalog();
    expect(catalog.models).toMatchObject([{ id: 'mistral', label: 'AI (Mistral Agent)', model: agentId, fallbackIds: [] }]);
    const result = await providers.route(undefined)[0].provider.complete([{ role: 'user', content: 'Hello' }]);
    expect(result.text).toBe('OK');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.mistral.ai/v1/agents/completions');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.agent_id).toBe(agentId);
    expect(body.model).toBeUndefined();
  });

  it('ai-models endpoint reportuje agent vstup aj pri /api/ai-models', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(okCompletion));
    const providers = configuredProviders({ MISTRAL_API_KEY: 'test-only', MISTRAL_AGENT_ID: agentId }, fetcher);
    const app = createApp({}, providers.defaultProvider, { providers });
    const response = await app.request('/api/ai-models');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ defaultId: 'mistral', models: [{ id: 'mistral', label: 'AI (Mistral Agent)', model: agentId }] });
  });

  it('stream parsuje agenty rovnakým SSE protokolom ako chat', async () => {
    const sse = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Ahoj' } }] })}\n\n`));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
      { status: 200 },
    );
    const fetcher = vi.fn<typeof fetch>(async () => sse);
    const providers = configuredProviders({ MISTRAL_API_KEY: 'test-only', MISTRAL_AGENT_ID: agentId }, fetcher);
    let text = '';
    for await (const chunk of providers.route(undefined)[0].provider.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.delta) text += chunk.delta;
    }
    expect(text).toBe('Ahoj');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.agent_id).toBe(agentId);
    expect(body.stream).toBe(true);
  });

  it('agent primary cez agents/completions; extra voľby ostanú na chat/completions', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ model: 'ok', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        : Response.json({ data: [card('codestral-latest'), card('mistral-large-latest')] }),
    );
    const providers = await configuredProvidersWithMistralCatalog({ MISTRAL_API_KEY: 'test-only', MISTRAL_AGENT_ID: agentId }, fetcher);
    expect(providers.catalog().models.map(model => model.id)).toEqual(['mistral', 'codestral', 'mistral-large']);
    await providers.route('mistral')[0].provider.complete([{ role: 'user', content: 'A' }]);
    await providers.route('codestral')[0].provider.complete([{ role: 'user', content: 'B' }]);
    expect(String(fetcher.mock.calls[1][0])).toBe('https://api.mistral.ai/v1/agents/completions');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).agent_id).toBe(agentId);
    expect(String(fetcher.mock.calls[2][0])).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).model).toBe('codestral-latest');
  });

  it('odmieta neplatný agent id (provider aj runtime wiring)', () => {
    const transport: ProviderTransport = { postChat: async () => Response.json(okCompletion) };
    expect(() => new MistralProvider({ apiKey: 'k', agentId: 'agent-1' }, transport)).toThrow('invalid_mistral_agent_id');
    expect(() => configuredProviders({ MISTRAL_API_KEY: 'k', MISTRAL_AGENT_ID: 'not-an-agent' }, vi.fn())).toThrow('invalid_provider_configuration');
  });
});

describe('SSE keep-alive (proxy idle guard)', () => {
  it('agent/generate vysielá : ping komentár každých 15s, kým je run otvorený', async () => {
    vi.useFakeTimers();
    try {
      const planJson = JSON.stringify({
        summary: 'Test plán',
        steps: [{ id: 'scaffold', title: 'Vytvor štruktúru' }],
        filesPlanned: ['src/App.tsx'],
      });
      const filesJson = JSON.stringify({
        files: [{ path: 'src/App.tsx', content: 'export default function App(){ return <h1>CRM</h1>; }', action: 'create' }],
      });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let call = 0;
      const transport: ProviderTransport = {
        async postChat() {
          // Prvé volanie (plan) drží run otvorený, kým virtuálny čas neodbehne 15s.
          if (call === 0) { await gate; call = 1; return Response.json({ choices: [{ message: { content: planJson } }] }); }
          return Response.json({ choices: [{ message: { content: filesJson } }] });
        },
      };
      const provider = new MistralProvider({ apiKey: 'k', model: 'mock' }, transport);
      const app = createApp({ mistralApiKey: 'k', rateLimitPerMin: 100 }, provider);
      const res = await app.request('/api/agent/generate', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'p1', prompt: 'Create a modern CRM dashboard', mode: 'create' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      const collected: string[] = [];
      const readAll = (async () => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          collected.push(decoder.decode(value, { stream: true }));
        }
      })();
      await vi.advanceTimersByTimeAsync(15_000);
      release();
      await readAll;
      const text = collected.join('');
      expect(text).toContain(': ping\n\n');
      expect(text).toContain('"type":"run_started"');
      expect(text).toContain('"type":"done"');
      // Pingu predchádzajú len štandardné data: záznamy — komentár nie je data event.
      const dataRecords = text.split('\n\n').filter(part => part.startsWith('data:'));
      expect(dataRecords.every(part => JSON.parse(part.slice(5)).type !== undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
