/** Client helper for forge-branch GitHub sync. Tokens never leave the server.
 *
 * Browser path (Bora W2 P3-4): same-origin POST to the Cloud BFF
 * `/api/github-connect/export/sync` with the Cloud identity as `Authorization:
 * Bearer …`. The BFF (server/integrations/githubBff.ts allow-list) validates
 * origin, JSON and body shape and adds the server-only bridge header before it
 * forwards to `/api/cloud-github/export/sync`. Calling that server route from a
 * browser always fails with 403 because it requires the bridge secret.
 * Not yet wired into a UI flow.
 */
export const GITHUB_SYNC_BFF_PATH = '/api/github-connect/export/sync';

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
        | 'invalid_selection'
        // BFF-level rejections (githubBff.ts)
        | 'cloud_identity_required'
        | 'origin_not_allowed'
        | 'json_required'
        | 'github_route_unavailable'
        | 'github_connection_failed'
        | 'github_connection_unavailable';
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
  init: { accessToken?: string; headers?: HeadersInit; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GitHubSyncResult> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (init.accessToken) headers.set('Authorization', 'Bearer ' + init.accessToken);
  // The BFF requires a Cloud identity; without it there is nothing to send.
  if (!headers.has('Authorization')) return { ok: false, error: 'cloud_identity_required' };
  // Same-origin BFF route on the UI host, deliberately not apiUrl(): the API host
  // has no BFF, and its server route rejects browsers without the bridge secret.
  const response = await (init.fetch ?? fetch)(GITHUB_SYNC_BFF_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: init.signal,
    headers,
    body: JSON.stringify({
      repoName: input.repoName,
      slugSeed: input.slugSeed,
      ...(input.checkpointSha !== undefined ? { checkpointSha: input.checkpointSha } : {}),
      confirmed: input.confirmed,
      selection: {
        projectId: input.selection.projectId,
        snapshotId: input.selection.snapshotId,
        expectedRevision: input.selection.expectedRevision,
      },
    }),
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
