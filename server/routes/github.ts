/* M4.G: Real GitHub OAuth Integration
   
   Security principles:
   - NEVER store tokens in client JavaScript, localStorage, or IndexedDB
   - All GitHub API calls happen on the server
   - Use HTTP-only, Secure, SameSite cookies for session management
   - Cryptographically secure state/CSRF protection
   - Least-privilege permissions (repo scope only)
   - Per-user session binding
   - No shared global tokens
   
   Flow:
   1. User clicks "Connect GitHub" -> redirects to /api/github/auth/start
   2. Server generates state token, stores in session, redirects to GitHub OAuth
   3. GitHub redirects back to /api/github/auth/callback with code
   4. Server validates state, exchanges code for token, stores in secure session
   5. User can now create repositories via /api/github/export
   6. Token refresh and revocation handled server-side
*/

import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import { isSafePath } from '../security/pathGuard';

const githubRouter = new Hono();

/* ==================== Configuration ==================== */

interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  appName?: string;
  callbackUrl: string;
}

function getGitHubConfig(): GitHubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_CALLBACK_URL || 'http://localhost:8787/api/github/auth/callback';
  
  if (!clientId || !clientSecret) {
    return null;
  }
  
  return { clientId, clientSecret, callbackUrl };
}

/* ==================== Session Management ==================== */

interface GitHubSession {
  userId: string;
  githubToken: string;
  githubTokenType: string;
  githubScopes: string;
  githubUsername: string;
  githubAvatarUrl?: string;
  createdAt: number;
  expiresAt: number;
  stateToken: string;
}

const sessions = new Map<string, GitHubSession>();

const SESSION_COOKIE_NAME = 'github_session_id';
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 86400,
  path: '/',
};

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateStateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function getSessionIdFromCookie(c: any): string | null {
  const cookie = c.req.header('Cookie') || '';
  // Parse cookie properly - handle multiple cookies separated by semicolons
  const cookies: Record<string, string> = {};
  cookie.split(';').forEach((part: string) => {
    const [key, value] = part.trim().split('=');
    if (key && value) {
      cookies[key] = value;
    }
  });
  return cookies[SESSION_COOKIE_NAME] || null;
}

function getSession(sessionId: string): GitHubSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function createSession(userId: string, token: string, tokenType: string, scopes: string, username: string, avatarUrl?: string): string {
  const sessionId = generateSessionId();
  const session: GitHubSession = {
    userId,
    githubToken: token,
    githubTokenType: tokenType,
    githubScopes: scopes,
    githubUsername: username,
    githubAvatarUrl: avatarUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400 * 1000,
    stateToken: generateStateToken(),
  };
  sessions.set(sessionId, session);
  return sessionId;
}

function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

