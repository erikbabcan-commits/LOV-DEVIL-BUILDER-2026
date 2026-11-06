// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSandboxExecutor, HostExecutor, IsolatedExecutor } from '../../../server/sandbox/executor';
import { MAX_OUTPUT_JSON_BYTES } from '../../../server/sandbox/policy';
import * as builder from '../../../server/sandbox/builder';

const token = 'unit-test-private-control-token-12345';
const files = [{ path: 'src/main.tsx', content: 'console.log("ok")' }];
const good = { ok: true, html: '<html>ok</html>', errors: [], durationMs: 1, moduleCount: 1 };

describe('sandbox executor boundary', () => {
  it('defaults to unavailable isolation; host mode must be explicitly selected', async () => {
    expect(createSandboxExecutor({ SANDBOX_MODE: 'host' })).toBeInstanceOf(HostExecutor);
    for (const env of [{}, { SANDBOX_MODE: 'typo' }, { SANDBOX_MODE: 'isolated' }]) {
      const executor = createSandboxExecutor(env);
      expect(await executor.ready()).toEqual({ ready: false, mode: 'isolated' });
      await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    }
  });

  it('sends only files and bearer auth; unavailable runner never invokes host builder', async () => {
    const host = vi.spyOn(builder, 'buildProject');
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('private daemon detail'));
    const executor = new IsolatedExecutor('http://runner:8790/', token, transport);
    await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe('http://runner:8790/v1/compile');
    expect(JSON.parse(init!.body as string)).toEqual({ files }); expect(init!.redirect).toBe('error');
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer ' + token });
    expect(host).not.toHaveBeenCalled(); host.mockRestore();
  });

  it('validates result schema and redacts remote diagnostics', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(good))
      .mockResolvedValueOnce(Response.json({ ...good, html: null }))
      .mockResolvedValueOnce(Response.json({ ok: false, html: null, durationMs: 1, moduleCount: 0,
        errors: [{ file: 'src/main.tsx', message: 'ghp_fakeunitcredential12345678901234567890' }] }));
    const executor = new IsolatedExecutor('http://runner/', token, transport);
    expect(await executor.execute(files)).toEqual(good);
    await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_protocol' });
    expect(JSON.stringify(await executor.execute(files))).not.toContain('fakeunitcredential12345678901234567890');
  });

  it('bounds malformed output and replaces remote infrastructure messages', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('x'.repeat(MAX_OUTPUT_JSON_BYTES + 1)))
      .mockResolvedValueOnce(new Response('not JSON'))
      .mockResolvedValueOnce(Response.json({ error: 'sandbox_busy', message: 'private token detail' }, { status: 429 }));
    const executor = new IsolatedExecutor('http://runner/', token, transport);
    await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_output_limit' });
    await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_protocol' });
    await expect(executor.execute(files)).rejects.toMatchObject({ code: 'sandbox_busy', status: 429 });
  });

  it('rejects unsafe input before transport and propagates cancellation', async () => {
    const transport = vi.fn<typeof fetch>();
    const executor = new IsolatedExecutor('http://runner/', token, transport);
    expect((await executor.execute([{ path: '../bad', content: '' }])).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort();
    await expect(executor.execute(files, abort.signal)).rejects.toMatchObject({ code: 'sandbox_aborted' });
    expect(transport).not.toHaveBeenCalled();
    expect(() => new IsolatedExecutor('http://user:pass@runner/', token)).toThrow();
  });
});
