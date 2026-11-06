import { z } from 'zod';
import { githubApi } from './githubApi';
import { GitHubCommitCheckpoint, gitSha } from './githubCheckpoint';
import type { WriteResult } from './githubWriter';

export type RecoveryResult = Extract<WriteResult, { ok: true }> | { ok: false; error: 'export_not_verified' | 'github_recovery_unavailable' };

/** Read-only reconciliation. A name or matching file list alone is insufficient:
 * verify the original repository ID, owner ID, branch tip, exact commit/tree,
 * single parent and every recorded blob/mode. Never PATCH, POST or DELETE. */
export async function verifyGitHubExport(input: {
  token: string; githubId: number; username: string; checkpoint: unknown;
  assertAuthorized: () => Promise<void>; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<RecoveryResult> {
  const parsed = GitHubCommitCheckpoint.safeParse(input.checkpoint);
  if (!parsed.success) return { ok: false, error: 'export_not_verified' };
  const checkpoint = parsed.data, [owner, name] = checkpoint.repository.repoFullName.split('/');
  if (input.githubId !== checkpoint.githubId || input.username.toLowerCase() !== owner.toLowerCase()) return { ok: false, error: 'export_not_verified' };
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(input.signal ? [input.signal] : [])]);
  const api = githubApi(input, signal), root = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name);
  try {
    const user = z.object({ id: z.number().int().positive(), login: z.string() }).parse(await api('/user'));
    const repository = z.object({ id: z.number().int().positive(), full_name: z.string(), private: z.boolean(),
      owner: z.object({ id: z.number().int().positive(), login: z.string() }) }).parse(await api(root));
    if (user.id !== checkpoint.githubId || user.login.toLowerCase() !== owner.toLowerCase() || repository.id !== checkpoint.repository.repositoryId ||
      repository.private || repository.full_name.toLowerCase() !== checkpoint.repository.repoFullName.toLowerCase() || repository.owner.id !== checkpoint.githubId || repository.owner.login.toLowerCase() !== owner.toLowerCase()) return { ok: false, error: 'export_not_verified' };
    const branch = checkpoint.branch.split('/').map(encodeURIComponent).join('/');
    const ref = z.object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha: gitSha }) }).parse(await api(root + '/git/ref/heads/' + branch));
    const commit = z.object({ sha: gitSha, tree: z.object({ sha: gitSha }), parents: z.array(z.object({ sha: gitSha })) }).parse(await api(root + '/git/commits/' + checkpoint.commitSha));
    if (ref.ref !== 'refs/heads/' + checkpoint.branch || ref.object.sha !== checkpoint.commitSha || commit.sha !== checkpoint.commitSha || commit.tree.sha !== checkpoint.treeSha ||
      commit.parents.length !== 1 || commit.parents[0].sha !== checkpoint.parentSha) return { ok: false, error: 'export_not_verified' };
    const tree = z.object({ sha: gitSha, truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string(), sha: gitSha })).max(1000) }).parse(await api(root + '/git/trees/' + checkpoint.treeSha + '?recursive=1'));
    if (tree.sha !== checkpoint.treeSha || tree.truncated || new Set(tree.tree.map(file => file.path)).size !== tree.tree.length) return { ok: false, error: 'export_not_verified' };
    const entries = new Map(tree.tree.map(file => [file.path, file]));
    if (checkpoint.files.some(file => { const entry = entries.get(file.path); return !entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.sha !== file.sha; })) return { ok: false, error: 'export_not_verified' };
    await input.assertAuthorized(); signal.throwIfAborted();
    return { ok: true, ...checkpoint.repository, commitSha: checkpoint.commitSha, filesUploaded: checkpoint.files.length };
  } catch { return { ok: false, error: 'github_recovery_unavailable' }; }
}
