// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { makeGitHubBff } from '../../../server/integrations/githubBff';

/* Wave-2 glue (a): the BFF allow-list forwards exactly POST /api/cloud-github/export/sync,
   under the same origin, JSON, bearer and bridge rules as the existing export actions. */
const bridgeSecret = 'ab'.repeat(32);
const ORIGIN = 'https://lovable.test';
const URL_SYNC = ORIGIN + '/api/github-connect/export/sync';
const body = { repoName: 'export', slugSeed: 'Môj projekt', checkpointSha: null, confirmed: true, selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
const success = { ok: true, branch: 'forge/moj-projekt', commitSha: 'a'.repeat(40), pullNumber: 7, pullUrl: 'https://github.com/fixture/export/pull/7',
  filesUploaded: 3, repoFullName: 'fixture/export', repoUrl: 'https://github.com/fixture/export', repositoryId: 99, createdPull: true };

function bff(upstream: (url: string, init: RequestInit) => Response | Promise<Response>, verify = true) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => upstream(String(url), init ?? {}));
  const handler = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: ORIGIN + '/github/callback', clientId: 'fixture-client', bridgeSecret,
    verifyToken: async () => verify, fetch: fetcher });
  const call = (init: { method?: string; origin?: string | null; type?: string; auth?: string | null; payload?: unknown; url?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (init.auth !== null) headers.Authorization = init.auth ?? 'Bearer fixture';
    if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
    headers['Content-Type'] = init.type ?? 'application/json';
    const method = init.method ?? 'POST';
    return handler(new Request(init.url ?? URL_SYNC, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(init.payload ?? body) }) }));
  };
  return { fetcher, call };
}

describe('GitHub BFF: export/sync allow-list (wave 2 glue)', () => {
  it('forwards a valid sync to POST /api/cloud-github/export/sync with bearer + bridge headers and returns the typed success', async () => {
    const { fetcher, call } = bff(() => Response.json(success));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual(success);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://hono.test/api/cloud-github/export/sync');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fixture');
    expect(headers['X-LOV-GitHub-Bridge']).toBe(bridgeSecret);
    expect(JSON.parse(String(init!.body))).toEqual(body);
  });

  it('passes remote_changed (409) through with its changed paths', async () => {
    const failure = { ok: false, error: 'remote_changed', changedPaths: ['src/App.tsx'], checkpointSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40) };
    const { call } = bff(() => Response.json(failure, { status: 409 }));
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(failure);
  });

  it('keeps typed sync errors (401 github_reauth_required, 403 private_repo_not_allowed) and hides unknown upstream bodies', async () => {
    for (const [status, error] of [[401, 'github_reauth_required'], [403, 'private_repo_not_allowed']] as const) {
      const res = await bff(() => Response.json({ ok: false, error }, { status })).call();
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    const leaky = await bff(() => Response.json({ error: 'internal detail ghp_should_not_pass' }, { status: 500 })).call();
    expect(leaky.status).toBe(502);
    expect(await leaky.json()).toEqual({ error: 'github_connection_failed' });
  });

  it('applies the same origin, JSON, bearer and body rules as export and never reaches upstream on rejection', async () => {
    const { fetcher, call } = bff(() => Response.json(success));
    expect((await call({ origin: 'https://attacker.test' })).status).toBe(403);
    expect((await call({ origin: null })).status).toBe(403);
    expect((await call({ type: 'text/plain' })).status).toBe(415);
    expect((await call({ auth: null })).status).toBe(401);
    expect((await call({ payload: { ...body, confirmed: false } })).status).toBe(400);
    expect((await call({ payload: { ...body, selection: undefined } })).status).toBe(400);
    expect((await call({ payload: { ...body, token: 'x' } })).status).toBe(400);
    expect((await call({ method: 'GET' })).status).toBe(404);
    expect((await call({ url: URL_SYNC + 'x' })).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await bff(() => Response.json(success), false).call()).status).toBe(401);
  });
});
