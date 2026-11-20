// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { Hono } from 'hono';
import { applyMigrations } from '../../../server/db/migrate';
import { dbFromPool, type DbLike } from '../../../server/db/pool';
import { makeAuthMiddleware } from '../../../server/auth/middleware';
import { makeCloudAuth } from '../../../server/auth/cloud';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { githubCloud } from '../../../server/integrations/githubCloud';
import { githubCloudRouter, GITHUB_BRIDGE_HEADER, isCloudGitHubRoute } from '../../../server/routes/githubCloud';
import {
  forgeBranchName,
  forgeBranchSlug,
  githubConnectionExpired,
  syncToForgeBranch,
} from '../../../server/integrations/gitEngine';
import { githubCompare } from '../../../server/integrations/githubApi';
import { redactSecrets } from '../../../server/security/secrets';
import { gitBlobSha } from '../../../server/integrations/githubCheckpoint';
import { syncProjectToGitHub } from '../../../src/services/export/githubSync';

const files = [{ path: 'src/main.tsx', content: 'export const name = "Ľúbosť";' }];
const parent = 'a'.repeat(40);
const tree = 'c'.repeat(40);
const commit = 'd'.repeat(40);
const remote = 'e'.repeat(40);
const token = 'ghp_' + 'A'.repeat(36);
const user = { id: 42, login: 'fixture-user' };
const slugSeed = 'Ľúbosť Café';
const branch = forgeBranchName(slugSeed);

type Mode = 'ok' | 'private' | 'missing' | 'changed' | 'unauthorized' | 'existing-pr' | 'identity';

function fixture(mode: Mode = 'ok') {
  let forgeSha: string | null = mode === 'changed' || mode === 'existing-pr' ? remote : null;
  let defaultSha = parent;
  let pull = mode === 'existing-pr'
    ? { number: 7, html_url: 'https://github.com/fixture-user/export/pull/7', head: { ref: branch }, base: { ref: 'main' }, state: 'open' }
    : null;
  const writes: string[] = [];
  const api = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (path === '/user' && method === 'GET') {
      if (mode === 'unauthorized') return json({ message: 'Bad credentials' }, 401);
      return json(mode === 'identity' ? { id: 7, login: 'other' } : user);
    }
    if (path === '/repos/fixture-user/export' && method === 'GET') {
      if (mode === 'missing') return json({ message: 'Not Found' }, 404);
      return json({
        id: 99,
        full_name: 'fixture-user/export',
        private: mode === 'private',
        default_branch: 'main',
        owner: user,
      });
    }
    if (path.endsWith('/git/ref/heads/main') && method === 'GET')
      return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: defaultSha } });
    if (path.endsWith('/git/ref/heads/' + branch) && method === 'GET')
      return forgeSha
        ? json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha: forgeSha } })
        : json({ message: 'Not Found' }, 404);
    if (path.includes('/compare/') && method === 'GET') {
      return json({
        status: 'diverged',
        base_commit: { sha: remote },
        merge_base_commit: { sha: parent },
        files: [{ filename: 'src/foreign.ts', status: 'modified' }, { filename: 'README.md', status: 'added' }],
      });
    }
    if (path.endsWith('/git/commits/' + parent) && method === 'GET')
      return json({ sha: parent, tree: { sha: 'b'.repeat(40) }, parents: [] });
    if (path.endsWith('/git/commits/' + remote) && method === 'GET')
      return json({ sha: remote, tree: { sha: 'b'.repeat(40) }, parents: [{ sha: parent }] });
    if (path.endsWith('/git/trees') && method === 'POST') { writes.push('tree'); return json({ sha: tree }, 201); }
    if (path.endsWith('/git/commits') && method === 'POST') {
      writes.push('commit');
      const body = JSON.parse(String(init?.body));
      expect(body.parents).toEqual([forgeSha ?? parent]);
      return json({ sha: commit }, 201);
    }
    if (path.endsWith('/git/commits/' + commit) && method === 'GET')
      return json({ sha: commit, tree: { sha: tree }, parents: [{ sha: forgeSha ?? parent }] });
    if (path.endsWith('/git/trees/' + tree) && method === 'GET')
      return json({
        sha: tree,
        truncated: false,
        tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: gitBlobSha(file.content) })),
      });
    if (path.endsWith('/git/refs') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      expect(body.ref).toBe('refs/heads/' + branch);
      expect(body.sha).toBe(commit);
      writes.push('create-ref:' + body.ref);
      forgeSha = commit;
      return json({ object: { sha: commit } }, 201);
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      writes.push('patch-main');
      defaultSha = JSON.parse(String(init?.body)).sha;
      return json({ object: { sha: defaultSha } });
    }
    if (path.endsWith('/git/refs/heads/' + branch) && method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ sha: commit, force: false });
      writes.push('patch-forge');
      forgeSha = commit;
      return json({ object: { sha: commit } });
    }
    if (path.endsWith('/pulls') && method === 'GET') {
      return json(pull ? [pull] : []);
    }
    if (path.endsWith('/pulls') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      expect(body.head).toBe(branch);
      expect(body.base).toBe('main');
      writes.push('create-pr');
      pull = { number: 11, html_url: 'https://github.com/fixture-user/export/pull/11', head: { ref: branch }, base: { ref: 'main' }, state: 'open' };
      return json(pull, 201);
    }
    if (path.endsWith('/pulls/7') && method === 'PATCH') {
      writes.push('update-pr');
      return json({ number: 7, html_url: 'https://github.com/fixture-user/export/pull/7' });
    }
    throw new Error('unexpected_sync_request:' + method + ' ' + path);
  });
  const input = {
    token,
    githubId: 42,
    username: 'fixture-user',
    repoName: 'export',
    files,
    slugSeed,
    assertAuthorized: vi.fn(async () => undefined),
    fetch: api,
  };
  return { api, input, writes };
}

