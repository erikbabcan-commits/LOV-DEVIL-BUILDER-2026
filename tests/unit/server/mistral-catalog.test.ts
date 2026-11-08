// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { configuredProvidersWithMistralCatalog } from '../../../server/providers/runtime';
import { createApp } from '../../../server/index';

const env = { MISTRAL_API_KEY: 'test-only', MISTRAL_MODEL: 'mistral-large-latest' };
const card = (id: string, chat = true, aliases: string[] = []) => ({
  id, capabilities: { completion_chat: chat }, max_context_length: 262144, aliases,
});

describe('verified Mistral model picker', () => {
  it('lists key-visible options in Hono and routes the chosen model upstream', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ model: 'mistral-medium-2604', choices: [{ message: { content: 'OK' } }] })
        : Response.json({ data: [card('mistral-small-2603'), card('mistral-medium-2604'), card('unlisted-model')] }),
    );
    const providers = await configuredProvidersWithMistralCatalog(env, fetcher);
    const app = createApp({}, providers.defaultProvider, { providers });
    const response = await app.request('/api/ai-models');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultId: 'mistral',
      models: [
        { id: 'mistral', model: 'mistral-large-latest', fallbackIds: [] },
        { id: 'mistral-medium-2604', model: 'mistral-medium-2604', fallbackIds: [] },
        { id: 'mistral-small-2603', model: 'mistral-small-2603', fallbackIds: [] },
      ],
    });
    expect(fetcher.mock.calls[0]).toEqual([
      'https://api.mistral.ai/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-only' }, redirect: 'error' }),
    ]);
    await providers.route('mistral-medium-2604')[0].provider.complete([{ role: 'user', content: 'Fixture' }]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).model).toBe('mistral-medium-2604');
  });

  it('omits missing, archived, non-chat and duplicate alias options', async () => {
    for (const small of [
      card('mistral-small-2603', false),
      { ...card('mistral-small-2603'), archived: true },
      card('another-model'),
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({
        data: [small, card('mistral-medium-2604', true, ['mistral-medium-latest'])],
      }));
      const providers = await configuredProvidersWithMistralCatalog(
        { ...env, MISTRAL_MODEL: 'mistral-medium-latest' }, fetcher,
      );
      expect(providers.catalog().models.map(model => model.id)).toEqual(['mistral']);
    }
  });

  it('keeps configured options when catalog lookup fails and skips custom endpoints', async () => {
    const rejected = vi.fn<typeof fetch>(async () => Response.json({ error: 'denied' }, { status: 401 }));
    expect((await configuredProvidersWithMistralCatalog(env, rejected)).catalog().models).toHaveLength(1);
    const fetcher = vi.fn<typeof fetch>();
    expect((await configuredProvidersWithMistralCatalog(
      { ...env, MISTRAL_BASE_URL: 'https://example.test/v1' }, fetcher,
    )).catalog().models).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('respects the existing three-slot catalog and explicit defaults', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      data: [card('mistral-medium-2604'), card('mistral-small-2603')],
    }));
    const providers = await configuredProvidersWithMistralCatalog({
      ...env, AI_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'openai-test', OPENAI_MODEL: 'openai-test-model',
      AI_DEFAULT_MODEL: 'openai',
    }, fetcher);
    expect(providers.catalog().defaultId).toBe('openai');
    expect(providers.catalog().models.map(model => model.id)).toEqual(['openai', 'mistral', 'mistral-medium-2604']);
  });
});
