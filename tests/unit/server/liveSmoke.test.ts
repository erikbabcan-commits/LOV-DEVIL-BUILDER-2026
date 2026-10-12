// @vitest-environment node
import { describe, it, expect } from 'vitest';

/* LIVE Mistral smoke test — beží IBA ak je MISTRAL_API_KEY v prostredí.
   Mock testy (agent.test.ts) nedokazujú reálnu inferenciu; tento áno.
   V CI bez kľúča sa preskočí (describe.skipIf). */

const hasKey = !!process.env.MISTRAL_API_KEY;

describe.skipIf(!hasKey)('LIVE Mistral smoke (vyžaduje MISTRAL_API_KEY)', () => {
  it('reálna inference: plán aj súbory pre CRM dashboard', async () => {
    const { makeProvider, createApp } = await import('../../../server/index');
    const provider = makeProvider({
      mistralApiKey: process.env.MISTRAL_API_KEY,
      mistralModel: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
    });
    expect(provider).not.toBeNull();
    const app = createApp({ mistralApiKey: process.env.MISTRAL_API_KEY }, provider);
    const res = await app.request('/api/agent/generate', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'smoke', prompt: 'Create a modern CRM dashboard with customers, tasks and a sidebar.', mode: 'create' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"plan"');
    expect(text).toContain('"type":"stage"');
    expect(text).toContain('src/App.tsx');
    expect(text).toContain('"type":"done"');
  }, 180_000);
});
