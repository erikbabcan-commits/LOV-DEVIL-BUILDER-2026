// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { applyMigrations, listMigrations } from '../../server/db/migrate';
import { makeCloudAuth } from '../../server/auth/cloud';
import { makeHonoProxy } from '../../server/integrations/honoProxy';
import { createApp, makeMockProvider } from '../../server/index';
import { InMemoryQuotaStore, PostgresQuotaStore, monthWindow } from '../../server/security/quotaStore';
import { linkCloudIdentity } from '../../server/auth/linkIdentity';
import { githubPending } from '../../server/integrations/githubPending';
import { githubCloud } from '../../server/integrations/githubCloud';
import { makeGitHubBff } from '../../server/integrations/githubBff';
import { loadGitHubSnapshot } from '../../server/integrations/githubSnapshot';
import { githubExporter } from '../../server/integrations/githubExporter';
import { writeGitHubRepository } from '../../server/integrations/githubWriter';
import { verifyGitHubExport } from '../../server/integrations/githubRecovery';
import { githubExportProvider } from '../helpers/githubExportProvider';
import { makeCloudGitHubWiring, readCloudGitHubConfig } from '../../server/integrations/githubRuntime';
import { probeCloudGitHubSchema } from '../../server/integrations/githubSchema';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { DbLike } from '../../server/db/pool';
import { dbFromPool } from '../../server/db/pool';
import { productReportWindow, weeklyProductReport } from '../../server/usage/productReport';
import {hybridAiBackend} from '../fixtures/hybridAiBackend';
import {ForgeController} from '../../deploy/lovable-github/src/lib/forge-controller';
import type {ForgeTransport} from '../../deploy/lovable-github/src/lib/forge-agent';
import type {DraftStorage,Draft} from '../../deploy/lovable-github/src/lib/forge-drafts';

