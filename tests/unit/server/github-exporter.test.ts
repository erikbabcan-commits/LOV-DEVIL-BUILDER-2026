// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';
import { beforeEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../server/db/migrate';
import { githubExporter } from '../../../server/integrations/githubExporter';
import type { githubCloud } from '../../../server/integrations/githubCloud';
import { writeGitHubRepository } from '../../../server/integrations/githubWriter';
import { verifyGitHubExport } from '../../../server/integrations/githubRecovery';
import { githubExportProvider } from '../../helpers/githubExportProvider';
import type { DbLike } from '../../../server/db/pool';

let db: DbLike;
beforeEach(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  db = { query: async (sql, params) => { const r = await pool.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } };
  await applyMigrations(db);
  for (const id of ['alice', 'bob']) await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id, id + '@example.com', 'unused']);
  const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: '', kind: 'manual', time: '', html: '<main>Exact</main>' }], files: [] };
  await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,$4,$5::jsonb)', ['alice', 'p1', 'Export', 1, JSON.stringify(workspace)]);
});
function fixture() {
  const writer = vi.fn<typeof writeGitHubRepository>().mockResolvedValue({ ok: true, repositoryId: 99, repoFullName: 'fixture/export', repoUrl: 'https://github.com/fixture/export', commitSha: 'a'.repeat(40), filesUploaded: 1 });
  const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: 'b'.repeat(64), username: 'fixture', run: async operation => operation({ token: 'fixture-token', githubId: 42, username: 'fixture', assertAuthorized: async () => undefined }) });
  const service = githubExporter(db, { exportAccess }, writer);
  const input = { requestId: randomUUID(), repoName: 'Export', selection: { projectId: 'p1', snapshotId: 's1', expectedRevision: 1 } };
  return { service, writer, input };
}
it('prepares a public file review, requires explicit confirmation, and caches completed retries', async () => {
  const { service, writer, input } = fixture(); const prepared = await service.prepare('alice', input);
  expect(prepared).toMatchObject({ status: 'prepared', repoName: 'export', visibility: 'public', files: [{ path: 'index.html', bytes: 18 }] });
  expect(writer).not.toHaveBeenCalled();
  expect(await service.confirm('alice', { requestId: input.requestId })).toEqual({ error: 'public_confirmation_required' });
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  const consent = { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true };
  const result = await service.confirm('alice', consent);
  expect(result).toMatchObject({ status: 'succeeded', result: { ok: true } });
  expect(await service.confirm('alice', consent)).toEqual(result);
  expect(writer).toHaveBeenCalledOnce();
  expect(await service.status('bob', input.requestId)).toEqual({ error: 'export_not_found' });
});
it('rejects key/name reuse for a different request and another owner’s snapshot', async () => {
  const { service, input, writer } = fixture(); const first = await service.prepare('alice', input);
  expect(await service.prepare('alice', { ...input, repoName: 'other' })).toEqual({ error: 'export_request_conflict' });
  expect(await service.prepare('alice', { ...input, requestId: randomUUID() })).toEqual({ error: 'export_request_conflict' });
  expect(await service.prepare('bob', input)).toEqual({ error: 'project_not_found' });
  const otherId = randomUUID(), other = await service.prepare('alice', { ...input, requestId: otherId, repoName: 'other' });
  if (!('fingerprint' in first) || !('fingerprint' in other)) throw new Error('Expected reviews');
  expect(other.fingerprint).not.toBe(first.fingerprint);
  expect(await service.confirm('alice', { requestId: otherId, fingerprint: first.fingerprint, publicConfirmed: true })).toEqual({ error: 'export_request_conflict' });
  expect(writer).not.toHaveBeenCalled();
});
it('does not publish an edited or deleted project after review', async () => {
  const { service, writer, input } = fixture(); const prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  await db.query('UPDATE builder_projects SET revision=2 WHERE owner_id=$1', ['alice']);
  expect(await service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true })).toMatchObject({ status: 'failed', result: { ok: false } });
  expect(writer).not.toHaveBeenCalled();
});
it('expires an unconfirmed review without contacting GitHub', async () => {
  const { service, writer, input } = fixture(); const prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  await db.query('UPDATE github_exports SET expires_at=$1', [new Date(0)]);
  expect(await service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true })).toMatchObject({ status: 'expired' });
  expect(writer).not.toHaveBeenCalled();
});
it('never retries a failed or uncertain remote write automatically', async () => {
  const { service, writer, input } = fixture(); writer.mockResolvedValue({ ok: false, error: 'github_write_failed' });
  const prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  const consent = { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true };
  const failed = await service.confirm('alice', consent);
  expect(failed).toMatchObject({ status: 'failed' });
  expect(await service.confirm('alice', consent)).toEqual(failed);
  expect(writer).toHaveBeenCalledOnce();
});
it('rejects a connection change between review and publication', async () => {
  const { writer, input } = fixture(); let hash = 'b'.repeat(64);
  const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: hash, username: 'fixture', run: async operation => operation({ token: 'fixture-token', githubId: 42, username: 'fixture', assertAuthorized: async () => undefined }) });
  const service = githubExporter(db, { exportAccess }, writer), prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  hash = 'c'.repeat(64);
  expect(await service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true })).toMatchObject({ status: 'failed' });
  expect(writer).not.toHaveBeenCalled();
});
it('restores the exact server review after service recreation without publishing', async () => {
  const { service, writer, input } = fixture();
  const prepared = await service.prepare('alice', input);
  expect(prepared).toMatchObject({ title: 'Export', version: 1, selection: input.selection });
  expect(await fixture().service.review('alice', input.requestId)).toEqual(prepared);
  expect(await service.review('bob', input.requestId)).toEqual({ error: 'export_not_found' });
  await db.query('UPDATE builder_projects SET revision=2 WHERE owner_id=$1', ['alice']);
  expect(await service.review('alice', input.requestId)).toEqual({ error: 'project_conflict' });
  expect(writer).not.toHaveBeenCalled();
});
it('cancels only an owned proposal, keeps its tombstone and permits a fresh name reservation', async () => {
  const { service, writer, input } = fixture(); const prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  const cancellation = { requestId: input.requestId, fingerprint: prepared.fingerprint };
  expect(await service.cancel('bob', cancellation)).toEqual({ error: 'export_not_found' });
  expect(await service.cancel('alice', { ...cancellation, fingerprint: '0'.repeat(64) })).toEqual({ error: 'export_request_conflict' });
  expect(await service.cancel('alice', cancellation)).toMatchObject({ status: 'cancelled', result: null });
  expect(await service.cancel('alice', cancellation)).toMatchObject({ status: 'cancelled' });
  expect(await service.confirm('alice', { ...cancellation, publicConfirmed: true })).toMatchObject({ status: 'cancelled' });
  expect(await service.review('alice', input.requestId)).toEqual({ error: 'export_not_prepared' });
  expect(await service.prepare('alice', input)).toEqual({ error: 'export_not_prepared' });
  const next = await service.prepare('alice', { ...input, requestId: randomUUID() });
  expect(next).toMatchObject({ status: 'prepared', repoName: 'export' });
  if (!('fingerprint' in next)) throw new Error('Expected next review');
  expect(next.fingerprint).not.toBe(prepared.fingerprint);
  expect(writer).not.toHaveBeenCalled();
});
it('releases only expired proposals, never a claimed or uncertain write', async () => {
  const { service, writer, input } = fixture();
  const prepared = await service.prepare('alice', input);
  await db.query('UPDATE github_exports SET expires_at=$1', [new Date(0)]);
  expect(await service.status('alice', input.requestId)).toMatchObject({ status: 'expired' });
  expect(await service.review('alice', input.requestId)).toEqual({ error: 'export_expired' });
  expect(await service.prepare('alice', input)).toEqual({ error: 'export_expired' });
  const nextId = randomUUID();
  expect(await service.prepare('alice', { ...input, requestId: nextId })).toMatchObject({ status: 'prepared' });
  await db.query("UPDATE github_exports SET status='running', expires_at=$1 WHERE request_id=$2", [new Date(0), nextId]);
  expect(await service.status('alice', nextId)).toMatchObject({ status: 'running' });
  expect(await service.prepare('alice', { ...input, requestId: randomUUID() })).toEqual({ error: 'export_request_conflict' });
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  expect(await service.cancel('alice', { requestId: nextId, fingerprint: (await service.status('alice', nextId) as { fingerprint: string }).fingerprint })).toEqual({ error: 'export_already_started' });
  expect(writer).not.toHaveBeenCalled();
});
it('refuses to restore a review under a different GitHub connection', async () => {
  const { writer, input } = fixture(); let hash = 'b'.repeat(64);
  const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: hash, username: 'fixture', run: async operation => operation({ token: 'fixture-token', githubId: 42, username: 'fixture', assertAuthorized: async () => undefined }) });
  await githubExporter(db, { exportAccess }, writer).prepare('alice', input);
  hash = 'c'.repeat(64);
  expect(await githubExporter(db, { exportAccess }, writer).review('alice', input.requestId)).toEqual({ error: 'export_request_conflict' });
  expect(writer).not.toHaveBeenCalled();
});
function recoveryFixture(losePatch = true, database = db) {
  const remote = githubExportProvider([{ path: 'index.html', content: '<main>Exact</main>' }], losePatch);
  const writer = vi.fn<typeof writeGitHubRepository>(input => writeGitHubRepository({ ...input, fetch: remote.api }));
  const verifier = vi.fn<typeof verifyGitHubExport>(input => verifyGitHubExport({ ...input, fetch: remote.api }));
  let identity = 42;
  const exportAccess: ReturnType<typeof githubCloud>['exportAccess'] = async () => ({ fingerprint: 'b'.repeat(64), username: 'fixture-user',
    run: async operation => operation({ token: 'synthetic-token', githubId: identity, username: 'fixture-user', assertAuthorized: async () => undefined }) });
  return { remote, writer, verifier, connection: { exportAccess }, service: githubExporter(database, { exportAccess }, writer, verifier), setIdentity: (value: number) => { identity = value; } };
}
it('recovers an accepted PATCH with a lost response using only GETs and caches the verified result', async () => {
  const { input } = fixture(), { service, writer, verifier, remote } = recoveryFixture();
  const prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  const consent = { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true };
  expect(await service.confirm('alice', consent)).toMatchObject({ status: 'failed', result: { repository: { repositoryId: 99 } } });
  const checkpoint = (await db.query('SELECT checkpoint FROM github_exports')).rows[0].checkpoint;
  expect(checkpoint).toMatchObject({ stage: 'commit_ready', repository: { repositoryId: 99 } });
  expect(JSON.stringify(checkpoint)).not.toContain('<main>'); expect(JSON.stringify(checkpoint)).not.toContain('synthetic-token');
  const calls = remote.api.mock.calls.length;
  expect(await service.reconcile('bob', input.requestId)).toEqual({ error: 'export_not_found' });
  const completed = await service.reconcile('alice', input.requestId);
  expect(completed).toMatchObject({ status: 'succeeded', result: { ok: true, commitSha: remote.commit } });
  expect(remote.api.mock.calls.slice(calls).every(([, init]) => init?.method === 'GET')).toBe(true);
  expect(await service.confirm('alice', consent)).toEqual(completed);
  expect(await service.reconcile('alice', input.requestId)).toEqual(completed);
  expect(writer).toHaveBeenCalledOnce(); expect(verifier).toHaveBeenCalledOnce();
});
it('survives a process/storage failure after publication and project edits before reconciliation', async () => {
  let crash = true;
  const brokenDb: DbLike = { query: (sql, params) => {
    if (crash && sql.startsWith('UPDATE github_exports SET status=$3')) { crash = false; throw new Error('synthetic_process_crash'); }
    return db.query(sql, params);
  } };
  const { input } = fixture(), recovery = recoveryFixture(false, brokenDb);
  const prepared = await recovery.service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  await expect(recovery.service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true })).rejects.toThrow('synthetic_process_crash');
  await db.query('UPDATE builder_projects SET revision=2, deleted_at=now() WHERE owner_id=$1', ['alice']);
  expect(await recovery.service.status('alice', input.requestId)).toMatchObject({ status: 'running' });
  const restored = githubExporter(db, recovery.connection, recovery.writer, recovery.verifier);
  expect(await restored.reconcile('alice', input.requestId)).toMatchObject({ status: 'succeeded', result: { ok: true } });
  expect((await db.query('SELECT reconciled_at FROM github_exports')).rows[0].reconciled_at).not.toBeNull();
  expect(recovery.writer).toHaveBeenCalledOnce();
});
it('never guesses success for legacy evidence or a different GitHub identity', async () => {
  const { input } = fixture(), recovery = recoveryFixture();
  const prepared = await recovery.service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  expect(await recovery.service.reconcile('alice', input.requestId)).toMatchObject({ status: 'prepared' });
  expect(recovery.remote.api).not.toHaveBeenCalled();
  await recovery.service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true });
  recovery.setIdentity(7);
  expect(await recovery.service.reconcile('alice', input.requestId)).toEqual({ error: 'export_not_verified' });
  expect(await recovery.service.status('alice', input.requestId)).toMatchObject({ status: 'failed' });
  await db.query('UPDATE github_exports SET checkpoint=NULL WHERE request_id=$1', [input.requestId]);
  expect(await recovery.service.reconcile('alice', input.requestId)).toEqual({ error: 'export_recovery_unavailable' });
  expect(recovery.writer).toHaveBeenCalledOnce();
});
it('does not downgrade verified recovery when an older in-flight writer later reports failure', async () => {
  const { input } = fixture(), recovery = recoveryFixture(false);
  let release!: () => void;
  const delayed = vi.fn<typeof writeGitHubRepository>(async args => {
    await recovery.writer(args);
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: false, error: 'github_write_failed' };
  });
  const service = githubExporter(db, recovery.connection, delayed, recovery.verifier), prepared = await service.prepare('alice', input);
  if (!('fingerprint' in prepared)) throw new Error('Expected review');
  const confirming = service.confirm('alice', { requestId: input.requestId, fingerprint: prepared.fingerprint, publicConfirmed: true });
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await service.reconcile('alice', input.requestId)).toMatchObject({ status: 'succeeded', result: { ok: true } });
  } finally { release?.(); }
  expect(await confirming).toMatchObject({ status: 'succeeded', result: { ok: true } });
  expect(delayed).toHaveBeenCalledOnce();
});
