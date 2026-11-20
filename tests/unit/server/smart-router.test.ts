// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, CompletionChunk } from '../../../server/providers/types';
import { ProviderError } from '../../../server/providers/errors';
import type { ProviderUpdate } from '../../../server/providers/resilience';
import { ProviderRegistry } from '../../../server/providers/registry';
import { route, cascadeFor, smartProvider, ROUTER_THRESHOLDS } from '../../../server/providers/smartRouter';
import { estimateCost, parseFxRate, readUsdEurRate, usdMicrosToEurMicros, formatMicros, sumSession, DEFAULT_USD_EUR_RATE } from '../../../server/usage/costEstimator';
import { parsePricePolicy } from '../../../server/usage/pricing';
import { createApp } from '../../../server/index';

const rate = (model: string, input: string, output: string) => ({ provider: 'mistral', model, validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z', inputUsdPerMillion: input, outputUsdPerMillion: output });
const policy = parsePricePolicy(JSON.stringify({ schemaVersion: 1, version: 'test-v1', currency: 'USD', basis: 'uncached-text-tokens',
  rates: [rate('mistral-small-latest', '0.1', '0.3'), rate('codestral-latest', '0.3', '0.9'), rate('mistral-large-latest', '2', '6')] }));
const at = new Date('2026-11-20T12:00:00Z');
const opts = () => ({ sleep: vi.fn(async () => {}), random: () => 0 });

function fake(model: string, behaviour: Array<Error | 'ok'> = ['ok']): AIProvider & { calls: number } {
  const self = {
    name: 'mistral', model: model + '-latest', calls: 0,
    complete: vi.fn(async () => { const step = behaviour[Math.min(self.calls++, behaviour.length - 1)]; if (step !== 'ok') throw step; return { text: model, usage: { promptTokens: 1, completionTokens: 1 }, model: model + '-latest' }; }),
    async *stream(): AsyncIterable<CompletionChunk> {
      const step = behaviour[Math.min(self.calls++, behaviour.length - 1)]; if (step !== 'ok') throw step;
      yield { delta: model + ':a' }; yield { delta: model + ':b' }; yield { finishReason: 'stop' };
    },
  };
  return self;
}
async function collect(stream: AsyncIterable<CompletionChunk>) { const out: string[] = []; for await (const chunk of stream) if (chunk.delta) out.push(chunk.delta); return out; }

describe('smart router: deterministic route()', () => {
  it('sends short fix/explain prompts to mistral-small', () => {
    expect(route('Oprav preklep v tlačidle', 'fix', { fileCount: 1 })).toEqual({ model: 'mistral-small', reason: 'short_fix_or_explain', rule: 'short_fix_or_explain' });
    expect(route('Čo robí tento hook?', 'explain')).toMatchObject({ model: 'mistral-small' });
    expect(route('Pridaj tlačidlo Uložiť', 'generate')).toMatchObject({ model: 'mistral-small', reason: 'short_prompt' });
  });
  it('sends architecture keywords, large contexts and long prompts to mistral-large', () => {
    expect(route('Navrhni architektúru multi-tenant rezervačného systému', 'generate')).toMatchObject({ model: 'mistral-large', reason: 'architecture_keywords' });
    expect(route('Refactor the auth layer', 'fix')).toMatchObject({ model: 'mistral-large', reason: 'architecture_keywords' });
    expect(route('Uprav komponent', 'generate', { fileCount: ROUTER_THRESHOLDS.largeContextFiles })).toMatchObject({ model: 'mistral-large', reason: 'large_context' });
    expect(route('x'.repeat(ROUTER_THRESHOLDS.longPromptChars + 1), 'generate')).toMatchObject({ model: 'mistral-large', reason: 'long_prompt' });
  });
  it('routes ordinary code generation to codestral and respects boundaries exactly', () => {
    expect(route('Vytvor stránku s cenníkom, tromi kartami a prepínačom mesačne/ročne. ' + 'Detailný popis. '.repeat(20), 'generate')).toMatchObject({ model: 'codestral', reason: 'code_generation' });
    expect(route('a'.repeat(ROUTER_THRESHOLDS.shortPromptChars), 'generate').model).toBe('mistral-small');
    expect(route('a'.repeat(ROUTER_THRESHOLDS.shortPromptChars + 1), 'generate').model).toBe('codestral');
    expect(route('a'.repeat(ROUTER_THRESHOLDS.fixExplainMaxChars), 'fix').model).toBe('mistral-small');
    expect(route('a'.repeat(ROUTER_THRESHOLDS.fixExplainMaxChars + 1), 'fix').model).toBe('codestral');
    expect(route('Oprav chybu', 'fix', { fileCount: ROUTER_THRESHOLDS.fixExplainMaxFiles + 1 }).model).toBe('codestral');
    expect(route('Oprav chybu', 'fix', { fileCount: -5 }).model).toBe('mistral-small');
  });
  it('explicit user choice always wins over every rule', () => {
    expect(route('Navrhni architektúru celého systému', 'generate', { explicitModel: 'mistral-small', fileCount: 99 })).toEqual({ model: 'mistral-small', reason: 'explicit_user_choice', rule: 'explicit_user_choice' });
    expect(route('fix', 'fix', { explicitModel: 'mistral-large' }).model).toBe('mistral-large');
    expect(route('fix', 'fix', { explicitModel: 'openai', availableModels: ['openai', 'mistral-small'] })).toMatchObject({ model: 'openai', reason: 'explicit_user_choice' });
  });
  it('is pure: same input → same output, no mutation of context', () => {
    const context = Object.freeze({ fileCount: 4, availableModels: Object.freeze(['codestral', 'mistral-small']) });
    const a = route('Vytvor dashboard s grafmi a tabuľkou objednávok, filtrami a exportom do CSV pre celý tím.'.repeat(5), 'generate', context);
    expect(route('Vytvor dashboard s grafmi a tabuľkou objednávok, filtrami a exportom do CSV pre celý tím.'.repeat(5), 'generate', context)).toEqual(a);
  });
  it('substitutes along the cascade when the routed model is not configured', () => {
    expect(route('Navrhni architektúru', 'generate', { availableModels: ['mistral-small', 'codestral'] })).toEqual({ model: 'codestral', reason: 'unavailable_substitute', rule: 'architecture_keywords' });
    expect(route('Oprav', 'fix', { availableModels: ['mistral'] })).toMatchObject({ model: 'mistral', reason: 'unavailable_substitute' });
    expect(route('Oprav', 'fix', { explicitModel: 'ghost', availableModels: ['mistral-small'] })).toMatchObject({ model: 'mistral-small', reason: 'short_fix_or_explain' });
    expect(() => route('Oprav', 'fix', { availableModels: [] })).toThrow('invalid_model');
    expect(cascadeFor('mistral-small')).toEqual(['mistral-small', 'codestral', 'mistral-large']);
    expect(cascadeFor('codestral', ['codestral', 'mistral-small'])).toEqual(['codestral', 'mistral-small']);
    expect(cascadeFor('openai')).toEqual(['openai']);
  });
});

describe('smart router: cascade fallback via resilience.ts', () => {
  it('falls back on 503 to the next model without losing the stream and records the cause', async () => {
    const small = fake('mistral-small', [new ProviderError('unavailable'), new ProviderError('unavailable')]), codestral = fake('codestral');
    const providers: Record<string, AIProvider> = { 'mistral-small': small, codestral, 'mistral-large': fake('mistral-large') };
    const events: ProviderUpdate[] = [];
    const run = smartProvider(route('Oprav preklep', 'fix'), id => providers[id], { ...opts(), onUpdate: e => events.push(e) });
    expect(run.chain).toEqual(['mistral-small', 'codestral', 'mistral-large']);
    expect(await collect(run.provider.stream([]))).toEqual(['codestral:a', 'codestral:b']);
    expect(run.fallbacks).toEqual([{ from: 'mistral-small', to: 'codestral', reason: 'fallback', cause: 'unavailable', attempt: 3 }]);
    expect(events.map(e => e.reason)).toEqual(['retry', 'fallback']);
  });
  it('falls back on 429 with Retry-After (complete) and keeps opaque 429 non-transient per existing policy', async () => {
    const large = fake('mistral-large', [new ProviderError('rate_limited', 60_000)]), codestral = fake('codestral');
    const run = smartProvider(route('Navrhni architektúru', 'generate'), id => ({ 'mistral-large': large, codestral } as Record<string, AIProvider>)[id], opts());
    expect((await run.provider.complete([])).text).toBe('codestral');
    expect(run.fallbacks).toEqual([{ from: 'mistral-large', to: 'codestral', reason: 'fallback', cause: 'rate_limited', attempt: 2 }]);
    const opaque = smartProvider(route('Oprav', 'fix'), id => ({ 'mistral-small': fake('mistral-small', [new ProviderError('rate_limited')]), codestral: fake('codestral') } as Record<string, AIProvider>)[id], opts());
    await expect(opaque.provider.complete([])).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(opaque.fallbacks).toEqual([]);
  });
  it('never replays a partially exposed stream on another model', async () => {
    const broken: AIProvider = { name: 'mistral', model: 'mistral-small-latest', complete: vi.fn(), async *stream() { yield { delta: 'part' }; throw new ProviderError('unavailable'); } };
    const codestral = fake('codestral');
    const run = smartProvider(route('Oprav', 'fix'), id => ({ 'mistral-small': broken, codestral } as Record<string, AIProvider>)[id], opts());
    await expect(collect(run.provider.stream([]))).rejects.toMatchObject({ kind: 'unavailable' });
    expect(codestral.calls).toBe(0);
  });
  it('does not cascade an explicit user choice unless allowed, and works with ProviderRegistry.find', async () => {
    const small = fake('mistral-small', [new ProviderError('unavailable')]), codestral = fake('codestral');
    const registry = new ProviderRegistry([{ id: 'mistral-small', label: 'Small', provider: small }, { id: 'codestral', label: 'Codestral', provider: codestral }]);
    expect(registry.ids()).toEqual(['mistral-small', 'codestral']);
    const resolve = (id: string) => registry.find(id)?.provider;
    const explicit = smartProvider(route('x', 'fix', { explicitModel: 'mistral-small' }), resolve, opts());
    expect(explicit.chain).toEqual(['mistral-small']);
    await expect(explicit.provider.complete([])).rejects.toMatchObject({ kind: 'unavailable' });
    expect(codestral.calls).toBe(0);
    const allowed = smartProvider(route('x', 'fix', { explicitModel: 'mistral-small' }), resolve, { ...opts(), allowExplicitFallback: true });
    expect((await allowed.provider.complete([])).text).toBe('codestral');
    expect(() => smartProvider({ model: 'mistral-large', reason: 'long_prompt', rule: 'long_prompt' }, resolve)).toThrow('invalid_model');
  });
});

describe('cost estimator: USD by pricing.ts, EUR by configurable rate', () => {
  it('prices router ids through their reported model aliases in exact micro-USD', () => {
    expect(estimateCost({ model: 'mistral-large', inputTokens: 1200, outputTokens: 200, at }, policy, parseFxRate('0.92')))
      .toEqual({ status: 'priced', model: 'mistral-large', usdMicros: '3600', eurMicros: '3312', usd: '0.0036', eur: '0.0033', reason: null });
    expect(estimateCost({ model: 'codestral-latest', inputTokens: 1_000_000, outputTokens: 1_000_000, at }, policy)).toMatchObject({ usdMicros: '1200000', usd: '1.20', eur: '1.10' });
  });
  it('handles boundary token counts and rounding', () => {
    expect(estimateCost({ model: 'mistral-small', inputTokens: 0, outputTokens: 0, at }, policy)).toMatchObject({ status: 'priced', usdMicros: '0', eurMicros: '0', usd: '0.0000', eur: '0.0000' });
    expect(estimateCost({ model: 'mistral-small', inputTokens: 1, outputTokens: 0, at }, policy)).toMatchObject({ usdMicros: '1', eurMicros: '1' });
    expect(estimateCost({ model: 'mistral-large', inputTokens: 1_000_000_000, outputTokens: 1_000_000_000, at }, policy)).toMatchObject({ usdMicros: '8000000000', usd: '8000.00', eur: '7360.00' });
    for (const bad of [-1, 1.5, 1_000_000_001, Number.NaN]) expect(estimateCost({ model: 'mistral-small', inputTokens: bad, outputTokens: 0, at }, policy)).toMatchObject({ status: 'unpriced', reason: 'invalid_tokens', usd: null });
    expect(formatMicros(49n)).toBe('0.0000'); expect(formatMicros(50n)).toBe('0.0001'); expect(formatMicros(999_949n)).toBe('0.9999');
    expect(formatMicros(999_950n)).toBe('1.0000'); expect(formatMicros(1_000_000n)).toBe('1.00'); expect(formatMicros(1_004_999n)).toBe('1.00'); expect(formatMicros(1_005_000n)).toBe('1.01');
    expect(usdMicrosToEurMicros(1n, 920_000n)).toBe(1n); expect(usdMicrosToEurMicros(0n, 920_000n)).toBe(0n); expect(usdMicrosToEurMicros(1_000_000n, 1n)).toBe(1n);
  });
  it('reports unknown price instead of zero when pricing is missing', () => {
    expect(estimateCost({ model: 'mistral-small', inputTokens: 10, outputTokens: 10, at }, null)).toMatchObject({ status: 'unpriced', reason: 'no_policy', usdMicros: null, eur: null });
    expect(estimateCost({ model: 'ministral-3b', inputTokens: 10, outputTokens: 10, at }, policy)).toMatchObject({ status: 'unpriced', reason: 'no_effective_rate' });
    expect(estimateCost({ model: 'mistral-small', inputTokens: 10, outputTokens: 10, at: new Date('2027-06-01T00:00:00Z') }, policy)).toMatchObject({ status: 'unpriced', reason: 'no_effective_rate' });
  });
  it('reads the FX rate from env or constant, rejects invalid values (no live API)', () => {
    expect(DEFAULT_USD_EUR_RATE).toBe('0.92');
    expect(readUsdEurRate({})).toBe(920_000n); expect(readUsdEurRate({ AI_USD_EUR_RATE: ' ' })).toBe(920_000n);
    expect(readUsdEurRate({ AI_USD_EUR_RATE: '0.875432' })).toBe(875_432n); expect(readUsdEurRate({ AI_USD_EUR_RATE: '100' })).toBe(100_000_000n);
    for (const bad of ['0', '0.0000001', '-1', '1e3', 'abc', '100.000001', '1,05']) expect(parseFxRate(bad)).toBeNull();
    expect(estimateCost({ model: 'mistral-large', inputTokens: 1200, outputTokens: 200, at }, policy, null)).toMatchObject({ status: 'priced', usd: '0.0036', eur: null, eurMicros: null, reason: 'invalid_fx_rate' });
  });
  it('sums a session without turning unknown runs into zero', () => {
    const a = estimateCost({ model: 'mistral-large', inputTokens: 1200, outputTokens: 200, at }, policy);
    const b = estimateCost({ model: 'codestral', inputTokens: 1_000_000, outputTokens: 0, at }, policy);
    const unknown = estimateCost({ model: 'ghost', inputTokens: 1, outputTokens: 1, at }, policy);
    expect(sumSession([a, b])).toMatchObject({ runs: 2, pricedRuns: 2, unknownRuns: 0, usdMicros: '303600', usd: '0.3036', complete: true });
    expect(sumSession([a, unknown])).toMatchObject({ runs: 2, pricedRuns: 1, unknownRuns: 1, usdMicros: '3600', complete: false });
    expect(sumSession([])).toMatchObject({ runs: 0, usdMicros: '0', complete: true });
    expect(sumSession([estimateCost({ model: 'mistral-large', inputTokens: 1, outputTokens: 1, at }, policy, null)])).toMatchObject({ eur: null, eurMicros: null });
  });
});

describe('agent-8 seam endpoints', () => {
  it('POST /api/ai-cost/estimate returns per-run quotes and a session total; validates input', async () => {
    const app = createApp({ aiPricing: policy }, null, { rateLimit: () => true });
    const response = await app.request('/api/ai-cost/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: [{ model: 'mistral-large', inputTokens: 1200, outputTokens: 200 }, { model: 'ghost', inputTokens: 1, outputTokens: 1 }] }) });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.runs[1]).toMatchObject({ status: 'unpriced' }); expect(body.session).toMatchObject({ pricedRuns: 1, unknownRuns: 1, complete: false });
    expect(body).toMatchObject({ usdEurRate: expect.stringMatching(/^\d+\.\d{2,4}$/), pricingVersion: 'test-v1' });
    for (const bad of [{}, { runs: [] }, { runs: [{ model: 'x', inputTokens: -1, outputTokens: 0 }] }, { runs: [{ model: 'x', inputTokens: 1, outputTokens: 1, extra: 1 }] }])
      expect((await app.request('/api/ai-cost/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).status).toBe(400);
    const limited = createApp({}, null, { rateLimit: () => false });
    expect((await limited.request('/api/ai-cost/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runs: [{ model: 'x', inputTokens: 1, outputTokens: 1 }] }) })).status).toBe(429);
  });
  it('POST /api/ai-router/preview routes only among configured models', async () => {
    const registry = new ProviderRegistry([{ id: 'codestral', label: 'C', provider: fake('codestral') }, { id: 'mistral-small', label: 'S', provider: fake('mistral-small') }]);
    const app = createApp({}, null, { providers: registry, rateLimit: () => true });
    const post = (body: unknown) => app.request('/api/ai-router/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await post({ prompt: 'Oprav preklep', mode: 'fix' })).json()).toEqual({ model: 'mistral-small', reason: 'short_fix_or_explain', rule: 'short_fix_or_explain' });
    expect(await (await post({ prompt: 'Navrhni architektúru' })).json()).toMatchObject({ model: 'codestral', reason: 'unavailable_substitute' });
    expect((await post({ prompt: 'x', mode: 'hack' })).status).toBe(400);
    expect((await createApp({}, null, { rateLimit: () => true }).request('/api/ai-router/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) })).status).toBe(503);
  });
});
