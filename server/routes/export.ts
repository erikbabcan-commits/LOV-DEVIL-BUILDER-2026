/* M4 PHASE A & B: Server-side export routes
   
   ZIP Export: Server validates export requests (download happens client-side)
   GitHub Export: BLOCKED - per-user OAuth authorization not implemented
   
   Security: All sensitive operations happen on the server
   - GitHub tokens NEVER exposed to client
   - Path validation on server
   - Rate limiting
   - GitHub export is BLOCKED until proper OAuth is implemented
*/

import { Hono } from 'hono';
import { z } from 'zod';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';

const exportRouter = new Hono();

/* ---------- ZIP Export Validation (server-side) ---------- */

const ZipExportSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).max(255),
    content: z.string().max(10_000_000), // 10MB per file
  })).max(200), // Max 200 files
});

exportRouter.post('/api/export/validate', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = ZipExportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid export data' }, 400);
    }
    
    const { files } = parsed.data;
    
    // Validate paths
    for (const f of files) {
      if (!isSafePath(f.path)) {
        return c.json({ ok: false, error: `Unsafe path: ${f.path}` }, 400);
      }
    }
    
    // Validate size
    const size = withinSizeLimits(files.map(f => ({ path: f.path, content: f.content })));
    if (!size.ok) {
      return c.json({ ok: false, error: size.reason }, 400);
    }
    
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: 'Invalid request' }, 400);
  }
});

/* ---------- GitHub Export Routes - BLOCKED ---------- */

// GitHub auth state
interface GitHubAuthState {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
}

/**
 * GitHub export is BLOCKED.
 * 
 * REASON: Per-user OAuth authorization flow is not implemented.
 * This is a security requirement - we cannot create repositories
 * without proper user identity binding and session management.
 * 
 * All GitHub export endpoints return BLOCKED until OAuth is implemented.
 * ZIP export remains fully functional.
 */

// Check if GitHub integration is configured - always BLOCKED
exportRouter.get('/api/github/status', (c) => {
  return c.json({
    available: false,
    message: 'GitHub export is BLOCKED. Per-user OAuth authorization is not implemented.',
    configured: false,
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  });
});

// Check authentication status - always unauthenticated
exportRouter.get('/api/github/auth', (c) => {
  return c.json({
    authenticated: false,
    message: 'GitHub export is BLOCKED. Authentication not available.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  } as GitHubAuthState & { message: string; blocked: boolean; blockReason: string });
});

// OAuth flow start - BLOCKED
exportRouter.get('/api/github/auth/start', (c) => {
  return c.json({
    ok: false,
    error: 'GitHub OAuth is BLOCKED. Per-user authorization flow not implemented.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  }, 403);
});

// OAuth callback - BLOCKED
exportRouter.get('/api/github/auth/callback', (c) => {
  return c.json({
    ok: false,
    error: 'GitHub OAuth callback not implemented.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  }, 501);
});

// OAuth revoke - BLOCKED
exportRouter.post('/api/github/auth/revoke', (c) => {
  return c.json({
    ok: false,
    error: 'GitHub OAuth revoke not implemented.',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  }, 501);
});

// GitHub export schema
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

/**
 * GitHub export endpoint - BLOCKED
 * 
 * Per-user OAuth authorization is NOT implemented.
 * We cannot create repositories without:
 * - Session management
 * - User identity binding
 * - Secure token storage
 * - CSRF protection
 * - State validation
 * - Least-privilege permissions
 * 
 * Returns BLOCKED regardless of environment variables or credentials.
 * This is intentional and required for security.
 */
exportRouter.post('/api/github/export', async (c) => {
  // BLOCKED: Per-user OAuth authorization is not implemented
  // This is a security requirement - no bypass allowed
  return c.json({
    ok: false,
    error: 'GitHub export is BLOCKED. Per-user OAuth authorization is not implemented. Use ZIP export instead.',
    errorType: 'auth',
    blocked: true,
    blockReason: 'NO_PER_USER_OAUTH_IMPLEMENTED',
  }, 403);
});

export { exportRouter };
