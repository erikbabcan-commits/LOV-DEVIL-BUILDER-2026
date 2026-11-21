import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPAIR_MAX_ATTEMPTS, requestBuildRepair, validateRepairInput } from '../../src/services/ai/buildRepair';
import { MAX_ATTEMPTS } from '../../server/agent/autofixLimits';

/* Bora W3 P3-4: the client accepts every response the server can produce (3 attempts), tells the server
   its limit (maxAttempts) and validates the input before the paid call. */
const files = [{ path: 'src/main.tsx', content: 'export {};' }];
const fixed = [{ path: 'src/main.tsx', content: 'export {};\n// fix' }];
const steps = (n: number) => Array.from({ length: n }, (_, i) => [
  { attempt: i + 1, step: 'build', status: 'failed' }, { attempt: i + 1, step: 'patch', status: 'ok' }, { attempt: i + 1, step: 'rebuild', status: i + 1 === n ? 'ok' : 'failed' },
]).flat();
afterEach(() => { vi.unstubAllGlobals(); });

describe('requestBuildRepair client (Bora W3 P3-4)', () => {
  it('client limit equals the server limit', () => { expect(REPAIR_MAX_ATTEMPTS).toBe(MAX_ATTEMPTS); });

  it('sends maxAttempts and accepts a valid 3-attempt response with 9 progress steps', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, attempts: 3, progress: steps(3), patchesApplied: 3, finalFiles: fixed, buildErrors: [], route: { model: 'mistral', reason: 'configured_default' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await requestBuildRepair(files, {}, new AbortController().signal);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ files, maxAttempts: 3 });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(result.changes).toHaveLength(1);
  });

  it('accepts a partial quota_exceeded result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: false, attempts: 2, stopped: 'quota_exceeded', progress: steps(2).slice(0, 6), patchesApplied: 2, finalFiles: files, buildErrors: [] })));
    const result = await requestBuildRepair(files, {}, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, attempts: 2, stopped: 'quota_exceeded' });
  });

  it('rejects input it could not accept back BEFORE the paid call (fetch never runs)', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const invalid = [
      [],
      [...files, ...files],
      Array.from({ length: 41 }, (_, i) => ({ path: `src/f${i}.ts`, content: '' })),
      Array.from({ length: 11 }, (_, i) => ({ path: `src/big${i}.ts`, content: 'x'.repeat(199_000) })),
      [{ path: '', content: 'x' }],
    ];
    for (const input of invalid) {
      expect(validateRepairInput(input)).toBe(false);
      await expect(requestBuildRepair(input, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'context_limit' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(validateRepairInput(files)).toBe(true);
  });
});
