/* M4.G: Real GitHub repository export
   
   Security principles:
   - NEVER embed tokens in client code
   - NEVER store tokens in localStorage or IndexedDB
   - NEVER include tokens in exported ZIPs
   - All GitHub API calls happen on the server
   - Require explicit user confirmation
   - Handle all error cases honestly
   
   Flow:
   1. User clicks "Connect GitHub" -> server redirect to GitHub OAuth
   2. GitHub redirects back to server callback
   3. Server validates state, exchanges code for token, stores in secure session
   4. Client checks auth status via /api/github/auth
   5. User can now create repositories via /api/github/export
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
  errorType?: 'auth' | 'validation' | 'api' | 'conflict' | 'rate_limit' | 'config';
  blocked?: boolean;
  blockReason?: string;
}

/** GitHub authentication state */
export interface GitHubAuthState {
  authenticated: boolean;
  configured: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  csrfToken?: string;
  message?: string;
  blocked?: boolean;
  blockReason?: string;
}

/** Validates repository name */
export function isValidRepoName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 100) return false;
  if (name === '.' || name === '..') return false;
  if (/^[.-]/.test(name) || /[.-]$/.test(name)) return false;
  if (/[^a-zA-Z0-9._-]/.test(name)) return false;
  if (name.includes('--')) return false;
  return true;
}

/** Validates GitHub export request */
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
  const reserved = new Set(['.git', '.github', 'node_modules', '.env', '.vscode']);
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.some(p => reserved.has(p))) {
      return { ok: false, error: `Reserved path: ${f.path}` };
    }
  }
  return { ok: true };
}

/** Checks if GitHub integration is configured */
export async function checkGitHubAvailable(): Promise<{
  available: boolean;
  configured: boolean;
  message: string;
  callbackUrl?: string;
  requiredEnv?: string[];
  blocked?: boolean;
  blockReason?: string;
}> {
  try {
    const response = await fetch('/api/github/status');
    if (!response.ok) {
      return {
        available: false,
        configured: false,
        message: 'GitHub integration not available',
      };
    }
    return await response.json();
  } catch {
    return {
      available: false,
      configured: false,
      message: 'GitHub integration not available',
    };
  }
}

/** Checks GitHub authentication status */
export async function checkGitHubAuth(): Promise<GitHubAuthState> {
  try {
    const response = await fetch('/api/github/auth');
    if (!response.ok) {
      return {
        authenticated: false,
        configured: false,
        message: 'Not authenticated',
      };
    }
    return await response.json();
  } catch {
    return {
      authenticated: false,
      configured: false,
      message: 'Not authenticated',
    };
  }
}

/** Initiates GitHub OAuth flow - redirects to server (returns HTTP 302) */
export function initiateGitHubAuth(): void {
  // The server endpoint /api/github/auth/start returns HTTP 302 redirect to GitHub
  // We can use a simple fetch that follows redirects, or just navigate directly
  // Using window.location for simplicity - the server will redirect via HTTP 302
  window.location.href = '/api/github/auth/start';
}

/** Revokes GitHub authentication */
export async function revokeGitHubAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const auth = await checkGitHubAuth();
    if (!auth.authenticated || !auth.csrfToken) return { ok: false, error: 'Not authenticated' };
    const response = await fetch('/api/github/auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { ok: false, error: data.error || 'Failed to revoke authentication' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Exports project to GitHub repository */
export async function exportToGitHub(
  request: GitHubExportRequest,
  confirmed: boolean = false
): Promise<GitHubExportResult> {
  // Validate on client first
  const validation = validateGitHubExport(request.repoName, request.files);
  if (!validation.ok) {
    return { ok: false, error: validation.error, errorType: 'validation' };
  }
  
  // Require explicit confirmation
  if (!confirmed) {
    return {
      ok: false,
      error: 'User confirmation required',
      errorType: 'validation',
    };
  }
  
  try {
    const auth = await checkGitHubAuth();
    if (!auth.authenticated || !auth.csrfToken) {
      return { ok: false, error: 'Not authenticated', errorType: 'auth' };
    }
    const response = await fetch('/api/github/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken },
      body: JSON.stringify({ ...request, confirmed: true }),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      return {
        ok: false,
        error: result.error || 'GitHub export failed',
        errorType: result.errorType || 'api',
      };
    }
    
    return {
      ok: true,
      repoUrl: result.repoUrl,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${String(e)}`,
      errorType: 'api',
    };
  }
}
