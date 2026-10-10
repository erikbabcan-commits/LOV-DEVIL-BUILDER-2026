import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';

const githubRouter = new Hono();
const SESSION_COOKIE_NAME = 'github_session_id';
const PENDING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_API = 'https://api.github.com';

interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  appUrl: string;
  scope: 'repo' | 'public_repo';
}

interface PendingSession {
  kind: 'pending';
  stateToken: string;
  expiresAt: number;
}

interface AuthenticatedSession {
  kind: 'authenticated';
  githubToken: string;
  githubScopes: string[];
  githubUsername: string;
  githubAvatarUrl?: string;
  csrfToken: string;
  expiresAt: number;
}

type GitHubSession = PendingSession | AuthenticatedSession;
const sessions = new Map<string, GitHubSession>();

function configuredUrl(value: string | undefined, fallback: string): string | null {
  try {
    const parsed = new URL(value || fallback);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function getGitHubConfig(): GitHubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackUrl = configuredUrl(process.env.GITHUB_CALLBACK_URL, 'http://localhost:8787/api/github/auth/callback');
  const appUrl = configuredUrl(process.env.LOV_APP_URL, 'http://localhost:5173/');
  const scope = process.env.GITHUB_OAUTH_SCOPE === 'public_repo' ? 'public_repo' : 'repo';
  return clientId && clientSecret && callbackUrl && appUrl ? { clientId, clientSecret, callbackUrl, appUrl, scope } : null;
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getSession(id: string | undefined): GitHubSession | null {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function cookieIsSecure(config: GitHubConfig): boolean {
  return new URL(config.callbackUrl).protocol === 'https:';
}

function setSessionCookie(c: Context, id: string, config: GitHubConfig): void {
  setCookie(c, SESSION_COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: cookieIsSecure(config),
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  });
}

function clearSessionCookie(c: Context, config: GitHubConfig): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: cookieIsSecure(config),
    path: '/',
  });
}

function redirectToApp(c: Context, config: GitHubConfig, result: 'connected' | 'error') {
  const target = new URL(config.appUrl);
  target.searchParams.set('github', result);
  return c.redirect(target.toString(), 302);
}

interface GitHubApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

async function githubApiRequest<T>(token: string, method: string, url: string, body?: unknown): Promise<GitHubApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, error: typeof data.message === 'string' ? data.message : 'GitHub API error', status: response.status };
    }
    return { ok: true, data: data as T, status: response.status };
  } catch (error) {
    return { ok: false, error: `GitHub network error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function authenticatedSession(c: Context): { id: string; session: AuthenticatedSession } | null {
  const id = getCookie(c, SESSION_COOKIE_NAME);
  const session = getSession(id);
  return id && session?.kind === 'authenticated' ? { id, session } : null;
}

function csrfMatches(c: Context, session: AuthenticatedSession): boolean {
  const supplied = c.req.header('X-CSRF-Token') || '';
  return supplied.length > 0 && constantTimeEqual(supplied, session.csrfToken);
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

githubRouter.get('/api/github/status', (c) => {
  const config = getGitHubConfig();
  if (!config) {
    return c.json({ available: false, configured: false, message: 'GitHub integration not configured.', requiredEnv: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], blocked: true, blockReason: 'GitHub OAuth environment is incomplete or invalid' } as const);
  }
  return c.json({
    available: true,
    configured: true,
    message: config.scope === 'repo'
      ? 'Classic OAuth repo scope grants broad repository access, including private repositories.'
      : 'OAuth is restricted to public repositories.',
    callbackUrl: config.callbackUrl,
    scope: config.scope,
    blocked: false,
  } as const);
});

githubRouter.get('/api/github/auth', (c) => {
  const config = getGitHubConfig();
  if (!config) return c.json({ authenticated: false, configured: false, message: 'GitHub integration not configured', blocked: true } as const);
  const found = authenticatedSession(c);
  if (!found) {
    if (getCookie(c, SESSION_COOKIE_NAME)) clearSessionCookie(c, config);
    return c.json({ authenticated: false, configured: true, message: 'Not authenticated', blocked: false } as const);
  }
  return c.json({ authenticated: true, configured: true, username: found.session.githubUsername, avatarUrl: found.session.githubAvatarUrl, scopes: found.session.githubScopes, csrfToken: found.session.csrfToken, message: 'Authenticated', blocked: false } as const);
});

githubRouter.get('/api/github/auth/start', (c) => {
  const config = getGitHubConfig();
  if (!config) return c.json({ ok: false, error: 'GitHub integration not configured' } as const, 503);
  const stateToken = randomToken();
  const sessionId = randomToken();
  sessions.set(sessionId, { kind: 'pending', stateToken, expiresAt: Date.now() + PENDING_TTL_MS });
  setSessionCookie(c, sessionId, config);
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl, scope: config.scope, state: stateToken, allow_signup: 'false' });
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`, 302);
});

