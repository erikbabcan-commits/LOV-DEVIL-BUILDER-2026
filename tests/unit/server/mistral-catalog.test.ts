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
        ? Response.json({ model: 'codestral-latest', choices: [{ message: { content: 'OK' } }] })
        : Response.json({ data: [card('codestral-latest'), card('mistral-large-latest'), card('mistral-small-latest'), card('unlisted-model')] }),
    );
    const providers = await configuredProvidersWithMistralCatalog(env, fetcher);
    const app = createApp({}, providers.defaultProvider, { providers });
    const response = await app.request('/api/ai-models');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultId: 'mistral',
      models: [
        { id: 'mistral', model: 'mistral-large-latest', fallbackIds: [] },
        { id: 'codestral', label: 'Codestral (kód a aplikácie)', model: 'codestral-latest', fallbackIds: [] },
        { id: 'mistral-small', label: 'Mistral Small (rýchle úpravy)', model: 'mistral-small-latest', fallbackIds: [] },
      ],
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/models');
    await providers.route('codestral')[0].provider.complete([{ role: 'user', content: 'Fixture' }]);
    expect(String(fetcher.mock.calls[1][0])).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).model).toBe('codestral-latest');
  });

  it('matches versioned catalog cards through aliases (codestral-XXXX ↔ codestral-latest)', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      data: [card('codestral-2508', true, ['codestral-latest']), card('mistral-large-latest'), card('mistral-small-latest')],
    }));
    // Primárny model je codestral-latest → codestral voľba sa deduplikuje, zostáva Large + Small.
    const providers = await configuredProvidersWithMistralCatalog(
      { ...env, MISTRAL_MODEL: 'codestral-latest' }, fetcher,
    );
    expect(providers.catalog().models).toMatchObject([
      { id: 'mistral', model: 'codestral-latest' },
      { id: 'mistral-large', model: 'mistral-large-latest' },
      { id: 'mistral-small', model: 'mistral-small-latest' },
    ]);
  });

  it('omits missing, archived and non-chat options and dedupes the primary model', async () => {
    for (const small of [
      card('mistral-small-latest', false),
      { ...card('mistral-small-latest'), archived: true },
      card('another-model'),
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({
        data: [small, card('codestral-latest')],
      }));
      const providers = await configuredProvidersWithMistralCatalog(env, fetcher);
      expect(providers.catalog().models.map(model => model.id)).toEqual(['mistral', 'codestral']);
    }
    // Karta aliasujúca primárny model sa nepovoľuje ako druhý výber.
    const alias = vi.fn<typeof fetch>(async () => Response.json({
      data: [card('codestral-2508', true, ['codestral-latest'])],
    }));
    expect((await configuredProvidersWithMistralCatalog(
      { ...env, MISTRAL_MODEL: 'codestral-latest' }, alias,
    )).catalog().models.map(model => model.id)).toEqual(['mistral']);
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

  it('keeps explicit defaults alongside additional models visible to the key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      data: [card('codestral-latest'), card('mistral-small-latest'), card('mistral-medium-3-5', true, ['mistral-medium-latest']), card('ministral-14b-latest')],
    }));
    const providers = await configuredProvidersWithMistralCatalog({
      ...env, AI_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'openai-test', OPENAI_MODEL: 'openai-test-model',
      AI_DEFAULT_MODEL: 'openai',
    }, fetcher);
    expect(providers.catalog().defaultId).toBe('openai');
    expect(providers.catalog().models.map(model => model.id)).toEqual([
      'openai', 'mistral', 'codestral', 'mistral-small', 'mistral-medium', 'ministral-14b',
    ]);
  });
});
