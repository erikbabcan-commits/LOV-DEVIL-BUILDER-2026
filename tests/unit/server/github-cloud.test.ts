// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../../../server/db/migrate';
import { githubCloud } from '../../../server/integrations/githubCloud';
import type { DbLike } from '../../../server/db/pool';

const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', encryptionKey: 'ab'.repeat(32) };
describe('Cloud GitHub connection service', () => {
  let db: DbLike;
  const nonce = 'cd'.repeat(32);
  beforeEach(async () => {
    const pool = new (newDb().adapters.createPg().Pool)();
    db = { query: async (sql, params) => { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } };
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@test.invalid', 'unused']);
  });
  function fixture(scope = 'public_repo') {
    const api = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'server-only-fixture-token', token_type: 'bearer', scope }))
      .mockResolvedValueOnce(Response.json({ login: 'fixture-user', id: 42 }));
    return { api, service: githubCloud(db, { ...config, fetch: api }) };
  }
  async function begin(service: ReturnType<typeof githubCloud>) {
    const url = new URL((await service.start('alice', nonce)).authorizationUrl);
    return { state: url.searchParams.get('state')!, url };
  }
  it('completes S256 flow, encrypts credentials and returns only public metadata after recreation', async () => {
    const { api, service } = fixture(); const { state, url } = await begin(service);
    expect(url.searchParams.get('scope')).toBe('public_repo');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(await service.finish('alice', state, nonce, 'fixture-code')).toEqual({ ok: true });
    const exchanged = JSON.parse(String(api.mock.calls[0][1]?.body));
    expect(createHash('sha256').update(exchanged.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(exchanged.redirect_uri).toBe(config.callbackUrl);
    const rows = JSON.stringify((await db.query('SELECT * FROM github_pending')).rows);
    for (const secret of ['server-only-fixture-token', exchanged.code_verifier, config.clientSecret, nonce, state]) expect(rows).not.toContain(secret);
    const restarted = githubCloud(db, config);
    expect(await restarted.status('alice')).toEqual({ connected: true, username: 'fixture-user', githubId: 42, scopes: ['public_repo'] });
    expect(await restarted.status('bob')).toEqual({ connected: false });
    expect(await service.finish('alice', state, nonce, 'replay')).toEqual({ ok: false, error: 'invalid_flow' });
    expect(api).toHaveBeenCalledTimes(2);
    await restarted.disconnect('alice');
    expect(await restarted.status('alice')).toEqual({ connected: false });
  });
  it('rejects wrong owner/nonce before network and does not infer permission from request', async () => {
    const { api, service } = fixture('read:user'); const { state } = await begin(service);
    expect((await service.finish('bob', state, nonce, 'code')).ok).toBe(false);
    expect((await service.finish('alice', state, 'ef'.repeat(32), 'code')).ok).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(await service.finish('alice', state, nonce, 'code')).toEqual({ ok: false, error: 'github_permission_missing' });
    expect(await service.status('alice')).toEqual({ connected: false });
  });
  it.each(['restart', 'disconnect'])('does not resurrect an old in-flight connection after %s', async action => {
    let release!: (response: Response) => void;
    const api = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(Response.json({ login: 'fixture-user', id: 42 }));
    const service = githubCloud(db, { ...config, fetch: api }); const { state } = await begin(service);
    const finishing = service.finish('alice', state, nonce, 'code');
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    if (action === 'restart') await begin(service); else await service.disconnect('alice');
    release(Response.json({ access_token: 'server-only-fixture-token', token_type: 'bearer', scope: 'public_repo' }));
    expect(await finishing).toEqual({ ok: false, error: 'superseded' });
    expect(await service.status('alice')).toEqual({ connected: false });
  });
  it('fails closed for ciphertext tampering and wrong configuration', async () => {
    const { service } = fixture(); const { state } = await begin(service);
    expect((await service.finish('alice', state, nonce, 'code')).ok).toBe(true);
    await db.query('UPDATE github_pending SET connection_cipher=$1 WHERE owner_id=$2', ['corrupt', 'alice']);
    await expect(service.status('alice')).rejects.toThrow();
    expect(() => githubCloud(db, { ...config, callbackUrl: 'https://attacker.test/github/callback' })).toThrow();
    expect(() => githubCloud(db, { ...config, encryptionKey: 'short' })).toThrow();
  });
  it('consumes failed exchanges and never exposes provider errors or retries a code', async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'provider-secret-error' }, { status: 400 }));
    const service = githubCloud(db, { ...config, fetch: api }); const { state } = await begin(service);
    expect(await service.finish('alice', state, nonce, 'code')).toEqual({ ok: false, error: 'github_unavailable' });
    expect(await service.finish('alice', state, nonce, 'code')).toEqual({ ok: false, error: 'invalid_flow' });
    expect(api).toHaveBeenCalledOnce();
  });
  it('rejects oversized provider responses and does not create a connection', async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'x'.repeat(17000) }));
    const service = githubCloud(db, { ...config, fetch: api }); const { state } = await begin(service);
    expect(await service.finish('alice', state, nonce, 'code')).toEqual({ ok: false, error: 'github_unavailable' });
    expect(await service.status('alice')).toEqual({ connected: false });
  });
  it('honors cancellation before network and does not replay the consumed code', async () => {
    const { service, api } = fixture(); const { state } = await begin(service);
    expect((await service.finish('alice', state, nonce, 'code', AbortSignal.abort())).ok).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(await service.finish('alice', state, nonce, 'code')).toEqual({ ok: false, error: 'invalid_flow' });
  });
});
