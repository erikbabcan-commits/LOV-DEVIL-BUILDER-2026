import { apiUrl } from '../../lib/api';

/** Client helper for forge-branch GitHub sync. Tokens never leave the server.
 * The Cloud BFF allow-list does not yet include export/sync (githubBff.ts is
 * outside this epic); callers that already hold a trusted same-origin path
 * can use `syncProjectToGitHub`.
 */
export type GitHubSyncSelection = {
  projectId: string;
  snapshotId: string;
  expectedRevision: number;
};

export type GitHubSyncSuccess = {
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
};

export type GitHubSyncFailure =
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
        | 'invalid_export_request'
        | 'github_write_failed'
        | 'github_repo_not_found'
        | 'github_not_connected'
        | 'github_export_not_configured'
        | 'default_branch_forbidden'
        | 'project_not_found'
        | 'project_deleted'
        | 'project_conflict'
        | 'snapshot_not_found'
        | 'invalid_sources'
        | 'invalid_selection';
    };

export type GitHubSyncResult = GitHubSyncSuccess | GitHubSyncFailure;

export async function syncProjectToGitHub(
  input: {
    repoName: string;
    slugSeed: string;
    selection: GitHubSyncSelection;
    checkpointSha?: string | null;
    confirmed: true;
  },
  init: { headers?: HeadersInit; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GitHubSyncResult> {
  const response = await (init.fetch ?? fetch)(apiUrl('/api/cloud-github/export/sync'), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    signal: init.signal,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => null)) as GitHubSyncResult | { error?: string } | null;
  if (!data || typeof data !== 'object') return { ok: false, error: 'github_write_failed' };
  if ('ok' in data && data.ok === true) return data;
  if ('ok' in data && data.ok === false) return data as GitHubSyncFailure;
  const code = (data as { error?: string }).error;
  if (code && code !== 'remote_changed')
    return { ok: false, error: code as Exclude<GitHubSyncFailure, { error: 'remote_changed' }>['error'] };
  return { ok: false, error: 'github_write_failed' };
}