describe('GitHub sync engine (agent-3)', () => {
  it('builds a deterministic git-ref-safe slug from diacritics', () => {
    expect(forgeBranchSlug('Ľúbosť Café!!!')).toBe('lubost-cafe');
    expect(forgeBranchName('Ľúbosť Café')).toBe('forge/lubost-cafe');
  });

  it('truncates long names and keeps a valid git ref component', () => {
    const slug = forgeBranchSlug('A'.repeat(200) + ' ../.git @{oops} .lock');
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/\.\.|@| /);
    expect(slug.startsWith('.')).toBe(false);
    expect(slug.endsWith('.lock')).toBe(false);
    expect(forgeBranchName(slug).startsWith('forge/')).toBe(true);
  });

  it('does not use reserved git names as the forge slug', () => {
    expect(forgeBranchSlug('main')).toBe('main-project');
    expect(forgeBranchSlug('master')).toBe('master-project');
    expect(forgeBranchName('main')).not.toBe('forge/main');
  });

  it('stops with remote_changed and changed paths without writing anything', async () => {
    const { api, input, writes } = fixture('changed');
    const result = await syncToForgeBranch({ ...input, checkpointSha: parent });
    expect(result).toEqual({
      ok: false,
      error: 'remote_changed',
      checkpointSha: parent,
      remoteSha: remote,
      changedPaths: ['src/foreign.ts', 'README.md'],
    });
    expect(writes).toEqual([]);
    expect(api.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('creates forge/<slug>, opens a PR into main, and never patches the default branch', async () => {
    const { api, input, writes } = fixture('ok');
    const result = await syncToForgeBranch(input);
    expect(result).toMatchObject({
      ok: true,
      branch,
      commitSha: commit,
      pullNumber: 11,
      createdPull: true,
      repoFullName: 'fixture-user/export',
    });
    expect(writes).toEqual(['tree', 'commit', 'create-ref:refs/heads/' + branch, 'create-pr']);
    expect(writes.some(entry => entry.includes('main'))).toBe(false);
    expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init).includes('main'))).toBe(false);
    const patched = api.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'PATCH');
    expect(patched.every(([url]) => !String(url).includes('/heads/main'))).toBe(true);
  });

  it('updates an existing open PR and the forge branch when the checkpoint matches', async () => {
    const { input, writes } = fixture('existing-pr');
    const result = await syncToForgeBranch({ ...input, checkpointSha: remote });
    expect(result).toMatchObject({ ok: true, pullNumber: 7, createdPull: false, commitSha: commit, branch });
    expect(writes).toEqual(['tree', 'commit', 'patch-forge', 'update-pr']);
    expect(writes).not.toContain('patch-main');
    expect(writes).not.toContain('create-pr');
  });

  it('returns private_repo_not_allowed for a private target and does not write', async () => {
    const { api, input, writes } = fixture('private');
    expect(await syncToForgeBranch(input)).toEqual({ ok: false, error: 'private_repo_not_allowed' });
    expect(writes).toEqual([]);
    expect(api.mock.calls.some(([, init]) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(init?.method ?? 'GET'))).toBe(false);
  });

  it('returns github_reauth_required when the stored connection has expired', async () => {
    const { api, input } = fixture('ok');
    const result = await syncToForgeBranch({ ...input, tokenExpired: true });
    expect(result).toEqual({ ok: false, error: 'github_reauth_required' });
    expect(api).not.toHaveBeenCalled();
  });

  it('returns github_reauth_required when GitHub rejects the token with 401', async () => {
    const { input } = fixture('unauthorized');
    expect(await syncToForgeBranch(input)).toEqual({ ok: false, error: 'github_reauth_required' });
  });

  it('never returns or logs the token, and redactSecrets covers GitHub PATs', () => {
    const raw = 'Authorization: Bearer ' + token + ' dumped ' + token;
    expect(redactSecrets(raw)).not.toContain(token);
    expect(redactSecrets(raw)).toContain('[REDACTED]');
  });

  it('githubCompare lists changed paths from a mocked compare payload', async () => {
    const { input } = fixture('changed');
    const api = (await import('../../../server/integrations/githubApi')).githubApi(input, AbortSignal.timeout(5_000));
    const comparison = await githubCompare(api, 'fixture-user', 'export', parent, remote);
    expect(comparison?.changedPaths).toEqual(['src/foreign.ts', 'README.md']);
  });
});

