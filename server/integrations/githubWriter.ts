import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';
import { containsPotentialSecret } from '../security/secrets';
import { GitHubRepoName } from '../../shared/githubExportProtocol';
import { githubApi } from './githubApi';
import { gitBlobSha, gitBranch, type WriteCheckpoint } from './githubCheckpoint';
export { GitHubRepoName } from '../../shared/githubExportProtocol';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const reference = z.object({ object: z.object({ sha }) });
export interface WrittenRepository { repositoryId: number; repoFullName: string; repoUrl: string }
export type WriteResult = ({ ok: true; commitSha: string; filesUploaded: number } & WrittenRepository) |
  { ok: false; error: 'invalid_export' | 'repository_exists' | 'github_write_failed'; repository?: WrittenRepository };

/** Creates a new PUBLIC repository only. All HTTP destinations are fixed GitHub
 * API paths. No update of an existing repo, force push, workflow or deletion.
 * Caller holds durable idempotency claim and explicit publication confirmation.
 */
export async function writeGitHubRepository(input: {
  token: string; githubId: number; username: string; repoName: string;
  files: Array<{ path: string; content: string }>;
  assertAuthorized: () => Promise<void>;
  fetch?: typeof fetch; signal?: AbortSignal;
  checkpoint?: (value: WriteCheckpoint) => Promise<void>;
}): Promise<WriteResult> {
  const parsedFiles = z.array(z.object({ path: z.string().max(200), content: z.string().max(200_000) }).strict()).min(1).max(40).safeParse(input.files);
  if (!GitHubRepoName.safeParse(input.repoName).success || !/^[a-zA-Z0-9-]{1,39}$/.test(input.username) || !parsedFiles.success || !withinSizeLimits(parsedFiles.data).ok ||
    new Set(parsedFiles.data.map(f => f.path)).size !== parsedFiles.data.length || parsedFiles.data.some(f =>
      (!isSafePath(f.path) && !['styles.css', 'app.js'].includes(f.path)) ||
      f.path.split('/').some(part => ['.git', '.github', 'node_modules', '.vscode'].includes(part)) || containsPotentialSecret(f.path + '\n' + f.content))) return { ok: false, error: 'invalid_export' };
  const files = parsedFiles.data;
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(input.signal ? [input.signal] : [])]);
  let repository: WrittenRepository | undefined;
  const api = githubApi(input, signal);
  try {
    const user = z.object({ id: z.number().int().positive(), login: z.string() }).parse(await api('/user'));
    if (user.id !== input.githubId || user.login.toLowerCase() !== input.username.toLowerCase()) throw new Error('github_identity_changed');
    const fullName = user.login + '/' + input.repoName;
    const root = '/repos/' + encodeURIComponent(user.login) + '/' + encodeURIComponent(input.repoName);
    if (await api(root, 'GET', undefined, true) !== null) return { ok: false, error: 'repository_exists' };
    const created = z.object({ id: z.number().int().positive(), full_name: z.string(), private: z.literal(false),
      default_branch: gitBranch, owner: z.object({ id: z.number().int().positive(), login: z.string() }) }).parse(
      await api('/user/repos', 'POST', { name: input.repoName, private: false, auto_init: true, description: 'Exported from LOV-DEVIL Builder' }));
    if (created.full_name.toLowerCase() !== fullName.toLowerCase() || created.owner.id !== user.id || created.owner.login.toLowerCase() !== user.login.toLowerCase()) throw new Error('github_owner_mismatch');
    repository = { repositoryId: created.id, repoFullName: created.full_name, repoUrl: 'https://github.com/' + created.full_name };
    const base = { version: 1 as const, repository, githubId: user.id, branch: created.default_branch };
    await input.checkpoint?.({ ...base, stage: 'repository_created' });
    const branch = created.default_branch.split('/').map(encodeURIComponent).join('/');
    let initialRef: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      initialRef = await api(root + '/git/ref/heads/' + branch, 'GET', undefined, true);
      if (initialRef !== null) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const parent = reference.parse(initialRef).object.sha;
    const baseTree = z.object({ tree: z.object({ sha }) }).parse(await api(root + '/git/commits/' + parent)).tree.sha;
    const tree = z.object({ sha }).parse(await api(root + '/git/trees', 'POST', { base_tree: baseTree,
      tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }));
    const commit = z.object({ sha }).parse(await api(root + '/git/commits', 'POST', { message: 'Export project from LOV-DEVIL Builder', tree: tree.sha, parents: [parent] }));
    const committed = z.object({ tree: z.object({ sha }), parents: z.array(z.object({ sha })) }).parse(await api(root + '/git/commits/' + commit.sha));
    if (committed.tree.sha !== tree.sha || committed.parents.length !== 1 || committed.parents[0].sha !== parent) throw new Error('github_commit_mismatch');
    // Must be durable before changing the branch: a lost PATCH response can
    // then be resolved using GETs, even after the project has changed locally.
    await input.checkpoint?.({ ...base, stage: 'commit_ready', commitSha: commit.sha, treeSha: tree.sha, parentSha: parent,
      files: files.map(file => ({ path: file.path, sha: gitBlobSha(file.content) })) });
    await api(root + '/git/refs/heads/' + branch, 'PATCH', { sha: commit.sha, force: false });
    if (reference.parse(await api(root + '/git/ref/heads/' + branch)).object.sha !== commit.sha) throw new Error('github_ref_mismatch');
    const verified = z.object({ truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), type: z.string(), sha })) }).parse(await api(root + '/git/trees/' + tree.sha + '?recursive=1'));
    const blobs = new Map(verified.tree.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
    for (const file of files) {
      if (blobs.get(file.path) !== gitBlobSha(file.content)) throw new Error('github_blob_mismatch');
    }
    return { ok: true, ...repository, commitSha: commit.sha, filesUploaded: files.length };
  } catch { return { ok: false, error: 'github_write_failed', ...(repository ? { repository } : {}) }; }
}
