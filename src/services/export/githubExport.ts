/* M4 PHASE B: GitHub repository export - BLOCKED
   
   Security principles:
   - NEVER embed tokens in client code
   - NEVER store tokens in localStorage or IndexedDB
   - NEVER include tokens in exported ZIPs
   - All GitHub API calls would happen on the server (IF implemented)
   - Require explicit user confirmation
   - Handle all error cases honestly
   
   BLOCKED state: GitHub export is BLOCKED because per-user OAuth authorization
   is NOT implemented. There is no bypass. ZIP export must remain functional.
   
   OAuth implementation is separate remaining work for M5+.
*/

/** GitHub repository creation request */
export interface GitHubExportRequest {
  repoName: string;
  description: string;
  isPrivate: boolean;
  files: Array<{ path: string; content: string }>;
}

/** GitHub repository creation response */
export interface GitHubExportResult {
  ok: boolean;
  repoUrl?: string;
  error?: string;
  errorType?: 'auth' | 'validation' | 'api' | 'conflict' | 'rate_limit';
}

/** Validates repository name */
export function isValidRepoName(name: string): boolean {
  // GitHub repo name rules:
  // - 1-100 characters
  // - Alphanumeric, hyphens, underscores
  // - Cannot start or end with hyphen
  // - Cannot contain consecutive hyphens
  // - Cannot be '.' or '..'
  
  if (!name || name.length < 1 || name.length > 100) return false;
  if (name === '.' || name === '..') return false;
  if (/^[\-.]/.test(name) || /[\-.]$/.test(name)) return false;
  if (/[^a-zA-Z0-9._-]/.test(name)) return false;
  if (name.includes('--')) return false;
  
  return true;
}

/** Validates GitHub export request before sending to server */
export function validateGitHubExport(
  repoName: string,
  files: Array<{ path: string; content: string }>
): { ok: boolean; error?: string } {
  if (!repoName) {
    return { ok: false, error: 'Repository name is required' };
  }
  
  if (!isValidRepoName(repoName)) {
    return { ok: false, error: 'Invalid repository name. Use alphanumeric characters, hyphens, or underscores (1-100 chars, no leading/trailing hyphens)' };
  }
  
  if (files.length === 0) {
    return { ok: false, error: 'No files to export' };
  }
  
  if (files.length > 100) {
    return { ok: false, error: `Too many files (${files.length} > 100)` };
  }
  
  // Check for reserved paths
  const reserved = new Set(['.git', '.github', 'node_modules', '.env', '.vscode']);
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.some(p => reserved.has(p))) {
      return { ok: false, error: `Reserved path: ${f.path}` };
    }
  }
  
  return { ok: true };
}

/**
 * Checks if GitHub export is available (server-side check)
 * 
 * Always returns BLOCKED because per-user OAuth is not implemented.
 */
export async function checkGitHubAvailable(): Promise<{ available: boolean; message: string; blocked: boolean; blockReason: string }> {
  // GitHub export is BLOCKED - per-user OAuth not implemented
  return {
    available: false,
    message: 'GitHub export is BLOCKED. Per-user OAuth authorization is not implemented.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  };
}

/**
 * Exports project to GitHub repository via server API
 * 
 * Always returns BLOCKED because per-user OAuth is not implemented.
 * This is intentional - we cannot create repositories without proper auth.
 */
export async function exportToGitHub(
  request: GitHubExportRequest,
  confirmed: boolean = false
): Promise<GitHubExportResult & { blocked: boolean; blockReason: string }> {
  // GitHub export is BLOCKED - per-user OAuth not implemented
  return {
    ok: false,
    error: 'GitHub export is BLOCKED. Per-user OAuth authorization is not implemented. Use ZIP export instead.',
    errorType: 'auth',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  };
}

/** GitHub authorization state */
export interface GitHubAuthState {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  message: string;
  blocked: boolean;
  blockReason: string;
}

/**
 * Checks GitHub authentication status
 * 
 * Always returns unauthenticated because OAuth is not implemented.
 */
export async function checkGitHubAuth(): Promise<GitHubAuthState> {
  return {
    authenticated: false,
    message: 'GitHub export is BLOCKED. Authentication not available.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  };
}

/**
 * Initiates GitHub OAuth flow - BLOCKED
 * 
 * OAuth flow is not implemented. Returns BLOCKED.
 */
export function initiateGitHubAuth(redirectPath?: string): void {
  // OAuth not implemented - cannot redirect
  // In a real implementation, this would redirect to server for auth
  console.warn('[GitHub Export] OAuth flow not implemented. GitHub export is BLOCKED.');
}

/**
 * Revokes GitHub authentication - BLOCKED
 * 
 * OAuth not implemented. Returns BLOCKED.
 */
export async function revokeGitHubAuth(): Promise<{ ok: boolean; error: string; blocked: boolean; blockReason: string }> {
  return {
    ok: false,
    error: 'GitHub OAuth revoke not implemented. GitHub export is BLOCKED.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  };
}
