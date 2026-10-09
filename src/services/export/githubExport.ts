/* M4 PHASE B: Real GitHub repository export
   
   Security principles:
   - NEVER embed tokens in client code
   - NEVER store tokens in localStorage or IndexedDB
   - NEVER include tokens in exported ZIPs
   - All GitHub API calls happen on the server
   - Require explicit user confirmation
   - Handle all error cases honestly
   
   BLOCKED state: When GITHUB_TOKEN is not available, report BLOCKED honestly.
   ZIP export must remain functional regardless of GitHub auth status.
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

/** Checks if GitHub export is available (server-side check) */
export async function checkGitHubAvailable(): Promise<{ available: boolean; message?: string; blocked?: boolean; blockReason?: string }> {
  try {
    const response = await fetch('/api/github/status');
    if (!response.ok) {
      return { available: false, message: 'GitHub integration not configured', blocked: true, blockReason: 'NETWORK_ERROR' };
    }
    const data = await response.json();
    return { 
      available: data.available === true, 
      message: data.message,
      blocked: data.blocked === true,
      blockReason: data.blockReason,
    };
  } catch {
    return { available: false, message: 'GitHub integration not available', blocked: true, blockReason: 'NETWORK_ERROR' };
  }
}

/** Exports project to GitHub repository via server API */
export async function exportToGitHub(
  request: GitHubExportRequest,
  confirmed: boolean = false
): Promise<GitHubExportResult & { blocked?: boolean; blockReason?: string; cleanupFailed?: boolean; orphanedRepo?: string }> {
  // Validate on client first
  const validation = validateGitHubExport(request.repoName, request.files);
  if (!validation.ok) {
    return { ok: false, error: validation.error, errorType: 'validation' };
  }
  
  // Require explicit confirmation
  if (!confirmed) {
    return { 
      ok: false, 
      error: 'User confirmation required. Call with confirmed=true to create repository.',
      errorType: 'validation',
      blocked: true,
      blockReason: 'CONFIRMATION_REQUIRED',
    };
  }
  
  try {
    const response = await fetch('/api/github/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, confirmed: true }),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      return {
        ok: false,
        error: result.error || 'GitHub export failed',
        errorType: result.errorType || 'api',
        blocked: result.blocked,
        blockReason: result.blockReason,
        cleanupFailed: result.cleanupFailed,
        orphanedRepo: result.orphanedRepo,
      };
    }
    
    return {
      ok: true,
      repoUrl: result.repoUrl,
      blocked: false,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${String(e)}`,
      errorType: 'api',
      blocked: true,
      blockReason: 'NETWORK_ERROR',
    };
  }
}

/** GitHub authorization state */
export interface GitHubAuthState {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  message?: string;
  blocked?: boolean;
  blockReason?: string;
}

/** Checks GitHub authentication status */
export async function checkGitHubAuth(): Promise<GitHubAuthState> {
  try {
    const response = await fetch('/api/github/auth');
    if (!response.ok) {
      return { authenticated: false, message: 'Network error', blocked: true, blockReason: 'NETWORK_ERROR' };
    }
    return await response.json();
  } catch {
    return { authenticated: false, message: 'Network error', blocked: true, blockReason: 'NETWORK_ERROR' };
  }
}

/** Initiates GitHub OAuth flow - redirects to server for auth */
export function initiateGitHubAuth(redirectPath?: string): void {
  const redirect = redirectPath ? encodeURIComponent(redirectPath) : encodeURIComponent(window.location.href);
  window.location.href = `/api/github/auth/start?redirect=${redirect}`;
}

/** Revokes GitHub authentication */
export async function revokeGitHubAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch('/api/github/auth/revoke', { method: 'POST' });
    if (!response.ok) {
      return { ok: false, error: 'Failed to revoke authentication' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
