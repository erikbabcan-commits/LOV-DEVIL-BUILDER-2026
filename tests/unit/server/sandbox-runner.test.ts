// @vitest-environment node
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerServer } from '../../../server/sandbox/runner';
import { CompileQueue } from '../../../server/sandbox/queue';
import { SandboxError } from '../../../server/sandbox/errors';

const token = 'runner-unit-private-token-1234567890';
const files = [{ path: 'src/main.tsx', content: 'console.log("ok")' }];
const good = { ok: true, html: 'ok', errors: [], moduleCount: 1, durationMs: 1 };
const servers: ReturnType<typeof createRunnerServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
async function fixture(compile = vi.fn(async (_files: unknown, _signal: AbortSignal) => good), queue?: CompileQueue) {
  const server = createRunnerServer(token, { ready: async () => true, compile }, queue); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (value: unknown, signal?: AbortSignal) => fetch(base + '/v1/compile', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(value), signal,
  });
  return { base, post, compile };
}

describe('private compile runner protocol', () => {
  it('authenticates readiness and accepts only the narrow files schema', async () => {
    const { base, post, compile } = await fixture();
    expect((await fetch(base + '/ready')).status).toBe(401);
    const ready = await fetch(base + '/ready', { headers: { Authorization: 'Bearer ' + token } });
    expect(await ready.json()).toEqual({ ready: true, queue: { active: 0, waiting: 0 } });
    expect((await post({ files, image: 'evil', command: 'sh' })).status).toBe(400);
    expect(compile).not.toHaveBeenCalled();
    expect(await (await post({ files })).json()).toEqual(good);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('validates paths before spawning and returns safe fixed infrastructure errors', async () => {
    const compile = vi.fn(async () => { throw new SandboxError('sandbox_cleanup_failed'); });
    const { post } = await fixture(compile);
    expect((await (await post({ files: [{ path: '../bad', content: '' }] })).json()).ok).toBe(false);
    expect(compile).not.toHaveBeenCalled();
    const response = await post({ files }); expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('sandbox_cleanup_failed');
  });

  it('aborts an active worker when its HTTP caller disconnects', async () => {
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let aborted!: () => void; const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const compile = vi.fn(async (_files: unknown, signal: AbortSignal) => {
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      throw new SandboxError('sandbox_aborted');
    });
    const queue = new CompileQueue(); const { post } = await fixture(compile, queue);
    const controller = new AbortController(); const pending = post({ files }, controller.signal).catch(() => undefined);
    await entered; controller.abort(); await cancelled; await pending;
    await vi.waitFor(() => expect(queue.stats).toEqual({ active: 0, waiting: 0 }));
  });
});
