import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';
import { containsPotentialSecret, redactSecrets } from '../security/secrets';
import type { DbLike } from '../db/pool';
import { GitHubRepoName } from '../../shared/githubExportProtocol';
import { githubApi, githubCompare, githubCreatePull, githubCreateRef, githubGetRef, githubGetRepo, githubListOpenPulls, githubUpdatePull, githubUpdateRef, isProtectedBranch } from './githubApi';
import { gitBlobSha } from './githubCheckpoint';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const reservedSlugs = new Set(['main', 'master', 'head', 'heads', 'refs', 'origin', 'trunk', 'develop']);

/** Deterministic git-ref-safe component for `forge/<slug>`. Diacritics stripped, max length bounded. */
export function forgeBranchSlug(seed: string, maxLength = 80): string {
  const stripped = seed.normalize('NFD').replace(/\p{M}/gu, '');
  let value = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  value = value.replace(/\.\./g, '.').replace(/@\{/g, 'at').replace(/\.lock$/g, '');
  if (value.length > maxLength) value = value.slice(0, maxLength).replace(/[-.]+$/g, '');
  if (!value) value = 'project';
  if (reservedSlugs.has(value)) value = value + '-project';
  return value;
}

export function forgeBranchName(seed: string): string {
  return 'forge/' + forgeBranchSlug(seed);
}

export const GitHubSyncRequest = z.object({
  repoName: GitHubRepoName,
  slugSeed: z.string().min(1).max(200),
  checkpointSha: sha.nullable().optional(),
  confirmed: z.literal(true),
  selection: z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    expectedRevision: z.number().int().positive().max(2_147_483_646),
  }).strict().optional(),
}).strict();
export type GitHubSyncRequest = z.infer<typeof GitHubSyncRequest>;

export type GitHubSyncResult =
  | {
      ok: true;
      branch: string;
      commitSha: string;
      pullNumber: number;
      pullUrl: string;
      filesUploaded: number;
      repoFullName: string;
      repoUrl: string;
      repositoryId: number;
      createdPull: boolean;
    }
  | {
      ok: false;
      error: 'remote_changed';
      changedPaths: string[];
      checkpointSha: string;
      remoteSha: string;
    }
  | {
      ok: false;
      error:
        | 'private_repo_not_allowed'
        | 'github_reauth_required'
        | 'invalid_export'
        | 'github_write_failed'
        | 'github_repo_not_found'
        | 'default_branch_forbidden';
    };

/** True when a stored connection cipher exists but is past connection_expires_at. No new table. */
export async function githubConnectionExpired(db: DbLike, ownerId: string, now = Date.now()): Promise<boolean> {
  const row = (
    await db.query(
      'SELECT connection_cipher, connection_expires_at FROM github_pending WHERE owner_id=$1',
      [ownerId],
    )
  ).rows[0] as { connection_cipher: string | null; connection_expires_at: Date | string | null } | undefined;
  if (!row?.connection_cipher || !row.connection_expires_at) return false;
  return new Date(row.connection_expires_at).getTime() <= now;
}

function validFiles(files: Array<{ path: string; content: string }>): files is Array<{ path: string; content: string }> {
  const parsed = z.array(z.object({ path: z.string().max(200), content: z.string().max(200_000) }).strict()).min(1).max(40).safeParse(files);
  if (!parsed.success || !withinSizeLimits(parsed.data).ok) return false;
  if (new Set(parsed.data.map(f => f.path)).size !== parsed.data.length) return false;
  return !parsed.data.some(f =>
    (!isSafePath(f.path) && !['styles.css', 'app.js'].includes(f.path)) ||
    f.path.split('/').some(part => ['.git', '.github', 'node_modules', '.vscode'].includes(part)) ||
    containsPotentialSecret(f.path + '\n' + f.content),
  );
}

/**
 * Bidirectional-safe export: write project files to `forge/<slug>` and open or
 * update a PR into the default branch. Never commits to main/master/default.
 * Tokens must be supplied by the caller from the existing encrypted store.
 */