githubRouter.get('/api/github/auth/callback', async (c) => {
  const config = getGitHubConfig();
  if (!config) return c.json({ ok: false, error: 'GitHub integration not configured' } as const, 503);
  const { code, state, error } = c.req.query();
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  const pending = getSession(sessionId);
  if (error || !code || !state || !sessionId || pending?.kind !== 'pending' || !constantTimeEqual(pending.stateToken, state)) {
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(c, config);
    return redirectToApp(c, config, 'error');
  }

  // Consume state before external I/O so callback replay always fails closed.
  sessions.delete(sessionId);
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.callbackUrl }),
    });
    const tokenData = await tokenResponse.json() as { access_token?: string; token_type?: string; scope?: string; error?: string };
    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) return redirectToApp(c, config, 'error');
    const userResult = await githubApiRequest<{ id: number; login: string; avatar_url?: string }>(tokenData.access_token, 'GET', `${GITHUB_API}/user`);
    if (!userResult.ok || !userResult.data?.login || !userResult.data.id) return redirectToApp(c, config, 'error');

    const newSessionId = randomToken();
    sessions.set(newSessionId, {
      kind: 'authenticated',
      githubToken: tokenData.access_token,
      githubScopes: (tokenData.scope || config.scope).split(',').map((scope) => scope.trim()).filter(Boolean),
      githubUsername: userResult.data.login,
      githubAvatarUrl: userResult.data.avatar_url,
      csrfToken: randomToken(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    setSessionCookie(c, newSessionId, config);
    return redirectToApp(c, config, 'connected');
  } catch {
    return redirectToApp(c, config, 'error');
  }
});

githubRouter.post('/api/github/auth/revoke', (c) => {
  const config = getGitHubConfig();
  if (!config) return c.json({ ok: false, error: 'GitHub integration not configured' } as const, 503);
  const found = authenticatedSession(c);
  if (!found) return c.json({ ok: false, error: 'No active session' } as const, 401);
  if (!csrfMatches(c, found.session)) return c.json({ ok: false, error: 'Invalid CSRF token' } as const, 403);
  sessions.delete(found.id);
  clearSessionCookie(c, config);
  return c.json({ ok: true, message: 'Successfully disconnected from GitHub' } as const);
});

const GitHubExportSchema = z.object({
  repoName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().optional().default(true),
  files: z.array(z.object({ path: z.string().min(1).max(255), content: z.string().max(200_000) })).min(1).max(40),
  confirmed: z.literal(true),
});