const issuer = 'https://github-sync.supabase.co/auth/v1';
const jwtSecret = 'github-sync-route-test-cookie-secret-0123456789';
const bridgeSecret = 'ab'.repeat(32);
const nonce = 'cd'.repeat(32);
const pair = await generateKeyPair('ES256');
const jwk = await exportJWK(pair.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'sync-test', alg: 'ES256' }] });

describe('GitHub sync Cloud route and token expiry', () => {
  let db: DbLike;
  let alice: string;
  let service: ReturnType<typeof githubCloud>;
  let app: Hono;

  beforeEach(async () => {
    const pool = new (newDb().adapters.createPg().Pool)();
    db = dbFromPool(pool);
    await applyMigrations(db);
    await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', ['alice', 'alice@example.com', 'unused']);
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'alice', 'alice']);
    const filesJson = JSON.stringify([{ name: files[0].path, content: files[0].content }]);
    await db.query(
      'INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)',
      ['alice', 'project-one', slugSeed, JSON.stringify({
        title: slugSeed, isPublic: false, liveId: 'snap-one', files: [{ name: files[0].path, content: files[0].content }],
        snapshots: [{ id: 'snap-one', v: 1, prompt: 's', kind: 'manual', time: 't', html: '<main/>', sourceFiles: filesJson }],
      })],
    );
    alice = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'sync-test' })
      .setIssuer(issuer).setAudience('authenticated').setSubject('alice')
      .setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  });

  it('detects an expired stored connection without a new table', async () => {
    const connectApi = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: token, token_type: 'bearer', scope: 'public_repo', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ login: 'fixture-user', id: 42 }));
    service = githubCloud(db, {
      clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ef'.repeat(32),
      callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: connectApi,
    });
    const started = await service.start('alice', nonce);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    expect((await service.finish('alice', state, nonce, 'code')).ok).toBe(true);
    expect(await githubConnectionExpired(db, 'alice')).toBe(false);
    await db.query("UPDATE github_pending SET connection_expires_at = now() - interval '1 hour' WHERE owner_id=$1", ['alice']);
    expect(await githubConnectionExpired(db, 'alice')).toBe(true);
    expect(await service.exportAccess('alice')).toBeNull();
  });

  it('route: expired token returns github_reauth_required; sync success never echoes the token', async () => {
    const connectThenSync = (() => {
      let oauth = 0;
      const sync = fixture('ok').api;
      return vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (oauth === 0 && path.includes('/login/oauth/access_token')) {
          oauth++;
          return Response.json({ access_token: token, token_type: 'bearer', scope: 'public_repo', expires_in: 3600 });
        }
        if (oauth === 1 && path === '/user') {
          oauth++;
          return Response.json({ login: 'fixture-user', id: 42 });
        }
        return sync(url, init);
      });
    })();
    service = githubCloud(db, {
      clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ef'.repeat(32),
      callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: connectThenSync,
    });
    app = new Hono();
    app.use('/api/*', makeAuthMiddleware(jwtSecret, makeCloudAuth(db, issuer, keys), isCloudGitHubRoute));
    app.route('/', githubCloudRouter({ service, bridgeSecret, db, fetch: connectThenSync }, () => true));
    const headers = { Authorization: 'Bearer ' + alice, [GITHUB_BRIDGE_HEADER]: bridgeSecret, 'Content-Type': 'application/json' };
    const start = await app.request('/api/cloud-github/start', { method: 'POST', headers, body: JSON.stringify({ browserNonce: nonce }) });
    const state = new URL((await start.json()).authorizationUrl).searchParams.get('state')!;
    expect((await app.request('/api/cloud-github/finish', { method: 'POST', headers, body: JSON.stringify({ browserNonce: nonce, state, code: 'fixture-code' }) })).status).toBe(200);

    const body = {
      repoName: 'export',
      slugSeed,
      confirmed: true as const,
      selection: { projectId: 'project-one', snapshotId: 'snap-one', expectedRevision: 1 },
    };
    const synced = await app.request('/api/cloud-github/export/sync', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(synced.status).toBe(200);
    const payload = await synced.json();
    expect(payload).toMatchObject({ ok: true, branch, createdPull: true, pullNumber: 11 });
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(synced.headers.get('cache-control')).toBe('no-store');

    await db.query("UPDATE github_pending SET connection_expires_at = now() - interval '1 hour' WHERE owner_id=$1", ['alice']);
    const expired = await app.request('/api/cloud-github/export/sync', { method: 'POST', headers, body: JSON.stringify(body) });
    expect(expired.status).toBe(401);
    const expiredBody = await expired.json();
    expect(expiredBody).toEqual({ error: 'github_reauth_required' });
    expect(JSON.stringify(expiredBody)).not.toContain(token);
  });

  it('route requires Cloud auth and does not run sync anonymously', async () => {
    service = githubCloud(db, {
      clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ef'.repeat(32),
      callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: vi.fn(),
    });
    app = new Hono();
    app.use('/api/*', makeAuthMiddleware(jwtSecret, makeCloudAuth(db, issuer, keys), isCloudGitHubRoute));
    app.route('/', githubCloudRouter({ service, bridgeSecret, db }, () => true));
    const res = await app.request('/api/cloud-github/export/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName: 'export', slugSeed, confirmed: true, selection: { projectId: 'project-one', snapshotId: 'snap-one', expectedRevision: 1 } }),
    });
    expect(res.status).toBe(401);
  });

  it('client helper maps a remote_changed JSON body without exposing tokens', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: false,
        error: 'remote_changed',
        changedPaths: ['src/foreign.ts'],
        checkpointSha: parent,
        remoteSha: remote,
      }, { status: 409 }),
    );
    const result = await syncProjectToGitHub(
      { repoName: 'export', slugSeed, confirmed: true, selection: { projectId: 'project-one', snapshotId: 'snap-one', expectedRevision: 1 }, checkpointSha: parent },
      { fetch: fetchImpl, headers: { Authorization: 'Bearer client-token' } },
    );
    expect(result).toEqual({
      ok: false,
      error: 'remote_changed',
      changedPaths: ['src/foreign.ts'],
      checkpointSha: parent,
      remoteSha: remote,
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

