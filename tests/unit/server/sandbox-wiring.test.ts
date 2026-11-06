// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/index';
import { autofixLoop } from '../../../server/agent/autofix';
import { SandboxError } from '../../../server/sandbox/errors';
import type { SandboxExecutor } from '../../../server/sandbox/executor';
import type { AIProvider } from '../../../server/providers/types';
import {sourceHash} from '../../../server/agent/patches';

const files = [{ path: 'src/main.tsx', content: 'const x = {' }];
const broken = { ok: false, html: null, errors: [{ file: 'src/main.tsx', message: 'syntax error' }], durationMs: 1, moduleCount: 1 };
const good = { ok: true, html: 'ok', errors: [], durationMs: 1, moduleCount: 1 };
function provider() {
  const complete = vi.fn<AIProvider['complete']>(async messages => {const file=JSON.parse(messages[1].content).files[0];return{ text: JSON.stringify({version:1,summary:'Fix syntax',changes:[{path:file.path,action:'modify',beforeSha256:sourceHash(file.content),edits:[{search:file.content,replace:file.content.includes('fixed')?file.content+'\n// verified':'console.log("fixed")'}]}]}),usage:{promptTokens:0,completionTokens:0}};});
  return { name: 'mock', model: 'mock', complete, async *stream() {} } satisfies AIProvider;
}
function executor() {
  return { execute: vi.fn<SandboxExecutor['execute']>(), ready: async () => ({ ready: true, mode: 'isolated' as const }) };
}
const request = (path: string) => new Request('http://localhost/api/sandbox/' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }),
});

describe('build and autofix share the injected executor', () => {
  it('uses it for the build route and all three autofix compiles', async () => {
    const sandbox = executor(); const ai = provider();
    sandbox.execute.mockResolvedValueOnce(good).mockResolvedValueOnce(broken).mockResolvedValueOnce(broken).mockResolvedValueOnce(good);
    const app = createApp({}, ai, { sandbox });
    expect((await app.request(request('build'))).status).toBe(200);
    const result = await app.request(request('autofix'));
    expect(result.status).toBe(200); expect((await result.json()).attempts).toBe(2);
    expect(sandbox.execute).toHaveBeenCalledTimes(4); expect(ai.complete).toHaveBeenCalledTimes(2);
    expect(sandbox.execute.mock.calls[2][0][0].content).toContain('fixed');
  });

  it('does not call AI for infrastructure failure on the initial build', async () => {
    const sandbox = executor(); const ai = provider();
    sandbox.execute.mockRejectedValue(new SandboxError('sandbox_unavailable'));
    const app = createApp({}, ai, { sandbox });
    const response = await app.request(request('autofix'));
    expect(response.status).toBe(503); expect((await response.json()).error).toBe('sandbox_unavailable');
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('returns a readable infrastructure error for existing preview clients', async () => {
    const sandbox = executor(); sandbox.execute.mockRejectedValue(new SandboxError('sandbox_busy'));
    const app = createApp({}, null, { sandbox });
    const response = await app.request(request('build'));
    expect(response.status).toBe(429);
    expect((await response.json()).errors[0].message).toContain('Fronta kompilácie je plná');
  });

  it('stops further paid attempts if infrastructure fails during a rebuild', async () => {
    const sandbox = executor(); const ai = provider();
    sandbox.execute.mockResolvedValueOnce(broken).mockRejectedValueOnce(new SandboxError('sandbox_timeout'));
    await expect(autofixLoop(ai, files, { executor: sandbox })).rejects.toMatchObject({ code: 'sandbox_timeout' });
    expect(ai.complete).toHaveBeenCalledTimes(1); expect(sandbox.execute).toHaveBeenCalledTimes(2);
  });

  it('redacts credentials even inside unknown schema keys', async () => {
    const sandbox = executor(); const canary = ['ghp', 'SCHEMA_CANARY_012345678901234567890'].join('_');
    const app = createApp({}, null, { sandbox });
    const response = await app.request('/api/sandbox/build', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ ...files[0], [canary]: 'unknown key' }] }) });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(canary);
    expect(sandbox.execute).not.toHaveBeenCalled();
  });
});