function setSessionCookie(c: any, sessionId: string): void {
  // Build Set-Cookie header with proper serialization
  // HttpOnly is a flag (no value), SameSite needs its value, Secure is a flag
  const parts: string[] = [];
  parts.push(`${SESSION_COOKIE_NAME}=${sessionId}`);
  parts.push(`Max-Age=${SESSION_COOKIE_OPTIONS.maxAge}`);
  parts.push(`Path=${SESSION_COOKIE_OPTIONS.path}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${SESSION_COOKIE_OPTIONS.sameSite}`);
  if (SESSION_COOKIE_OPTIONS.secure) {
    parts.push('Secure');
  }
  c.header('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(c: any): void {
  c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

/* ==================== CSRF Protection ==================== */

function validateCsrfToken(c: any, session: GitHubSession | null): boolean {
  // For POST requests, require Origin header to match expected origin
  // and require session cookie to be present
  const origin = c.req.header('Origin');
  const expectedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  
  if (!origin || !expectedOrigins.includes(origin)) {
    return false;
  }
  
  // Session must exist
  if (!session) {
    return false;
  }
  
  return true;
}

/* ==================== GitHub API Helper ==================== */

interface GitHubApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

async function githubApiRequest<T>(
  token: string,
  method: string,
  url: string,
  body?: any
): Promise<GitHubApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    
    const data = await response.json().catch(() => ({}));
    
    if (!response.ok) {
      const errorMsg = data.message || 'GitHub API error';
      return {
        ok: false,
        error: errorMsg,
        status: response.status,
      };
    }
    
    return { ok: true, data: data as T };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${String(e)}`,
    };
  }
}

/* ==================== Routes ==================== */

// Check GitHub integration configuration
githubRouter.get('/api/github/status', (c) => {
  const config = getGitHubConfig();
  
  if (!config) {
    return c.json({
      available: false,
      configured: false,
      message: 'GitHub integration not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
      requiredEnv: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
      callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:8787/api/github/auth/callback',
      blocked: true,
      blockReason: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables are not configured',
    } as const);
  }
  
  return c.json({
    available: true,
    configured: true,
    message: 'GitHub OAuth configured',
    clientId: config.clientId.substring(0, 8) + '...',
    callbackUrl: config.callbackUrl,
    blocked: false,
  } as const);
});

// Check authentication status
githubRouter.get('/api/github/auth', (c) => {
  const config = getGitHubConfig();
  if (!config) {
    return c.json({
      authenticated: false,
      configured: false,
      message: 'GitHub integration not configured',
      blocked: true,
      blockReason: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables are not configured',
    } as const);
  }
  
  const sessionId = getSessionIdFromCookie(c);
  const session = sessionId ? getSession(sessionId) : null;
  
  if (!session) {
    return c.json({
      authenticated: false,
      configured: true,
      message: 'Not authenticated',
      blocked: false,
    } as const);
  }
  
  return c.json({
    authenticated: true,
    configured: true,
    username: session.githubUsername,
    avatarUrl: session.githubAvatarUrl,
    scopes: session.githubScopes.split(',').filter(Boolean),
    message: 'Authenticated',
    blocked: false,
  } as const);
});

// Start OAuth flow - returns HTTP 302 redirect to GitHub
githubRouter.get('/api/github/auth/start', (c) => {
  const config = getGitHubConfig();
  if (!config) {
    return c.json({
      ok: false,
      error: 'GitHub integration not configured',
      redirect: null,
    } as const);
  }
  
  const stateToken = generateStateToken();
  const sessionId = generateSessionId();
  
  const pendingSession: Partial<GitHubSession> = {
    stateToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600 * 1000,
  };
  sessions.set(sessionId, pendingSession as GitHubSession);
  
  setSessionCookie(c, sessionId);
  
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: 'repo',
    state: stateToken,
    allow_signup: 'false',
  });
  
  const githubAuthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
  
  // HTTP 302 redirect to GitHub OAuth
  return c.redirect(githubAuthUrl, 302);
});

// OAuth callback
githubRouter.get('/api/github/auth/callback', async (c) => {
  const config = getGitHubConfig();
  if (!config) {
    return c.json({
      ok: false,
      error: 'GitHub integration not configured',
    } as const);
  }
  
  const query = c.req.query();
  const code = query.code as string;
  const state = query.state as string;
  const error = query.error as string;
  const errorDescription = query.error_description as string;
  
  if (error) {
    return c.json({
      ok: false,
      error: errorDescription || error || 'GitHub OAuth failed',
    } as const);
  }
  
  if (!code || !state) {
    return c.json({
      ok: false,
      error: 'Missing code or state in callback',
    } as const);
  }
  
  const sessionId = getSessionIdFromCookie(c);
  if (!sessionId) {
    return c.json({
      ok: false,
      error: 'No session found. Please restart the authentication flow.',
    } as const);
  }
  
  const pendingSession = getSession(sessionId);
  if (!pendingSession || !pendingSession.stateToken) {
    return c.json({
      ok: false,
      error: 'Invalid or expired session. Please restart the authentication flow.',
    } as const);
  }
  
  if (pendingSession.stateToken !== state) {
    return c.json({
      ok: false,
      error: 'Invalid state token. CSRF protection failed.',
    } as const);
  }
  
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
      }),
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenResponse.ok || tokenData.error) {
      return c.json({
        ok: false,
        error: tokenData.error_description || tokenData.error || 'Failed to exchange code for token',
      } as const);
    }
    
    const accessToken = tokenData.access_token;
    const tokenType = tokenData.token_type || 'bearer';
    const scopes = tokenData.scope || 'repo';
    
    if (!accessToken) {
      return c.json({
        ok: false,
        error: 'No access token received from GitHub',
      } as const);
    }
    
    const userResult = await githubApiRequest<any>(accessToken, 'GET', 'https://api.github.com/user');
    if (!userResult.ok || !userResult.data) {
      return c.json({
        ok: false,
        error: userResult.error || 'Failed to get user info',
      } as const);
    }
    
    const username = userResult.data.login;
    const avatarUrl = userResult.data.avatar_url;
    const userId = String(userResult.data.id);
    
    const newSessionId = createSession(
      userId,
      accessToken,
      tokenType,
      scopes,
      username,
      avatarUrl
    );
    
    sessions.delete(sessionId);
    setSessionCookie(c, newSessionId);
    
    // Redirect back to frontend with session cookie
    // The frontend will detect the authenticated state via /api/github/auth
    return c.redirect('http://localhost:5173?github_auth=success', 302);
  } catch (e) {
    console.error('[GitHub OAuth] Callback error:', e);
    return c.json({
      ok: false,
      error: 'Internal server error during authentication',
    } as const);
  }
});

// Revoke authentication
githubRouter.post('/api/github/auth/revoke', (c) => {
  const sessionId = getSessionIdFromCookie(c);
  const session = sessionId ? getSession(sessionId) : null;
  
  // CSRF protection: validate Origin header
  if (!validateCsrfToken(c, session)) {
    return c.json({
      ok: false,
      error: 'Invalid CSRF token',
    } as const);
  }
  
  if (!sessionId) {
    return c.json({
      ok: false,
      error: 'No active session',
    } as const);
  }
  
  deleteSession(sessionId);
  clearSessionCookie(c);
  
  return c.json({
    ok: true,
    message: 'Successfully disconnected from GitHub (local session only)',
  } as const);
});

/* ==================== Repository Export ==================== */

const GitHubExportSchema = z.object({
  repoName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().optional().default(true),
  files: z.array(z.object({
    path: z.string().min(1).max(255),
    content: z.string().max(10_000_000),
  })).max(100),
  confirmed: z.boolean().optional().default(false),
});

githubRouter.post('/api/github/export', async (c) => {
  const config = getGitHubConfig();
  if (!config) {
    return c.json({
      ok: false,
      error: 'GitHub integration not configured',
      errorType: 'config',
    } as const);
  }
  
  const sessionId = getSessionIdFromCookie(c);
  const session = sessionId ? getSession(sessionId) : null;
  
  if (!session) {
    return c.json({
      ok: false,
      error: 'Not authenticated. Please connect GitHub first.',
      errorType: 'auth',
    } as const);
  }
  
  // CSRF protection: validate Origin header
  if (!validateCsrfToken(c, session)) {
    return c.json({
      ok: false,
      error: 'Invalid CSRF token',
      errorType: 'auth',
    } as const);
  }
  
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      ok: false,
      error: 'Invalid JSON body',
      errorType: 'validation',
    } as const);
  }
  
  const parsed = GitHubExportSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid export data',
      errorType: 'validation',
      issues: parsed.error.issues.slice(0, 5),
    } as const);
  }
  
  const { repoName, description, isPrivate, files, confirmed } = parsed.data;
  
  if (!confirmed) {
    return c.json({
      ok: false,
      error: 'User confirmation required',
      errorType: 'validation',
    } as const);
  }
  
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(repoName)) {
    return c.json({
      ok: false,
      error: 'Invalid repository name',
      errorType: 'validation',
    } as const);
  }
  
  const reserved = new Set(['.git', '.github', 'node_modules', '.env', '.vscode']);
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.some(p => reserved.has(p))) {
      return c.json({
        ok: false,
        error: `Reserved path: ${f.path}`,
        errorType: 'validation',
      } as const);
    }
    if (!isSafePath(f.path)) {
      return c.json({
        ok: false,
        error: `Unsafe path: ${f.path}`,
        errorType: 'validation',
      } as const);
    }
  }
  
  const secretPatterns = [
    /MISTRAL_API_KEY\s*[=:]/,
    /GITHUB_TOKEN\s*[=:]/,
    /NPM_TOKEN\s*[=:]/,
    /aws_access_key_id\s*[=:]/i,
    /aws_secret_access_key\s*[=:]/i,
    /private[_-]?key\s*[=:]/i,
    /password\s*[=:]/i,
    /api[_-]?key\s*[=:]/i,
    /secret\s*[=:]/i,
  ];
  
  for (const f of files) {
    for (const pattern of secretPatterns) {
      if (pattern.test(f.content)) {
        return c.json({
          ok: false,
          error: `Potential secret detected in ${f.path}`,
          errorType: 'validation',
        } as const);
      }
    }
  }
  
  try {
    const token = session.githubToken;
    const username = session.githubUsername;
    
    const repoCheck = await githubApiRequest<any>(token, 'GET', `https://api.github.com/repos/${username}/${repoName}`);
    if (repoCheck.ok) {
      return c.json({
        ok: false,
        error: `Repository '${username}/${repoName}' already exists`,
        errorType: 'conflict',
      } as const);
    }
    
    const repoResponse = await githubApiRequest<any>(token, 'POST', 'https://api.github.com/user/repos', {
      name: repoName,
      description: description || 'Exported from LOV-DEVIL AI Builder',
      private: isPrivate,
      auto_init: true,
    });
    
    if (!repoResponse.ok) {
      return c.json({
        ok: false,
        error: repoResponse.error || 'Failed to create repository',
        errorType: 'api',
      } as const);
    }
    
    const repo = repoResponse.data;
    const repoFullName = repo.full_name;
    const defaultBranch = repo.default_branch || 'main';
    
    const initialCommitResponse = await githubApiRequest<any>(
      token,
      'GET',
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${defaultBranch}`
    );
    
    if (!initialCommitResponse.ok) {
      return c.json({
        ok: false,
        error: 'Failed to get initial repository state',
        errorType: 'api',
      } as const);
    }
    
    const initialRef = initialCommitResponse.data;
    const initialCommitSha = initialRef.object.sha;
    
    const initialTreeResponse = await githubApiRequest<any>(
      token,
      'GET',
      `https://api.github.com/repos/${repoFullName}/git/trees/${initialCommitSha}`
    );
    
    if (!initialTreeResponse.ok) {
      return c.json({
        ok: false,
        error: 'Failed to get initial tree',
        errorType: 'api',
      } as const);
    }
    
    const initialTree = initialTreeResponse.data;
    const treeEntries: Array<{ path: string; mode: string; type: string; sha?: string; content?: string }> = [];
    
    // Track paths to detect duplicates
    const existingPaths = new Set<string>();
    
    // Add existing files from initial commit (README.md, etc.)
    for (const entry of initialTree.tree) {
      if (entry.type === 'blob') {
        existingPaths.add(entry.path);
        treeEntries.push({
          path: entry.path,
          mode: entry.mode,
          type: 'blob',
          sha: entry.sha,
        });
      }
    }
    
    // Add new files, replacing any existing ones
    for (const f of files) {
      // If file exists in initial tree, remove the old entry and add new one
      const existingIndex = treeEntries.findIndex(e => e.path === f.path);
      if (existingIndex >= 0) {
        treeEntries.splice(existingIndex, 1);
      }
      treeEntries.push({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content,
      });
    }
    
    const newTreeResponse = await githubApiRequest<any>(
      token,
      'POST',
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      { tree: treeEntries }
    );
    
    if (!newTreeResponse.ok) {
      return c.json({
        ok: false,
        error: newTreeResponse.error || 'Failed to create tree',
        errorType: 'api',
      } as const);
    }
    
    const newTree = newTreeResponse.data;
    
    const commitResponse = await githubApiRequest<any>(
      token,
      'POST',
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      {
        message: 'Initial commit - exported from LOV-DEVIL AI Builder',
        tree: newTree.sha,
        parents: [initialCommitSha],
      }
    );
    
    if (!commitResponse.ok) {
      return c.json({
        ok: false,
        error: commitResponse.error || 'Failed to create commit',
        errorType: 'api',
      } as const);
    }
    
    const newCommit = commitResponse.data;
    
    const refUpdateResponse = await githubApiRequest<any>(
      token,
      'PATCH',
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${defaultBranch}`,
      { sha: newCommit.sha }
    );
    
    if (!refUpdateResponse.ok) {
      return c.json({
        ok: false,
        error: refUpdateResponse.error || 'Failed to update branch reference',
        errorType: 'api',
      } as const);
    }
    
    const verifyResponse = await githubApiRequest<any>(
      token,
      'GET',
      `https://api.github.com/repos/${repoFullName}`
    );
    
    if (!verifyResponse.ok) {
      return c.json({
        ok: false,
        error: 'Failed to verify repository creation',
        errorType: 'api',
      } as const);
    }
    
    const branchVerifyResponse = await githubApiRequest<any>(
      token,
      'GET',
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${defaultBranch}`
    );
    
    if (!branchVerifyResponse.ok || branchVerifyResponse.data?.object?.sha !== newCommit.sha) {
      return c.json({
        ok: false,
        error: 'Branch does not point to expected commit',
        errorType: 'api',
      } as const);
    }
    
    return c.json({
      ok: true,
      repoUrl: verifyResponse.data.html_url,
      repoFullName,
      defaultBranch,
      commitSha: newCommit.sha,
      fileCount: files.length,
      message: 'Repository created successfully',
    } as const);
  } catch (e) {
    console.error('[GitHub Export] Error:', e);
    return c.json({
      ok: false,
      error: 'Internal server error',
      errorType: 'api',
    } as const);
  }
});

export { githubRouter };
