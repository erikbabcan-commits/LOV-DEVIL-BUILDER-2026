import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { DbLike } from '../db/pool';
import type { githubCloud } from './githubCloud';
import { GitHubSnapshotSelection, loadGitHubSnapshot } from './githubSnapshot';
import { writeGitHubRepository, type WriteResult } from './githubWriter';
import { PrepareGitHubExport, ConfirmGitHubExport, CancelGitHubExport } from '../../shared/githubExportProtocol';
import { GitHubCommitCheckpoint, GitHubWriteCheckpoint, gitBlobSha } from './githubCheckpoint';
import { verifyGitHubExport } from './githubRecovery';
export { PrepareGitHubExport, ConfirmGitHubExport } from '../../shared/githubExportProtocol';

interface Job { request_id: string; repo_name: string; github_username: string; selection: z.infer<typeof GitHubSnapshotSelection>; fingerprint: string; source_hash: string;
  connection_hash: string; status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; result: WriteResult | null; checkpoint: unknown }

/** Server-only prepare/confirm pipeline, mounted only by explicit Cloud wiring.
 * A crash after claiming stays running and requires reconciliation, never a
 * blind retry. GitHub offers no atomic transaction with our database.
 */
export function githubExporter(db: DbLike, connection: Pick<ReturnType<typeof githubCloud>, 'exportAccess'>, writer = writeGitHubRepository, verifier = verifyGitHubExport) {
  const read = async (owner: string, id: string): Promise<Job | null> =>
    (await db.query('SELECT request_id, repo_name, github_username, selection, source_hash, fingerprint, connection_hash, status, result, checkpoint FROM github_exports WHERE owner_id=$1 AND request_id=$2', [owner, id])).rows[0] ?? null;
  const view = (job: Job) => ({ requestId: job.request_id, repoName: job.repo_name, username: job.github_username, fingerprint: job.fingerprint, status: job.status, result: job.result });
  const expire = async (owner: string) => {
    // DB time and conditional UPDATE serialize with confirmation/cancellation.
    // Running or uncertain writes never expire and never release their name.
    await db.query("UPDATE github_exports SET status='expired' WHERE owner_id=$1 AND status='prepared' AND expires_at <= now()", [owner]);
  };
  const review = async (owner: string, job: Job) => {
    if (job.status !== 'prepared') return { error: job.status === 'expired' ? 'export_expired' : 'export_not_prepared' } as const;
    const snapshot = await loadGitHubSnapshot(db, owner, job.selection);
    if (!snapshot.ok) return { error: snapshot.error };
    const access = await connection.exportAccess(owner);
    if (!access) return { error: 'github_not_connected' } as const;
    if (snapshot.fingerprint !== job.source_hash || access.fingerprint !== job.connection_hash) return { error: 'export_request_conflict' } as const;
    return { ...view(job), visibility: 'public' as const, selection: job.selection, title: snapshot.title, version: snapshot.version,
      files: snapshot.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') })) };
  };
  const finish = async (owner: string, id: string, result: WriteResult) => {
    await db.query("UPDATE github_exports SET status=$3, result=$4::jsonb WHERE owner_id=$1 AND request_id=$2 AND status='running'", [owner, id, result.ok ? 'succeeded' : 'failed', JSON.stringify(result)]);
  };
  return {
    async prepare(owner: string, input: unknown) {
      const parsed = PrepareGitHubExport.safeParse(input);
      if (!parsed.success) return { error: 'invalid_export_request' } as const;
      const { requestId, selection } = parsed.data, repoName = parsed.data.repoName.toLowerCase();
      await expire(owner);
      const snapshot = await loadGitHubSnapshot(db, owner, selection);
      if (!snapshot.ok) return { error: snapshot.error };
      const access = await connection.exportAccess(owner);
      if (!access) return { error: 'github_not_connected' } as const;
      const fingerprint = createHash('sha256').update(JSON.stringify({ owner, requestId, repoName, visibility: 'public', source: snapshot.fingerprint, connection: access.fingerprint })).digest('hex');
      await db.query(`INSERT INTO github_exports (owner_id,request_id,repo_name,selection,fingerprint,connection_hash,source_hash,github_username)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [owner, requestId, repoName, JSON.stringify(selection), fingerprint, access.fingerprint, snapshot.fingerprint, access.username]);
      const job = await read(owner, requestId);
      if (!job || job.fingerprint !== fingerprint || job.repo_name !== repoName || job.connection_hash !== access.fingerprint) return { error: 'export_request_conflict' } as const;
      return review(owner, job);
    },
    async confirm(owner: string, input: unknown, signal?: AbortSignal) {
      const parsed = ConfirmGitHubExport.safeParse(input);
      if (!parsed.success) return { error: 'public_confirmation_required' } as const;
      await expire(owner);
      const { requestId, fingerprint } = parsed.data, job = await read(owner, requestId);
      if (!job) return { error: 'export_not_found' } as const;
      if (job.fingerprint !== fingerprint) return { error: 'export_request_conflict' } as const;
      if (job.status !== 'prepared') return view(job);
      const claimed = await db.query(`UPDATE github_exports SET status='running'
        WHERE owner_id=$1 AND request_id=$2 AND fingerprint=$3 AND status='prepared' AND expires_at > now() RETURNING request_id`, [owner, requestId, fingerprint]);
      if (!claimed.rows.length) {
        const current = await read(owner, requestId);
        return current?.status !== 'prepared' && current ? view(current) : { error: 'export_expired' } as const;
      }
      let result: WriteResult;
      try {
        const snapshot = await loadGitHubSnapshot(db, owner, job.selection), access = await connection.exportAccess(owner);
        if (!snapshot.ok || snapshot.fingerprint !== job.source_hash || !access || access.fingerprint !== job.connection_hash) result = { ok: false, error: 'invalid_export' };
        else result = await access.run(credentials => writer({ ...credentials, repoName: job.repo_name, files: snapshot.files, ...(signal ? { signal } : {}), checkpoint: async value => {
          const parsed = GitHubWriteCheckpoint.parse(value);
          if (parsed.githubId !== credentials.githubId || parsed.repository.repoFullName.toLowerCase() !== (job.github_username + '/' + job.repo_name).toLowerCase()) throw new Error('invalid_checkpoint');
          if (parsed.stage === 'commit_ready' && (parsed.files.length !== snapshot.files.length || parsed.files.some(file =>
            !snapshot.files.some(source => source.path === file.path && gitBlobSha(source.content) === file.sha)))) throw new Error('invalid_checkpoint');
          const saved = await db.query("UPDATE github_exports SET checkpoint=$3::jsonb WHERE owner_id=$1 AND request_id=$2 AND status='running' RETURNING request_id", [owner, requestId, JSON.stringify(parsed)]);
          if (!saved.rows.length) throw new Error('export_no_longer_running');
        } }));
      } catch { result = { ok: false, error: 'github_write_failed' }; }
      await finish(owner, requestId, result);
      return view((await read(owner, requestId))!);
    },
    async reconcile(owner: string, requestId: string, signal?: AbortSignal) {
      if (!z.string().uuid().safeParse(requestId).success) return { error: 'invalid_export_request' } as const;
      const job = await read(owner, requestId);
      if (!job) return { error: 'export_not_found' } as const;
      if (job.status !== 'running' && job.status !== 'failed') return view(job);
      const checkpoint = GitHubCommitCheckpoint.safeParse(job.checkpoint);
      if (!checkpoint.success) return { error: 'export_recovery_unavailable' } as const;
      const access = await connection.exportAccess(owner);
      if (!access) return { error: 'github_not_connected' } as const;
      try {
        // A refreshed connection may read evidence only for the same immutable
        // GitHub owner ID. The verifier revalidates /user and repo ownership.
        const result = await access.run(credentials => verifier({ ...credentials, checkpoint: checkpoint.data, ...(signal ? { signal } : {}) }));
        if (!result.ok) return { error: result.error };
        await db.query(`UPDATE github_exports SET status='succeeded', result=$4::jsonb, reconciled_at=now()
          WHERE owner_id=$1 AND request_id=$2 AND checkpoint=$3::jsonb AND status IN ('running','failed')`, [owner, requestId, JSON.stringify(checkpoint.data), JSON.stringify(result)]);
        return view((await read(owner, requestId))!);
      } catch { return { error: 'github_recovery_unavailable' } as const; }
    },
    async review(owner: string, requestId: string) {
      if (!z.string().uuid().safeParse(requestId).success) return { error: 'invalid_export_request' } as const;
      await expire(owner);
      const job = await read(owner, requestId);
      return job ? review(owner, job) : { error: 'export_not_found' } as const;
    },
    async cancel(owner: string, input: unknown) {
      const parsed = CancelGitHubExport.safeParse(input);
      if (!parsed.success) return { error: 'invalid_export_request' } as const;
      const { requestId, fingerprint } = parsed.data;
      await expire(owner);
      const job = await read(owner, requestId);
      if (!job) return { error: 'export_not_found' } as const;
      if (job.fingerprint !== fingerprint) return { error: 'export_request_conflict' } as const;
      await db.query("UPDATE github_exports SET status='cancelled' WHERE owner_id=$1 AND request_id=$2 AND fingerprint=$3 AND status='prepared' AND expires_at > now()", [owner, requestId, fingerprint]);
      const current = (await read(owner, requestId))!;
      return current.status === 'cancelled' || current.status === 'expired' ? view(current) : { error: 'export_already_started' } as const;
    },
    async status(owner: string, requestId: string) {
      if (!z.string().uuid().safeParse(requestId).success) return { error: 'invalid_export_request' } as const;
      await expire(owner);
      const job = await read(owner, requestId);
      return job ? view(job) : { error: 'export_not_found' } as const;
    },
  };
}