describe.skipIf(process.env.PROJECTS_PG_E2E !== '1')('Cloud proxy with dedicated PostgreSQL', () => {
  let pool: Pool, admin: Pool, schema: string, db: DbLike;
  const issuer = 'https://pg-cloud-test.supabase.co/auth/v1';
  beforeEach(async () => {
    const connectionString = process.env.PROJECTS_TEST_DATABASE_URL;
    if (!connectionString || !['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname)) throw new Error('Dedicated loopback PostgreSQL required');
    schema = 'lov_cloud_' + randomUUID().replaceAll('-', '');
    admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = new Pool({ connectionString, options: '-c search_path=' + schema, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    db = dbFromPool(pool);
    await applyMigrations(db); await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@example.com', 'unused-test-hash']);
  });
  afterEach(async () => {
    if (pool) await pool.end();
    if (admin) { try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await admin.end(); } }
  });
  const runtimeEnvironment = (databaseUrl: string) => ({ AUTH_ENABLED: '1', DATABASE_URL: databaseUrl, JWT_SECRET: 'synthetic-runtime-jwt-secret-01234567890123456789', CLOUD_AUTH_ISSUER: issuer,
    GITHUB_CLOUD_ENABLED: '1', GITHUB_CLOUD_EXPORT_ENABLED: '1', GITHUB_CLOUD_CLIENT_ID: 'fixture-client', GITHUB_CLOUD_CLIENT_SECRET: 'synthetic-client-secret',
    GITHUB_CLOUD_ALLOWED_ORIGIN: 'https://lovable.test', GITHUB_CLOUD_CALLBACK_URL: 'https://lovable.test/github/callback', GITHUB_CLOUD_ENCRYPTION_KEY: 'ab'.repeat(32), GITHUB_BRIDGE_SECRET: 'ef'.repeat(32) });
  const localDrafts=():DraftStorage=>{const owners=new Map<string,Draft>();return{read:async owner=>structuredClone(owners.get(owner)??null),write:async(owner,draft)=>{owners.set(owner,structuredClone(draft));}};};
  function hybridTransport(proxy:(request:Request)=>Promise<Response>,token:string):ForgeTransport{return(path,init)=>proxy(new Request('https://lovable.test/api/hono/'+path,{method:init?.method??'GET',headers:{Origin:'https://lovable.test',Authorization:'Bearer '+token,'Content-Type':'application/json'},...(init?.body===undefined?{}:{body:JSON.stringify(init.body)}),...(init?.signal?{signal:init.signal}:{})}));}
  it('records, retries and cancels closure requests without changing the account or other tenants', async () => {
    const backend = await hybridAiBackend(db, true);
    const alice = hybridTransport(backend.proxy, backend.tokens.alice);
    const bob = hybridTransport(backend.proxy, backend.tokens.bob);
    const endpoint = 'account/closure';
    const post = (transport: ForgeTransport, path: string, body: object) => transport(path, { method: 'POST', body });
    const firstId = randomUUID(), secondId = randomUUID();
    expect((await post(alice, endpoint, { requestId: firstId })).status).toBe(400);
    expect((await post(alice, endpoint, { requestId: firstId, confirmed: true, owner: 'bob' })).status).toBe(400);
    expect((await post(alice, endpoint, { requestId: firstId, confirmed: true, extra: 'a'.repeat(512) })).status).toBe(413);
    const [created, retry] = await Promise.all([1, 2].map(async () =>
      (await post(alice, endpoint, { requestId: firstId, confirmed: true })).json(),
    ));
    expect(created).toMatchObject({ accountId: 'alice', state: 'pending', requestId: firstId });
    expect(retry).toEqual(created);
    expect(Date.parse(created.eligibleAt) - Date.parse(created.requestedAt)).toBe(30 * 86_400_000);
    expect(await (await post(bob, endpoint + '/cancel', { requestId: firstId })).json())
      .toEqual({ accountId: 'bob', state: 'none' });
    expect(await (await alice(endpoint)).json()).toEqual(created);
    expect(await (await post(alice, endpoint + '/cancel', { requestId: firstId })).json())
      .toEqual({ accountId: 'alice', state: 'none' });
    expect(await (await post(alice, endpoint, { requestId: firstId, confirmed: true })).json())
      .toEqual({ accountId: 'alice', state: 'none' });
    const next = await (await post(alice, endpoint, { requestId: secondId, confirmed: true })).json();
    expect(await (await post(alice, endpoint + '/cancel', { requestId: firstId })).json()).toEqual(next);
    const exportData = await (await alice('account/export/closure')).json();
    expect(exportData.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: firstId, cancelled_at: expect.any(String) }),
      expect.objectContaining({ request_id: secondId, cancelled_at: null }),
    ]));
    expect((await alice('projects/hybrid-fixture')).status).toBe(200);
    expect((await alice('auth/me')).status).toBe(200);
    expect((await backend.app.request('/api/account/closure')).status).toBe(401);

    const url = new URL(process.env.PROJECTS_TEST_DATABASE_URL!);
    url.searchParams.set('options', '-c search_path=' + schema);
    const queue = () => {
      const output = spawnSync(process.execPath, [
        'node_modules/tsx/dist/cli.mjs', 'scripts/account-closure-queue.ts', '--limit', '1',
      ], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, DATABASE_URL: url.href } });
      expect(output.error).toBeUndefined();
      expect(output.status).toBe(0);
      expect(output.stdout).not.toContain(url.password);
      return JSON.parse(output.stdout);
    };
    expect(queue()).toEqual({ ok: true, hasMore: false, requests: [] });
    await db.query(`UPDATE account_closure_requests SET requested_at=now() - interval '31 days', eligible_at=now() - interval '1 day'
      WHERE user_id='alice' AND request_id=$1`, [secondId]);
    await db.query(`INSERT INTO billing_accounts (user_id, customer_key, created_at, has_open_subscription)
      VALUES ('alice', $1, now(), true)`, [randomUUID()]);
    const ready = queue();
    expect(ready).toMatchObject({ requests: [{
      user_id: 'alice', request_id: secondId, cloud_identity: true, open_subscription: true,
    }] });
    expect(queue()).toEqual(ready);
    expect((await alice('projects/hybrid-fixture')).status).toBe(200);
  }, 20000);
  it('exports only owner data through the signed Cloud bridge and includes trashed projects', async () => {
    const backend = await hybridAiBackend(db, true);
    const alice = hybridTransport(backend.proxy, backend.tokens.alice);
    const bob = hybridTransport(backend.proxy, backend.tokens.bob);
    await db.query(`INSERT INTO builder_projects (owner_id, project_id, title, revision, workspace, deleted_at)
      VALUES ('alice', 'trashed', 'Alice in trash', 2, '{"files":[]}', now()),
             ('bob', 'private-bob', 'Bob only', 1, '{"files":[]}', NULL)`);
    await db.query(`INSERT INTO auth_log (id, user_id, action) VALUES
      ('alice-audit', 'alice', 'login'), ('bob-audit', 'bob', 'logout'), ('unknown', NULL, 'login_failed')`);
    const run = '12345678-0000-4000-8000-000000000001';
    await db.query(`INSERT INTO ai_runs (user_id, id, kind, period_start, plan, started_at, call_count)
      VALUES ('alice', $1, 'generation', now(), 'free', now(), 1),
             ('bob', $1, 'generation', now(), 'free', now(), 1)`, [run]);
    await db.query(`INSERT INTO ai_calls (user_id, run_id, call_no, provider, requested_model, started_at)
      VALUES ('alice', $1, 1, 'mistral', 'alice-model', now()),
             ('bob', $1, 1, 'mistral', 'bob-model', now())`, [run]);
    await db.query(`INSERT INTO publish_jobs (owner_id, request_id, project_id, project_revision, snapshot_id,
      source_fingerprint, source_files, artifact_id, state, created_at, updated_at)
      VALUES ('alice', $1, 'hybrid-fixture', 1, 'hybrid-v1', 'fixture', '[{"path":"index.html","content":"Alice source"}]',
              '12345678-0000-4000-8000-000000000002', 'published', now(), now())`, [run]);
    await db.query(`INSERT INTO github_exports (owner_id, request_id, repo_name, github_username, selection,
      source_hash, fingerprint, connection_hash)
      VALUES ('alice', $1, 'alice-repo', 'alice-github', '{}', 'source', 'fingerprint', 'internal-connection-hash')`, [run]);
    await db.query(`INSERT INTO billing_accounts (user_id, customer_id, customer_key, created_at)
      VALUES ('alice', 'cus_alice', $1, now())`, [run]);
    await db.query(`INSERT INTO billing_events (event_id, user_id, event_type, processed_at)
      VALUES ('evt_alice', 'alice', 'invoice.paid', now()), ('evt_bob', 'bob', 'invoice.paid', now())`);
    const profile = await alice('account/export/profile');
    expect(profile.headers.get('Cache-Control')).toBe('no-store');
    const body = await profile.text();
    expect(JSON.parse(body)).toMatchObject({
      version: 1, accountId: 'alice', section: 'profile', nextCursor: null,
      records: [{ email: 'alice@example.com', identities: [{ subject: 'cloud-alice' }], billing: { customer_id: 'cus_alice' } }],
    });
    expect(body).not.toMatch(/unused-test-hash|bob@example.com|cloud-bob|customer_key/);
    const first = await (await alice('account/export/projects')).json();
    expect(first.records.map((row: { project_id: string }) => row.project_id)).toEqual(['hybrid-fixture']);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await (await alice('account/export/projects/' + first.nextCursor)).json();
    expect(second).toMatchObject({ nextCursor: null, records: [{ project_id: 'trashed', deleted_at: expect.any(String) }] });
    expect(await (await bob('account/export/projects/' + first.nextCursor)).json()).toMatchObject({
      accountId: 'bob', records: [{ project_id: 'private-bob' }],
    });
    expect(await (await alice('account/export/auth')).json()).toMatchObject({
      records: [{ id: 'alice-audit', action: 'login' }],
    });
    expect(await (await alice('account/export/ai')).json()).toMatchObject({
      records: [{ id: run, calls: [{ requested_model: 'alice-model' }] }],
    });
    expect(await (await alice('account/export/publish')).json()).toMatchObject({
      records: [{ request_id: run, source_files: [{ content: 'Alice source' }] }],
    });
    const github = await (await alice('account/export/github')).text();
    expect(JSON.parse(github)).toMatchObject({ records: [{ repo_name: 'alice-repo' }] });
    expect(github).not.toContain('internal-connection-hash');
    expect(await (await alice('account/export/billing')).json()).toMatchObject({
      records: [{ event_id: 'evt_alice', event_type: 'invoice.paid' }],
    });
    expect((await alice('account/export/ai/YWJj')).status).toBe(400);
    expect((await alice('account/export/profile?owner=bob')).status).toBe(404);
    expect((await alice('account/export/profile', { method: 'POST' })).status).toBe(404);
    expect((await backend.app.request('/api/account/export/profile')).status).toBe(401);
  });
  it('runs the portable Lovable controller through signed Cloud/proxy/PG, read-only streaming, exact review, compile and save/reopen',async()=>{
    const backend=await hybridAiBackend(db,true),transport=hybridTransport(backend.proxy,backend.tokens.alice),controller=new ForgeController('cloud-alice',transport,localDrafts());await controller.start();await controller.open('hybrid-fixture');const original=structuredClone(controller.get().workspace);
    await controller.generate('Prečo má tento projekt dve tlačidlá? Iba vysvetli.');expect(controller.get().pending).toBeNull();expect(controller.get().workspace.files).toEqual(original.files);expect(controller.get().workspace.conversation?.at(-1)?.content).toBe('Toto je lokálna testovacia odpoveď k projektu. Súbory sa nemenili.');
    await controller.generate('Zmeň iba farbu hlavného tlačidla na červenú.');expect(controller.get().pending?.files).toHaveLength(1);expect(controller.get().workspace.files).toEqual(original.files);controller.approve();expect(controller.get().workspace.snapshots[0]).toEqual(original.snapshots[0]);expect(controller.get().workspace.snapshots).toHaveLength(2);await controller.compile();expect(controller.get().preview).toContain('#dc2626');await controller.save();expect(controller.get()).toMatchObject({revision:2,dirty:false});
    const reopened=new ForgeController('cloud-alice',transport,localDrafts());await reopened.start();await reopened.open('hybrid-fixture');expect(reopened.get().workspace.files).toEqual(controller.get().workspace.files);expect(reopened.get().workspace.snapshots[0]).toEqual(original.snapshots[0]);expect(reopened.get().workspace.conversation?.length).toBe(4);expect(await backend.quota.usage('alice')).toMatchObject({used:2});expect(await backend.usage.report('alice')).toMatchObject({calls:5,reportedCalls:5});expect((await db.query('SELECT user_id,status FROM ai_runs ORDER BY started_at')).rows).toEqual([{user_id:'alice',status:'succeeded'},{user_id:'alice',status:'succeeded'}]);controller.dispose();reopened.dispose();
  });
  it('preserves a conflicting Lovable draft, saves a separate copy and denies Bob/revoked Cloud access',async()=>{
    const backend=await hybridAiBackend(db,true),transport=hybridTransport(backend.proxy,backend.tokens.alice),a=new ForgeController('cloud-alice',transport,localDrafts()),b=new ForgeController('cloud-alice',transport,localDrafts());await a.start();await b.start();await a.open('hybrid-fixture');await b.open('hybrid-fixture');a.rename('First tab');await a.save();b.rename('Second tab local');await b.save();expect(b.get()).toMatchObject({revision:1,dirty:true});expect(b.get().error).toContain('novšie');await b.save(true);expect(b.get()).toMatchObject({revision:1,dirty:false});expect(b.get().id).not.toBe('hybrid-fixture');
    const bob=new ForgeController('cloud-bob',hybridTransport(backend.proxy,backend.tokens.bob),localDrafts());await bob.start();await bob.listProjects();expect(bob.get().projects).toEqual([]);await bob.open('hybrid-fixture');expect(bob.get().workspace.files).toEqual([]);await db.query('DELETE FROM identity_links WHERE user_id=$1',['alice']);await a.generate('Oprav aplikáciu');expect(a.get().pending).toBeNull();expect(await backend.quota.usage('alice')).toMatchObject({used:0});expect((await db.query('SELECT owner_id FROM builder_projects ORDER BY project_id')).rows.every(row=>row.owner_id==='alice')).toBe(true);a.dispose();b.dispose();bob.dispose();
  });
  it('stores a manual Lovable file version through signed Cloud/CAS without persisting editor drafts or charging AI',async()=>{
    const backend=await hybridAiBackend(db,true),transport=hybridTransport(backend.proxy,backend.tokens.alice),cache=localDrafts(),c=new ForgeController('cloud-alice',transport,cache);
    await c.start();await c.open('hybrid-fixture');const original=structuredClone(c.get().workspace);
    expect(c.beginEdit()).toBe(true);expect(c.editFiles(original.files.map(file=>file.name==='src/index.css'?{...file,content:file.content.replace('#2563eb','#16a34a')}:file))).toBe(true);
    await c.save();expect(c.get().revision).toBe(1);expect(c.get().workspace).toEqual(original);
    const resumed=new ForgeController('cloud-alice',transport,cache);await resumed.start();expect(resumed.get().editor?.files.find(file=>file.name==='src/index.css')?.content).toContain('#16a34a');
    expect(resumed.applyEdit()).toBe(true);await resumed.compile();expect(resumed.get().preview).toContain('#16a34a');await resumed.save();expect(resumed.get().revision).toBe(2);
    const reopened=new ForgeController('cloud-alice',transport,localDrafts());await reopened.start();await reopened.open('hybrid-fixture');expect(reopened.get().workspace.snapshots[0]).toEqual(original.snapshots[0]);expect(reopened.get().workspace.snapshots[1]).toMatchObject({kind:'edit',parentId:original.liveId});expect(reopened.get().workspace.files).toEqual(resumed.get().workspace.files);expect(reopened.get().editor).toBeNull();
    expect(await backend.quota.usage('alice')).toMatchObject({used:0});expect((await db.query('SELECT COUNT(*)::int AS n FROM ai_runs')).rows[0].n).toBe(0);c.dispose();resumed.dispose();reopened.dispose();
  });
  it('probes the real schema read-only and refuses missing reservation/status contracts', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const readonlyDb: DbLike = { query: async (sql, params) => { const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; } };
      expect(await probeCloudGitHubSchema(readonlyDb, true)).toEqual({ ready: true, issues: [] });
    } finally { await client.query('ROLLBACK'); client.release(); }
    await db.query('DROP INDEX github_exports_reserved_name');
    expect(await probeCloudGitHubSchema(db, true)).toEqual({ ready: false, issues: ['export_name_reservation'] });
    await db.query(listMigrations().find(m => m.name === '006_github_export_lifecycle.sql')!.sql);
    await db.query('ALTER TABLE github_exports DROP CONSTRAINT github_exports_status_check');
    expect(await probeCloudGitHubSchema(db, true)).toEqual({ ready: false, issues: ['export_status_constraint'] });
    expect(await probeCloudGitHubSchema(db, false)).toEqual({ ready: true, issues: [] });
  });
  it('runs the operator preflight without creating links, changing data or applying missing migrations', async () => {
    const database = new URL(process.env.PROJECTS_TEST_DATABASE_URL!);
    database.searchParams.set('options', '-c search_path=' + schema);
    const repo = resolve(import.meta.dirname, '../..');
    const run = () => {
      const result = spawnSync(process.execPath, [resolve(repo, 'node_modules/tsx/dist/cli.mjs'), resolve(repo, 'scripts/check-cloud-github.ts'), '--check-db'], { encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, NODE_ENV: 'test', MISTRAL_API_KEY: '', ...runtimeEnvironment(database.href) } });
      if (result.error) throw result.error;
      expect(result.stdout + result.stderr).not.toContain(database.password); expect(result.stdout + result.stderr).not.toContain('synthetic-client-secret');
      return { code: result.status, report: JSON.parse(result.stdout) };
    };
    expect(run()).toMatchObject({ code: 0, report: { ok: true, mode: 'oauth_and_export', database: { ready: true, issues: [] }, provider: 'not_called', identityBinding: 'operator_required' } });
    expect((await db.query('SELECT * FROM identity_links')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM github_pending')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM github_exports')).rows).toEqual([]);
    await db.query('DROP INDEX github_exports_reserved_name');
    expect(run()).toMatchObject({ code: 1, report: { ok: false, database: { ready: false, issues: ['export_name_reservation'] } } });
    expect((await db.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='github_exports_reserved_name'", [schema])).rows).toEqual([]);
  }, 15000);
  it('activates OAuth and export independently through the actual runtime factory and signed Cloud/BFF/PG flow', async () => {
    const pair = await generateKeyPair('ES256'), jwk = await exportJWK(pair.publicKey);
    const cloudAuth = makeCloudAuth(db, issuer, createLocalJWKSet({ keys: [{ ...jwk, kid: 'runtime-pg', alg: 'ES256' }] }));
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-alice', 'alice']);
    const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'runtime-pg' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const remote = githubExportProvider([{ path: 'index.html', content: '<main>Exact</main>' }], true);
    const transport = vi.fn<typeof fetch>((url, init) => new URL(String(url)).origin === 'https://github.com'
      ? Promise.resolve(Response.json({ access_token: 'synthetic-runtime-token', token_type: 'bearer', scope: 'public_repo' })) : remote.api(url, init));
    const environment = runtimeEnvironment(process.env.PROJECTS_TEST_DATABASE_URL!);
    const setup = (exportFlag: string) => {
      const config = readCloudGitHubConfig({ ...environment, GITHUB_CLOUD_EXPORT_ENABLED: exportFlag, GITHUB_OAUTH_SCOPE: 'repo' })!;
      const wiring = makeCloudGitHubWiring(db, config, transport)!;
      const app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: environment.JWT_SECRET, quota: new InMemoryQuotaStore(), cloudAuth, cloudGitHub: wiring } });
      const bff = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: config.callbackUrl, clientId: config.clientId, bridgeSecret: config.bridgeSecret,
        verifyToken: async value => !!(await cloudAuth.resolve(value)), fetch: async (url, init) => app.fetch(new Request(url, init)) });
      return (action: string, body?: unknown, cookie = '') => bff(new Request('https://lovable.test/api/github-connect/' + action, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, Origin: 'https://lovable.test', 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    };
    const oauthOnly = setup('0'), started = await oauthOnly('start', {}), authUrl = new URL((await started.json()).authorizationUrl);
    expect(authUrl.searchParams.get('scope')).toBe('public_repo');
    expect((await oauthOnly('finish', { state: authUrl.searchParams.get('state'), code: 'fixture-code' }, started.headers.get('Set-Cookie')!.split(';')[0])).status).toBe(200);
    const input = { requestId: randomUUID(), repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
    expect((await oauthOnly('export/prepare', input)).status).toBe(503);
    expect((await db.query('SELECT request_id FROM github_exports')).rows).toEqual([]);
    const enabled = setup('1'), review = await (await enabled('export/prepare', input)).json();
    expect(review.status).toBe('prepared');
    expect(await (await enabled('export/confirm', { requestId: input.requestId, fingerprint: review.fingerprint, publicConfirmed: true })).json()).toMatchObject({ status: 'failed' });
    const before = remote.api.mock.calls.length;
    expect(await (await enabled('export/reconcile', { requestId: input.requestId })).json()).toMatchObject({ status: 'succeeded', result: { ok: true } });
    expect(remote.api.mock.calls.slice(before).every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(remote.api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it('preserves a single binding under concurrent writes and rejects another subject for the same account', async () => {
    expect(await linkCloudIdentity(db, { issuer, subject: 'subject', userId: 'alice' })).toBe('would_link');
    expect((await db.query('SELECT user_id FROM identity_links')).rows).toHaveLength(0);
    const writes = await Promise.all(['alice', 'bob'].map(userId => linkCloudIdentity(db, { issuer, subject: 'subject', userId }, true)));
    expect(writes.sort()).toEqual(['conflict', 'created']);
    const winner = (await db.query('SELECT user_id FROM identity_links')).rows[0].user_id;
    expect(await linkCloudIdentity(db, { issuer, subject: 'subject', userId: winner }, true)).toBe('unchanged');
    await expect(db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'another-subject', winner])).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT user_id FROM identity_links')).rows).toEqual([{ user_id: winner }]);
  });
  it('enforces the user foreign key and removes bindings on account deletion', async () => {
    await expect(db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'unknown-subject', 'unknown'])).rejects.toMatchObject({ code: '23503' });
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'subject', 'alice']);
    await db.query('DELETE FROM users WHERE id=$1', ['alice']);
    expect((await db.query('SELECT user_id FROM identity_links')).rows).toEqual([]);
  });
  it('consumes GitHub state exactly once across concurrent database clients', async () => {
    const pending = githubPending(db), nonce = 'ab'.repeat(32);
    const state = await pending.start('alice', nonce);
    expect(await pending.consume('bob', state, nonce)).toBe(false);
    expect(await pending.consume('alice', state, 'cd'.repeat(32))).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, () => githubPending(db).consume('alice', state, nonce)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const old = await pending.start('alice', nonce), latest = await pending.start('alice', nonce);
    expect(await pending.consume('alice', old, nonce)).toBe(false);
    await db.query('UPDATE github_pending SET expires_at=$1 WHERE owner_id=$2', [new Date(0), 'alice']);
    expect(await pending.consume('alice', latest, nonce)).toBe(false);
    await db.query('DELETE FROM users WHERE id=$1', ['alice']);
    expect((await db.query('SELECT owner_id FROM github_pending')).rows).toHaveLength(0);
  });
  it.each(['restart', 'disconnect'])('does not store a late OAuth result after %s on real PostgreSQL', async action => {
    let release!: (value: Response) => void;
    const provider = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-user' }));
    const service = githubCloud(db, { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ab'.repeat(32),
      callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: provider });
    const nonce = 'cd'.repeat(32), state = new URL((await service.start('alice', nonce)).authorizationUrl).searchParams.get('state')!;
    const finishing = service.finish('alice', state, nonce, 'fixture-code');
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    if (action === 'restart') await service.start('alice', nonce); else await service.disconnect('alice');
    release(Response.json({ access_token: 'fixture-github-token', token_type: 'bearer', scope: 'public_repo' }));
    expect(await finishing).toEqual({ ok: false, error: 'superseded' });
    expect(await service.status('alice')).toEqual({ connected: false });
  });
  it('runs signed Cloud JWT → BFF → Hono → OAuth → PostgreSQL and survives service recreation', async () => {
    const pair = await generateKeyPair('ES256'), jwk = await exportJWK(pair.publicKey);
    const cloudAuth = makeCloudAuth(db, issuer, createLocalJWKSet({ keys: [{ ...jwk, kid: 'github-pg', alg: 'ES256' }] }));
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-alice', 'alice']);
    const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'github-pg' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'fixture-github-token', token_type: 'bearer', scope: 'public_repo' }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-user' }));
    const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ab'.repeat(32), callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: provider };
    const service = githubCloud(db, config), bridgeSecret = 'ef'.repeat(32);
    const writer = vi.fn<typeof writeGitHubRepository>().mockResolvedValue({ ok: true, repositoryId: 99, repoFullName: 'fixture-user/export', repoUrl: 'https://github.com/fixture-user/export', commitSha: 'a'.repeat(40), filesUploaded: 1 });
    const app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: 'github-pg-cookie-secret-01234567890123456789', quota: new InMemoryQuotaStore(), cloudAuth, cloudGitHub: { service, bridgeSecret, exporter: githubExporter(db, service, writer) } } });
    const bff = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: config.callbackUrl, clientId: config.clientId, bridgeSecret, basicAuth: 'pilot:synthetic-password',
      verifyToken: async value => !!(await cloudAuth.resolve(value)), fetch: async (url, init) => app.fetch(new Request(url, init)) });
    const call = (action: string, body?: unknown, cookie = '') => bff(new Request('https://lovable.test/api/github-connect/' + action, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://lovable.test', Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const started = await call('start', {}); expect(started.status).toBe(200);
    const cookie = started.headers.get('Set-Cookie')!.split(';')[0];
    const state = new URL((await started.json()).authorizationUrl).searchParams.get('state');
    const result = await call('finish', { state, code: 'fixture-code' }, cookie);
    expect(result.status).toBe(200); await result.text();
    expect(await githubCloud(db, config).status('alice')).toEqual({ connected: true, username: 'fixture-user', githubId: 42, scopes: ['public_repo'] });
    expect(JSON.stringify((await db.query('SELECT * FROM github_pending')).rows)).not.toContain('fixture-github-token');
    expect(await (await call('status')).json()).toMatchObject({ connected: true });
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'export-project', 'Export', 1, JSON.stringify(workspace)]);
    const requestId = randomUUID(), prepared = await call('export/prepare', { requestId, repoName: 'export', selection: { projectId: 'export-project', snapshotId: 's1', expectedRevision: 1 } });
    expect(prepared.status).toBe(200);
    const review = await prepared.json(); expect(review.files).toEqual([{ path: 'index.html', bytes: 18 }]);
    expect(await (await call('export/review', { requestId })).json()).toEqual(review);
    const cancelledId = randomUUID(), abandoned = await (await call('export/prepare', { requestId: cancelledId, repoName: 'abandoned', selection: { projectId: 'export-project', snapshotId: 's1', expectedRevision: 1 } })).json();
    expect(await (await call('export/cancel', { requestId: cancelledId, fingerprint: abandoned.fingerprint })).json()).toMatchObject({ status: 'cancelled' });
    expect(await (await call('export/confirm', { requestId: cancelledId, fingerprint: abandoned.fingerprint, publicConfirmed: true })).json()).toMatchObject({ status: 'cancelled' });
    const consent = { requestId, fingerprint: review.fingerprint, publicConfirmed: true };
    const published = await call('export/confirm', consent); expect(published.status).toBe(200);
    const completed = await published.json(); expect(completed).toMatchObject({ status: 'succeeded', result: { ok: true } });
    expect(await (await call('export/confirm', consent)).json()).toEqual(completed);
    expect(await (await call('export/status', { requestId })).json()).toEqual(completed);
    expect(writer).toHaveBeenCalledOnce();
    expect((await call('disconnect', {})).status).toBe(200);
    expect(await service.status('alice')).toEqual({ connected: false });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('exports the selected historical files, checks ownership/revision and rejects secrets from stored data', async () => {
    const snapshot = (id: string, v: number, content: string) => ({ id, v, prompt: 'test', kind: 'manual', time: 'now', html: '<main>preview</main>', sourceFiles: JSON.stringify([{ name: 'src/main.tsx', content }]) });
    const workspace = { title: 'Export test', isPublic: false, liveId: 's2', snapshots: [snapshot('s1', 1, 'export const version = 1;'), snapshot('s2', 2, 'export const version = 2;')], files: [{ name: 'src/main.tsx', content: 'uncommitted edits' }] };
    await db.query('INSERT INTO builder_projects (owner_id,project_id,title,revision,workspace) VALUES ($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', workspace.title, 2, JSON.stringify(workspace)]);
    const selected = { projectId: 'p1', snapshotId: 's1', expectedRevision: 2 };
    const result = await loadGitHubSnapshot(db, 'alice', selected);
    expect(result).toMatchObject({ ok: true, files: [{ path: 'src/main.tsx', content: 'export const version = 1;' }] });
    expect(await loadGitHubSnapshot(db, 'bob', selected)).toEqual({ ok: false, error: 'project_not_found' });
    expect(await loadGitHubSnapshot(db, 'alice', { ...selected, expectedRevision: 1 })).toEqual({ ok: false, error: 'project_conflict' });
    workspace.snapshots[0].sourceFiles = JSON.stringify([{ name: 'src/main.tsx', content: 'ghp_' + 'A'.repeat(36) }]);
    await db.query('UPDATE builder_projects SET workspace=$1::jsonb WHERE owner_id=$2 AND project_id=$3', [JSON.stringify(workspace), 'alice', 'p1']);
    expect(await loadGitHubSnapshot(db, 'alice', selected)).toEqual({ ok: false, error: 'invalid_sources' });
  });
  it('claims one export across eight concurrent confirmations and caches its verified result', async () => {
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: 'b'.repeat(64), username: 'fixture',
      run: async operation => operation({ token: 'fixture-token', githubId: 42, username: 'fixture', assertAuthorized: async () => undefined }) });
    let release!: () => void;
    const writer = vi.fn<typeof writeGitHubRepository>(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, repositoryId: 99, repoFullName: 'fixture/export', repoUrl: 'https://github.com/fixture/export', commitSha: 'a'.repeat(40), filesUploaded: 1 };
    });
    const service = githubExporter(db, { exportAccess }, writer);
    const input = { requestId: randomUUID(), repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
    const prepared = await service.prepare('alice', input);
    if (!('fingerprint' in prepared)) throw new Error('Expected export review');
    const consent = { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true };
    const submissions = Array.from({ length: 8 }, () => service.confirm('alice', consent));
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    expect(await service.cancel('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint })).toEqual({ error: 'export_already_started' });
    await db.query('UPDATE github_exports SET expires_at=$1 WHERE request_id=$2', [new Date(0), input.requestId]);
    expect(await service.status('alice', input.requestId)).toMatchObject({ status: 'running' });
    release(); await Promise.all(submissions);
    const completed = await service.status('alice', input.requestId);
    expect(completed).toMatchObject({ status: 'succeeded', result: { ok: true, commitSha: 'a'.repeat(40) } });
    expect(await service.confirm('alice', consent)).toEqual(completed);
    expect(writer).toHaveBeenCalledOnce();
    expect(await service.status('bob', input.requestId)).toEqual({ error: 'export_not_found' });
    expect(await service.prepare('alice', { ...input, requestId: randomUUID() })).toEqual({ error: 'export_request_conflict' });
    expect(JSON.stringify((await db.query('SELECT * FROM github_exports')).rows)).not.toContain('fixture-token');
  });
  it('keeps cancellation/expiry tombstones while concurrent clients reserve the released name once', async () => {
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: 'b'.repeat(64), username: 'fixture',
      run: async operation => operation({ token: 'fixture-token', githubId: 42, username: 'fixture', assertAuthorized: async () => undefined }) });
    const writer = vi.fn<typeof writeGitHubRepository>();
    const makeService = () => githubExporter(db, { exportAccess }, writer), service = makeService();
    const input = { requestId: randomUUID(), repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
    const prepared = await service.prepare('alice', input);
    if (!('fingerprint' in prepared)) throw new Error('Expected review');
    const consent = { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true };
    expect(await service.cancel('alice', consent)).toEqual({ error: 'invalid_export_request' });
    expect(await service.cancel('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint })).toMatchObject({ status: 'cancelled' });
    const attempts = await Promise.all(Array.from({ length: 8 }, () => makeService().prepare('alice', { ...input, requestId: randomUUID() })));
    expect(attempts.filter(value => 'status' in value && value.status === 'prepared')).toHaveLength(1);
    expect(await makeService().confirm('alice', consent)).toMatchObject({ status: 'cancelled' });
    const reserved = attempts.find(value => 'fingerprint' in value);
    if (!reserved || !('requestId' in reserved)) throw new Error('Expected new reservation');
    await db.query('UPDATE github_exports SET expires_at=$1 WHERE request_id=$2', [new Date(0), reserved.requestId]);
    expect(await makeService().status('alice', reserved.requestId)).toMatchObject({ status: 'expired' });
    expect(await makeService().confirm('alice', { requestId: reserved.requestId, fingerprint: reserved.fingerprint, publicConfirmed: true })).toMatchObject({ status: 'expired' });
    expect(await makeService().prepare('alice', { ...input, requestId: randomUUID() })).toMatchObject({ status: 'prepared' });
    expect(await makeService().prepare('alice', input)).toEqual({ error: 'export_not_prepared' });
    expect(await makeService().status('bob', input.requestId)).toEqual({ error: 'export_not_found' });
    expect(writer).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM github_exports')).rows.map(row => row.status).sort()).toEqual(['cancelled', 'expired', 'prepared']);
  });
  it('upgrades a populated v005 export ledger without releasing started or terminal reservations', async () => {
    // Explicitly exercise the upgrade, not only a fresh schema.
    const migrations = listMigrations();
    await db.query('DROP TABLE github_exports');
    await db.query(migrations.find(m => m.name === '005_github_exports.sql')!.sql);
    for (const status of ['prepared', 'running', 'succeeded', 'failed']) {
      await db.query(`INSERT INTO github_exports(owner_id,request_id,repo_name,github_username,selection,source_hash,fingerprint,connection_hash,status)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$6,$7)`, ['alice', randomUUID(), status, 'fixture', JSON.stringify({ projectId: 'p1', snapshotId: 's1', expectedRevision: 1 }), 'a'.repeat(64), status]);
    }
    const upgrade = migrations.find(m => m.name === '006_github_export_lifecycle.sql')!.sql;
    await db.query(upgrade); await applyMigrations(db);
    expect((await db.query('SELECT status FROM github_exports')).rows.map(row => row.status).sort()).toEqual(['failed', 'prepared', 'running', 'succeeded']);
    const duplicate = (name: string) => db.query(`INSERT INTO github_exports(owner_id,request_id,repo_name,github_username,selection,source_hash,fingerprint,connection_hash)
      VALUES($1,$2,$3,$4,'{}'::jsonb,$5,$5,$5)`, ['alice', randomUUID(), name, 'fixture', 'b'.repeat(64)]);
    for (const name of ['prepared', 'running', 'succeeded', 'failed']) await expect(duplicate(name)).rejects.toMatchObject({ code: '23505' });
    await db.query("UPDATE github_exports SET status='cancelled' WHERE status='prepared'");
    await duplicate('prepared');
    expect((await db.query('SELECT request_id FROM github_exports')).rows).toHaveLength(5);
  });
  it('reconciles an accepted remote write after a simulated process crash, reconnect and project deletion', async () => {
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const remote = githubExportProvider([{ path: 'index.html', content: '<main>Exact</main>' }]);
    let fingerprint = 'b'.repeat(64), failFinish = true;
    const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint, username: 'fixture-user',
      run: async operation => operation({ token: 'synthetic-token', githubId: 42, username: 'fixture-user', assertAuthorized: async () => undefined }) });
    const writer = vi.fn<typeof writeGitHubRepository>(args => writeGitHubRepository({ ...args, fetch: remote.api }));
    const verifier = (args: Parameters<typeof verifyGitHubExport>[0]) => verifyGitHubExport({ ...args, fetch: remote.api });
    const brokenDb: DbLike = { query: (sql, params) => {
      if (failFinish && sql.startsWith('UPDATE github_exports SET status=$3')) { failFinish = false; throw new Error('synthetic_process_crash'); }
      return db.query(sql, params);
    } };
    const service = githubExporter(brokenDb, { exportAccess }, writer, verifier), requestId = randomUUID();
    const prepared = await service.prepare('alice', { requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } });
    if (!('fingerprint' in prepared)) throw new Error('Expected review');
    await expect(service.confirm('alice', { requestId, fingerprint: prepared.fingerprint, publicConfirmed: true })).rejects.toThrow('synthetic_process_crash');
    fingerprint = 'c'.repeat(64); // refreshed connection, same immutable GitHub ID
    await db.query('UPDATE builder_projects SET deleted_at=now(), revision=2 WHERE owner_id=$1', ['alice']);
    expect(await service.status('alice', requestId)).toMatchObject({ status: 'running' });
    const before = remote.api.mock.calls.length;
    const recovered = await Promise.all(Array.from({ length: 8 }, () => githubExporter(db, { exportAccess }, writer, verifier).reconcile('alice', requestId)));
    expect(recovered.every(value => 'status' in value && value.status === 'succeeded')).toBe(true);
    expect(remote.api.mock.calls.slice(before).every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(writer).toHaveBeenCalledOnce();
    const row = (await db.query('SELECT checkpoint,reconciled_at,status FROM github_exports')).rows[0];
    expect(row.checkpoint.stage).toBe('commit_ready'); expect(row.reconciled_at).not.toBeNull(); expect(row.status).toBe('succeeded');
    expect(JSON.stringify(row)).not.toContain('synthetic-token'); expect(JSON.stringify(row)).not.toContain('<main>');
  });
  it('runs signed Cloud JWT → BFF → writer → durable PG evidence → read-only GitHub reconciliation', async () => {
    const pair = await generateKeyPair('ES256'), jwk = await exportJWK(pair.publicKey);
    const cloudAuth = makeCloudAuth(db, issuer, createLocalJWKSet({ keys: [{ ...jwk, kid: 'recovery-pg', alg: 'ES256' }] }));
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-alice', 'alice']);
    const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'recovery-pg' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const oauth = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'synthetic-github-token', token_type: 'bearer', scope: 'public_repo' })).mockResolvedValueOnce(Response.json({ id: 42, login: 'fixture-user' }));
    const service = githubCloud(db, { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: 'ab'.repeat(32), callbackUrl: 'https://lovable.test/github/callback', allowedOrigin: 'https://lovable.test', fetch: oauth });
    const nonce = 'cd'.repeat(32), state = new URL((await service.start('alice', nonce)).authorizationUrl).searchParams.get('state')!;
    expect(await service.finish('alice', state, nonce, 'fixture-code')).toEqual({ ok: true });
    const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
    await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
    const remote = githubExportProvider([{ path: 'index.html', content: '<main>Exact</main>' }], true), bridgeSecret = 'ef'.repeat(32);
    const exporter = githubExporter(db, service, args => writeGitHubRepository({ ...args, fetch: remote.api }), args => verifyGitHubExport({ ...args, fetch: remote.api }));
    const app = createApp({}, null, { rateLimit: () => true, auth: { db, jwtSecret: 'recovery-pg-cookie-secret-01234567890123456789', quota: new InMemoryQuotaStore(), cloudAuth, cloudGitHub: { service, bridgeSecret, exporter } } });
    const bff = makeGitHubBff({ baseUrl: 'https://hono.test', callbackUrl: 'https://lovable.test/github/callback', clientId: 'fixture-client', bridgeSecret,
      verifyToken: async value => !!(await cloudAuth.resolve(value)), fetch: async (url, init) => app.fetch(new Request(url, init)) });
    const call = (action: string, body: unknown) => bff(new Request('https://lovable.test/api/github-connect/export/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://lovable.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const requestId = randomUUID(), review = await (await call('prepare', { requestId, repoName: 'export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } })).json();
    expect(await (await call('confirm', { requestId, fingerprint: review.fingerprint, publicConfirmed: true })).json()).toMatchObject({ status: 'failed' });
    const before = remote.api.mock.calls.length, result = await call('reconcile', { requestId });
    expect(result.status).toBe(200);
    const completed = await result.json(); expect(completed).toMatchObject({ status: 'succeeded', result: { ok: true, commitSha: remote.commit } });
    expect(completed).not.toHaveProperty('checkpoint'); expect(JSON.stringify(completed)).not.toContain('synthetic-github-token');
    expect(remote.api.mock.calls.slice(before).every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(await (await call('confirm', { requestId, fingerprint: review.fingerprint, publicConfirmed: true })).json()).toEqual(completed);
    expect(remote.api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it('records only the first accepted nonempty save and retains it after project deletion', async () => {
    const backend = await hybridAiBackend(db, true);
    const alice = hybridTransport(backend.proxy, backend.tokens.alice);
    const savedAt = async (id: string) =>
      (await db.query('SELECT first_observed_app_save_at FROM users WHERE id=$1', [id])).rows[0].first_observed_app_save_at;
    const empty = { title: 'Draft', isPublic: false, liveId: null, snapshots: [], files: [] };
    const app = {
      ...empty,
      liveId: 'v1',
      snapshots: [{ id: 'v1', v: 1, prompt: '', kind: 'manual', time: '2000-01-01', html: '<main>App</main>' }],
      files: [{ name: 'index.html', content: '<main>App</main>' }],
    };
    // A populated pre-upgrade database stays unknown until a qualifying save.
    await db.query('ALTER TABLE users DROP COLUMN first_observed_app_save_at');
    await db.query(listMigrations().find(migration => migration.name === '014_first_app_save.sql')!.sql);
    expect(await savedAt('alice')).toBeNull();

    expect((await alice('projects/milestone', { method: 'POST', body: { expectedRevision: 0, workspace: empty } })).status).toBe(201);
    expect((await alice('projects/milestone', { method: 'POST', body: { expectedRevision: 0, workspace: app } })).status).toBe(409);
    expect(await savedAt('alice')).toBeNull();

    const first = await Promise.all([
      alice('projects/milestone', { method: 'POST', body: { expectedRevision: 1, workspace: app } }),
      alice('projects/second-app', { method: 'POST', body: { expectedRevision: 0, workspace: app } }),
    ]);
    expect(first.map(response => response.status)).toEqual([200, 201]);
    const timestamp = await savedAt('alice');
    expect(timestamp).toBeInstanceOf(Date);
    expect(timestamp.getUTCFullYear()).toBeGreaterThan(2000);
    expect(await savedAt('bob')).toBeNull();
    expect((await alice('projects/milestone', { method: 'POST', body: { expectedRevision: 2, workspace: app } })).status).toBe(200);
    await db.query('DELETE FROM builder_projects WHERE owner_id=$1', ['alice']);
    expect(await savedAt('alice')).toEqual(timestamp);
  });
  it('reports distinct weekly apps and the signup cohort without leaking identifiers', async () => {
    const week = '2026-10-12';
    const { start, end } = productReportWindow(week);
    const day = (offset: number) => new Date(start.getTime() + offset * 86_400_000);
    const asOf = new Date('2026-10-20T00:00:00Z');
    expect(() => productReportWindow('2026-10-13')).toThrow('invalid_report_week');
    expect(() => productReportWindow('2026-02-30')).toThrow('invalid_report_week');

    await db.query('UPDATE users SET created_at=$2 WHERE id=$1', ['alice', day(1)]);
    await db.query('UPDATE users SET created_at=$2 WHERE id=$1', ['bob', day(-2)]);
    for (const id of ['saved', 'empty', 'trashed'])
      await db.query('INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4)',
        [id, id + '@example.test', 'fixture', start]);
    for (const [owner, snapshots, deleted] of [['saved', [{}], null], ['empty', {}, null], ['trashed', [{}], day(5)]])
      await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace,deleted_at) VALUES($1,$2,$3,1,$4,$5)',
        [owner, 'fixture', 'Private fixture', JSON.stringify({ snapshots }), deleted]);
    const publish = (owner: string, project: string, at: Date, state = 'published') => db.query(
      `INSERT INTO publish_jobs(owner_id,request_id,project_id,project_revision,snapshot_id,source_fingerprint,source_files,artifact_id,state,created_at,updated_at)
       VALUES($1,$2,$3,1,'v1','fixture','[]',$4,$5,$6,$6)`,
      [owner, randomUUID(), project, randomUUID(), state, at],
    );
    await db.query('UPDATE users SET first_observed_app_save_at=$2 WHERE id=$1', ['alice', day(2)]);
    await db.query('UPDATE users SET first_observed_app_save_at=$2 WHERE id=$1', ['saved', day(1)]);
    await db.query('UPDATE users SET first_observed_app_save_at=$2 WHERE id=$1', ['trashed', end]);
    await publish('alice', 'same-id', day(0));
    await publish('alice', 'same-id', day(3));
    await publish('alice', 'same-id', day(4));
    await publish('bob', 'same-id', start);
    await publish('bob', 'excluded-at-end', end);
    await publish('bob', 'failed', day(4), 'failed');
    for (const [owner, type, at] of [
      ['alice', 'invoice.paid', day(2)], ['alice', 'invoice.paid', end],
      ['bob', 'invoice.paid', day(5)], ['alice', 'invoice.payment_failed', day(4)],
    ]) await db.query('INSERT INTO billing_events(event_id,user_id,event_type,processed_at) VALUES($1,$2,$3,$4)',
      [randomUUID(), owner, type, at]);

    const unconfigured = await weeklyProductReport(db, week, asOf);
    expect(unconfigured).toMatchObject({
      completeWeek: true, publishedApps: 2, successfulPublications: 4, billingEvidence: 'unconfigured',
      firstAppSaveEvidence: 'server-observed',
      signupCohort: {
        backendAccounts: 4, withCurrentSavedOrWeeklyPublishedApp: 2, withObservedFirstAppSaveInWeek: 2,
        withPublicationInWeek: 1, withLiveInvoicePaidEventAfterPublicationInWeek: null,
      },
    });
    expect(JSON.stringify(unconfigured)).not.toMatch(/alice|bob|fixture|@example/);
    await db.query("INSERT INTO billing_environment(id,mode) VALUES('stripe','test')");
    expect((await weeklyProductReport(db, week, asOf)).signupCohort.withLiveInvoicePaidEventAfterPublicationInWeek).toBeNull();
    await db.query("UPDATE billing_environment SET mode='live' WHERE id='stripe'");
    expect((await weeklyProductReport(db, week, asOf)).signupCohort.withLiveInvoicePaidEventAfterPublicationInWeek).toBe(0);
    await db.query("INSERT INTO billing_events(event_id,user_id,event_type,processed_at) VALUES($1,'alice','invoice.paid',$2)",
      [randomUUID(), day(5)]);
    expect((await weeklyProductReport(db, week, asOf)).signupCohort.withLiveInvoicePaidEventAfterPublicationInWeek).toBe(1);
    const positive = (paidAt: Date) => db.query(
      "INSERT INTO billing_events(event_id,user_id,event_type,processed_at,positive_pro_invoice_paid_at) VALUES($1,'alice','invoice.paid',$2,$3)",
      [randomUUID(), day(8), paidAt],
    );
    const firstPositive = async () => (await weeklyProductReport(db, week, asOf))
      .signupCohort.withFirstObservedPositiveProInvoiceAfterPublicationInWeek;
    expect(await firstPositive()).toBe(0);
    await positive(end);
    expect(await firstPositive()).toBe(0);
    await positive(day(5));
    expect(await firstPositive()).toBe(1);
    await positive(day(2));
    expect(await firstPositive()).toBe(0);
    await db.query('ALTER TABLE billing_events DROP COLUMN positive_pro_invoice_paid_at');
    expect(await firstPositive()).toBeNull();
    await db.query('ALTER TABLE users DROP COLUMN first_observed_app_save_at');
    expect(await weeklyProductReport(db, week, asOf)).toMatchObject({
      firstAppSaveEvidence: 'unavailable', signupCohort: { withObservedFirstAppSaveInWeek: null },
    });
  });
  it('reports only the signed owner’s successful publications inside the UTC usage period', async () => {
    const backend = await hybridAiBackend(db, true);
    const alice = hybridTransport(backend.proxy, backend.tokens.alice);
    const bob = hybridTransport(backend.proxy, backend.tokens.bob);
    const period = await backend.usage.report('alice');
    const start = new Date(period.periodStart + 'T00:00:00Z');
    const end = new Date(period.periodEnd + 'T00:00:00Z');

    const insert = (owner: string, state: string, updated: Date) => db.query(
      `INSERT INTO publish_jobs(owner_id, request_id, project_id, project_revision, snapshot_id,
        source_fingerprint, source_files, artifact_id, state, created_at, updated_at)
        VALUES($1,$2,'fixture',1,'v1','fixture','[]',$3,$4,$5,$6)`,
      [owner, randomUUID(), randomUUID(), state, new Date(updated.getTime() - 5000), updated],
    );
    await insert('alice', 'published', start);
    await insert('alice', 'published', new Date(end.getTime() - 1));
    await insert('alice', 'published', new Date(start.getTime() - 1));
    await insert('alice', 'published', end);
    await insert('alice', 'building', start);
    await insert('alice', 'failed', start);
    await insert('bob', 'published', start);

    const aliceReport = await alice('ai-usage');
    expect(aliceReport.status).toBe(200);
    expect(aliceReport.headers.get('cache-control')).toBe('no-store');
    expect(await aliceReport.json()).toMatchObject({ publishedDeployments: 2 });
    expect(await (await bob('ai-usage')).json()).toMatchObject({ publishedDeployments: 1 });
    await db.query('ALTER TABLE publish_jobs RENAME TO fixture_unavailable_publish_jobs');
    expect(await (await alice('ai-usage')).json()).toMatchObject({ calls: 0, periodStart: period.periodStart });
    expect(await (await alice('ai-usage')).json()).not.toHaveProperty('publishedDeployments');
  });
  it('runs verified JWT → proxy → Hono → PostgreSQL save/CAS/recovery and immediate link revocation', async () => {
    const pair = await generateKeyPair('ES256'), jwk = await exportJWK(pair.publicKey);
    const cloudAuth = makeCloudAuth(db, issuer, createLocalJWKSet({ keys: [{ ...jwk, kid: 'pg-test', alg: 'ES256' }] }));
    await db.query('INSERT INTO identity_links (issuer,subject,user_id) VALUES ($1,$2,$3)', [issuer, 'cloud-alice', 'alice']);
    const token = await new SignJWT({ role: 'authenticated', user_metadata: { plan: 'pro', id: 'bob' } }).setProtectedHeader({ alg: 'ES256', kid: 'pg-test' }).setIssuer(issuer).setAudience('authenticated').setSubject('cloud-alice').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const quota = new PostgresQuotaStore(db), provider = makeMockProvider(), complete = vi.spyOn(provider, 'complete');
    const app = createApp({}, provider, { rateLimit: () => true, auth: { db, jwtSecret: 'cloud-pg-cookie-secret-01234567890123456789', quota, cloudAuth } });
    const proxy = makeHonoProxy({ baseUrl: 'https://hono.test', basicAuth: 'pilot:synthetic-test-password', authenticate: async () => ({ accessToken: token }), fetch: async (input, init) => app.fetch(new Request(input, init)) });
    const request = (path: string, body?: unknown) => proxy(new Request('https://lovable.test/api/hono' + path, { headers: { Origin: 'https://lovable.test', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }));
    const me = await (await request('/auth/me')).json();
    expect(me.user).toEqual({ id: 'alice', email: 'alice@example.com', plan: 'free' });
    const payload = { expectedRevision: 0, workspace: { title: 'Cloud stored', isPublic: false, liveId: null, snapshots: [], files: [] } };
    expect(await (await request('/projects/p1', payload)).json()).toEqual({ id: 'p1', revision: 1 });
    const conflict = await request('/projects/p1', payload); expect(conflict.status).toBe(409); await conflict.text();
    expect((await (await request('/projects/p1')).json()).workspace.title).toBe('Cloud stored');
    expect(await (await request('/project-storage')).json()).toMatchObject({ usedProjects: 1, trashedProjects: 0 });
    expect((await request('/project-storage?owner=bob')).status).toBe(404);
    expect(await (await request('/projects/p1/delete', { expectedRevision: 1 })).json()).toEqual({ id: 'p1', revision: 2 });
    expect(await (await request('/projects/p1/restore', { expectedRevision: 2 })).json()).toEqual({ id: 'p1', revision: 3 });
    await db.query('INSERT INTO user_quotas(user_id,period_start,generations) VALUES($1,$2,9)', ['alice',monthWindow()]);
    const generated = await request('/agent/generate',{projectId:'cloud-ai',prompt:'Build a small dashboard',mode:'create'});
    expect(generated.status).toBe(200);expect(await generated.text()).toContain('"type":"done"');
    const calls = complete.mock.calls.length;expect(calls).toBeGreaterThan(1);
    const usageResponse = await request('/ai-usage');expect(usageResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(await usageResponse.json()).toMatchObject({calls,reportedCalls:calls,unknownCalls:0,pendingCalls:0,promptTokens:100*calls,completionTokens:500*calls});
    expect((await request('/ai-usage?owner=bob')).status).toBe(404);
    expect((await db.query('SELECT user_id,status FROM ai_runs')).rows).toEqual([{user_id:'alice',status:'succeeded'}]);
    expect(await (await request('/auth/me')).json()).toMatchObject({quota:{used:10,limit:10,remaining:0,plan:'free'}});
    const denied = await request('/agent/generate',{projectId:'cloud-ai',prompt:'Another task',mode:'create'});
    expect(denied.status).toBe(429);expect(await denied.json()).toMatchObject({error:'quota_exceeded',userId:'alice'});
    expect(complete).toHaveBeenCalledTimes(calls);expect(await quota.usage('bob')).toMatchObject({used:0});
    await db.query('DELETE FROM identity_links WHERE user_id=$1', ['alice']);
    const afterRevocation = await request('/agent/generate',{projectId:'cloud-ai',prompt:'After revocation',mode:'create'});
    expect(afterRevocation.status).toBe(401);await afterRevocation.text();expect(complete).toHaveBeenCalledTimes(calls);
    expect(await quota.usage('alice')).toMatchObject({used:10});
    expect((await request('/ai-usage')).status).toBe(401);
    const revoked = await request('/projects/p1'); expect(revoked.status).toBe(401); await revoked.text();
    expect((await db.query('SELECT owner_id FROM builder_projects')).rows).toEqual([{ owner_id: 'alice' }]);
  });
});