githubRouter.post('/api/github/export', async (c) => {
  const config = getGitHubConfig();
  if (!config) return c.json({ ok: false, error: 'GitHub integration not configured', errorType: 'config' } as const, 503);
  const found = authenticatedSession(c);
  if (!found) return c.json({ ok: false, error: 'Not authenticated. Please connect GitHub first.', errorType: 'auth' } as const, 401);
  if (!csrfMatches(c, found.session)) return c.json({ ok: false, error: 'Invalid CSRF token', errorType: 'auth' } as const, 403);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body', errorType: 'validation' } as const, 400); }
  const parsed = GitHubExportSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid export data', errorType: 'validation' } as const, 400);
  const { repoName, description, isPrivate, files } = parsed.data;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/.test(repoName)) return c.json({ ok: false, error: 'Invalid repository name', errorType: 'validation' } as const, 400);
  if (isPrivate && !found.session.githubScopes.includes('repo')) {
    return c.json({ ok: false, error: 'Private repository export requires the broad classic OAuth repo scope', errorType: 'auth' } as const, 403);
  }

  const reserved = new Set(['.git', '.github', 'node_modules', '.env', '.vscode']);
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafePath(file.path) || file.path.split('/').some((part) => reserved.has(part)) || seen.has(file.path)) {
      return c.json({ ok: false, error: `Unsafe, reserved, or duplicate path: ${file.path}`, errorType: 'validation' } as const, 400);
    }
    seen.add(file.path);
  }
  const size = withinSizeLimits(files);
  if (!size.ok) return c.json({ ok: false, error: size.reason || 'Export exceeds size limits', errorType: 'validation' } as const, 400);
  const secretPattern = /(MISTRAL_API_KEY|GITHUB_TOKEN|NPM_TOKEN|aws_(?:access_key_id|secret_access_key)|private[_-]?key|password|api[_-]?key|secret)\s*[=:]/i;
  const secretFile = files.find((file) => secretPattern.test(file.content));
  if (secretFile) return c.json({ ok: false, error: `Potential secret detected in ${secretFile.path}`, errorType: 'validation' } as const, 400);

  const { githubToken: token, githubUsername: username } = found.session;
  const repositoryUrl = `${GITHUB_API}/repos/${encodeURIComponent(username)}/${encodeURIComponent(repoName)}`;
  const existing = await githubApiRequest<unknown>(token, 'GET', repositoryUrl);
  if (existing.ok) return c.json({ ok: false, error: `Repository '${username}/${repoName}' already exists`, errorType: 'conflict' } as const, 409);
  if (existing.status !== 404) return c.json({ ok: false, error: existing.error || 'Unable to verify repository availability', errorType: 'api' } as const, 502);

  const created = await githubApiRequest<{ full_name: string; html_url: string; default_branch?: string; owner?: { login?: string } }>(token, 'POST', `${GITHUB_API}/user/repos`, { name: repoName, description: description || 'Exported from LOV-DEVIL AI Builder', private: isPrivate, auto_init: true });
  if (!created.ok || !created.data) return c.json({ ok: false, error: created.error || 'Failed to create repository', errorType: 'api' } as const, 502);
  const repo = created.data;
  if (repo.full_name.toLowerCase() !== `${username}/${repoName}`.toLowerCase() || repo.owner?.login?.toLowerCase() !== username.toLowerCase()) {
    return c.json({ ok: false, error: 'GitHub returned a repository not owned by the authenticated user', errorType: 'api' } as const, 502);
  }

  const branch = repo.default_branch || 'main';
  const ref = await githubApiRequest<{ object?: { sha?: string } }>(token, 'GET', `${GITHUB_API}/repos/${repo.full_name}/git/ref/heads/${branch}`);
  const parentCommitSha = ref.data?.object?.sha;
  if (!ref.ok || !parentCommitSha) return c.json({ ok: false, error: 'Failed to get initial repository reference', errorType: 'api' } as const, 502);
  const parentCommit = await githubApiRequest<{ tree?: { sha?: string } }>(token, 'GET', `${GITHUB_API}/repos/${repo.full_name}/git/commits/${parentCommitSha}`);
  const baseTreeSha = parentCommit.data?.tree?.sha;
  if (!parentCommit.ok || !baseTreeSha) return c.json({ ok: false, error: 'Failed to resolve initial commit tree', errorType: 'api' } as const, 502);

  const tree = await githubApiRequest<{ sha?: string }>(token, 'POST', `${GITHUB_API}/repos/${repo.full_name}/git/trees`, {
    base_tree: baseTreeSha,
    tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
  });
  if (!tree.ok || !tree.data?.sha) return c.json({ ok: false, error: tree.error || 'Failed to create tree', errorType: 'api' } as const, 502);
  const commit = await githubApiRequest<{ sha?: string }>(token, 'POST', `${GITHUB_API}/repos/${repo.full_name}/git/commits`, { message: 'Export project from LOV-DEVIL AI Builder', tree: tree.data.sha, parents: [parentCommitSha] });
  if (!commit.ok || !commit.data?.sha) return c.json({ ok: false, error: commit.error || 'Failed to create commit', errorType: 'api' } as const, 502);
  const updated = await githubApiRequest<unknown>(token, 'PATCH', `${GITHUB_API}/repos/${repo.full_name}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: false });
  if (!updated.ok) return c.json({ ok: false, error: updated.error || 'Failed to update branch reference', errorType: 'api' } as const, 502);

  const verifyRef = await githubApiRequest<{ object?: { sha?: string } }>(token, 'GET', `${GITHUB_API}/repos/${repo.full_name}/git/ref/heads/${branch}`);
  if (!verifyRef.ok || verifyRef.data?.object?.sha !== commit.data.sha) return c.json({ ok: false, error: 'Repository branch verification failed', errorType: 'api' } as const, 502);
  const verifyTree = await githubApiRequest<{ tree?: Array<{ path?: string; type?: string; sha?: string }>; truncated?: boolean }>(token, 'GET', `${GITHUB_API}/repos/${repo.full_name}/git/trees/${tree.data.sha}?recursive=1`);
  if (!verifyTree.ok || verifyTree.data?.truncated) return c.json({ ok: false, error: 'Repository file verification failed', errorType: 'api' } as const, 502);
  const blobs = new Map((verifyTree.data?.tree || []).filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
  const mismatch = files.find((file) => blobs.get(file.path) !== gitBlobSha(file.content));
  if (mismatch) return c.json({ ok: false, error: `Repository file verification failed: ${mismatch.path}`, errorType: 'api' } as const, 502);
  return c.json({ ok: true, repoUrl: repo.html_url, repoFullName: repo.full_name, defaultBranch: branch, commitSha: commit.data.sha, filesUploaded: files.length } as const);
});

export { githubRouter };