export async function syncToForgeBranch(input: {
  token: string;
  githubId: number;
  username: string;
  repoName: string;
  files: Array<{ path: string; content: string }>;
  slugSeed: string;
  checkpointSha?: string | null;
  tokenExpired?: boolean;
  assertAuthorized: () => Promise<void>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GitHubSyncResult> {
  if (input.tokenExpired) return { ok: false, error: 'github_reauth_required' };
  if (!GitHubRepoName.safeParse(input.repoName).success || !/^[a-zA-Z0-9-]{1,39}$/.test(input.username) || !validFiles(input.files))
    return { ok: false, error: 'invalid_export' };
  const files = input.files;
  const branch = forgeBranchName(input.slugSeed);
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(input.signal ? [input.signal] : [])]);
  const api = githubApi(input, signal);
  const writes: string[] = [];
  try {
    let user: { id: number; login: string };
    try {
      user = z.object({ id: z.number().int().positive(), login: z.string() }).parse(await api('/user'));
    } catch (error) {
      if (error instanceof Error && error.message === 'github_unauthorized')
        return { ok: false, error: 'github_reauth_required' };
      throw error;
    }
    if (user.id !== input.githubId || user.login.toLowerCase() !== input.username.toLowerCase())
      return { ok: false, error: 'github_write_failed' };

    const repo = await githubGetRepo(api, user.login, input.repoName);
    if (!repo) return { ok: false, error: 'github_repo_not_found' };
    const repoOwner = z.object({ id: z.number().int().positive(), login: z.string() }).parse(repo.owner);
    if (repo.private === true) return { ok: false, error: 'private_repo_not_allowed' };
    if (
      repoOwner.id !== user.id ||
      repoOwner.login.toLowerCase() !== user.login.toLowerCase() ||
      repo.full_name.toLowerCase() !== (user.login + '/' + input.repoName).toLowerCase()
    ) return { ok: false, error: 'github_write_failed' };

    const defaultBranch = repo.default_branch;
    if (isProtectedBranch(branch, defaultBranch)) return { ok: false, error: 'default_branch_forbidden' };

    const forgeRef = await githubGetRef(api, user.login, input.repoName, branch);
    const checkpoint = input.checkpointSha && sha.safeParse(input.checkpointSha).success ? input.checkpointSha : null;
    if (forgeRef && checkpoint && forgeRef.sha !== checkpoint) {
      const comparison = await githubCompare(api, user.login, input.repoName, checkpoint, forgeRef.sha);
      return {
        ok: false,
        error: 'remote_changed',
        checkpointSha: checkpoint,
        remoteSha: forgeRef.sha,
        changedPaths: comparison?.changedPaths.length ? comparison.changedPaths : ['unknown'],
      };
    }

    const parentRef = forgeRef ?? (await githubGetRef(api, user.login, input.repoName, defaultBranch));
    if (!parentRef) return { ok: false, error: 'github_write_failed' };
    const root = '/repos/' + encodeURIComponent(user.login) + '/' + encodeURIComponent(input.repoName);
    const parent = parentRef.sha;
    const baseTree = z.object({ tree: z.object({ sha }) }).parse(await api(root + '/git/commits/' + parent)).tree.sha;
    const tree = z.object({ sha }).parse(await api(root + '/git/trees', 'POST', {
      base_tree: baseTree,
      tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }));
    writes.push('tree');
    const commit = z.object({ sha }).parse(await api(root + '/git/commits', 'POST', {
      message: 'Sync project from LOV-DEVIL Builder onto ' + branch,
      tree: tree.sha,
      parents: [parent],
    }));
    writes.push('commit');
    const committed = z.object({ tree: z.object({ sha }), parents: z.array(z.object({ sha })) }).parse(await api(root + '/git/commits/' + commit.sha));
    if (committed.tree.sha !== tree.sha || committed.parents.length !== 1 || committed.parents[0].sha !== parent)
      return { ok: false, error: 'github_write_failed' };
    const verified = z.object({ truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), type: z.string(), sha })) }).parse(
      await api(root + '/git/trees/' + tree.sha + '?recursive=1'),
    );
    const blobs = new Map(verified.tree.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
    for (const file of files) {
      if (blobs.get(file.path) !== gitBlobSha(file.content)) return { ok: false, error: 'github_write_failed' };
    }

    if (!forgeRef) {
      await githubCreateRef(api, user.login, input.repoName, branch, commit.sha);
    } else {
      await githubUpdateRef(api, user.login, input.repoName, branch, commit.sha, defaultBranch);
    }
    writes.push('ref:' + branch);
    const tip = await githubGetRef(api, user.login, input.repoName, branch);
    if (!tip || tip.sha !== commit.sha) return { ok: false, error: 'github_write_failed' };

    const title = 'Sync ' + forgeBranchSlug(input.slugSeed) + ' from LOV-DEVIL Builder';
    const body = 'Automated project sync onto `' + branch + '`. This pull request does not commit directly to `' + defaultBranch + '`.';
    const open = await githubListOpenPulls(api, user.login, input.repoName, branch, defaultBranch);
    const existing = open.find(pr => pr.head === branch && pr.base === defaultBranch && pr.state === 'open');
    const pull = existing
      ? await githubUpdatePull(api, user.login, input.repoName, existing.number, { title, body })
      : await githubCreatePull(api, user.login, input.repoName, { title, head: branch, base: defaultBranch, body });

    return {
      ok: true,
      branch,
      commitSha: commit.sha,
      pullNumber: pull.number,
      pullUrl: pull.html_url,
      filesUploaded: files.length,
      repoFullName: repo.full_name,
      repoUrl: 'https://github.com/' + repo.full_name,
      repositoryId: repo.id,
      createdPull: !existing,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'github_unauthorized')
      return { ok: false, error: 'github_reauth_required' };
    if (error instanceof Error && error.message === 'default_branch_forbidden')
      return { ok: false, error: 'default_branch_forbidden' };
    void redactSecrets(error instanceof Error ? error.message : '');
    void writes;
    return { ok: false, error: 'github_write_failed' };
  }
}
