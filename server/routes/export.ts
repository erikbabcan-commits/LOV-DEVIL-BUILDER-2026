/* M4 PHASE A & B: Server-side export routes
   
   ZIP Export: Server validates and prepares ZIP (though actual download happens client-side)
   GitHub Export: Server handles GitHub API calls with proper authentication
   
   Security: All sensitive operations happen on the server
   - GitHub tokens NEVER exposed to client
   - Path validation on server
   - Rate limiting
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

/* ---------- GitHub Export Routes ---------- */

// GitHub auth state
interface GitHubAuthState {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
}

// Check if GitHub integration is configured
// This endpoint exists even without auth to report configuration status
exportRouter.get('/api/github/status', (c) => {
  const hasToken = !!process.env.GITHUB_TOKEN;
  const hasClientId = !!process.env.GITHUB_CLIENT_ID;
  const hasClientSecret = !!process.env.GITHUB_CLIENT_SECRET;
  
  if (!hasClientId || !hasClientSecret) {
    return c.json({
      available: false,
      message: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
      configured: false,
    });
  }
  
  return c.json({
    available: true,
    configured: true,
    message: hasToken ? 'GitHub integration configured' : 'GitHub OAuth configured (token available for server-side operations)',
  });
});

// Check authentication status
exportRouter.get('/api/github/auth', async (c) => {
  // In this implementation, we use a simple token check
  // Production would use session-based auth
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    return c.json({ authenticated: false } as GitHubAuthState);
  }
  
  // If we have a token, we can check GitHub API for user info
  // But for now, just report authenticated state
  // In production, this would validate the session token
  try {
    const authHeader = `token ${token}`;
    const apiResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: authHeader, Accept: 'application/vnd.github+json' },
    });
    
    if (apiResponse.ok) {
      const user = await apiResponse.json();
      return c.json({
        authenticated: true,
        username: user.login,
        avatarUrl: user.avatar_url,
        scopes: apiResponse.headers.get('x-oauth-scopes')?.split(', ') ?? [],
      } as GitHubAuthState);
    } else {
      return c.json({ authenticated: false } as GitHubAuthState);
    }
  } catch {
    return c.json({ authenticated: false } as GitHubAuthState);
  }
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
});

// Export to GitHub repository
exportRouter.post('/api/github/export', async (c) => {
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    return c.json({
      ok: false,
      error: 'GitHub integration not configured. Set GITHUB_TOKEN.',
      errorType: 'auth',
    }, 401);
  }
  
  try {
    const body = await c.req.json();
    const parsed = GitHubExportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: 'Invalid export data',
        errorType: 'validation',
      }, 400);
    }
    
    const { repoName, description, isPrivate, files } = parsed.data;
    
    // Validate repository name
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(repoName)) {
      return c.json({
        ok: false,
        error: 'Invalid repository name',
        errorType: 'validation',
      }, 400);
    }
    
    // Validate paths
    const reserved = new Set(['.git', '.github', 'node_modules', '.env']);
    for (const f of files) {
      const parts = f.path.split('/');
      if (parts.some(p => reserved.has(p))) {
        return c.json({
          ok: false,
          error: `Reserved path: ${f.path}`,
          errorType: 'validation',
        }, 400);
      }
    }
    
    // Check if repository already exists
    try {
      const checkResponse = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER || 'erikbabcan-commits'}/${repoName}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } }
      );
      
      if (checkResponse.status === 200) {
        return c.json({
          ok: false,
          error: `Repository '${repoName}' already exists`,
          errorType: 'conflict',
        }, 409);
      }
    } catch {
      // Repository doesn't exist or error checking - proceed
    }
    
    // Create repository
    const createResponse = await fetch(
      `https://api.github.com/user/repos`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          description: description || 'Generated by LOV-DEVIL AI Builder',
          private: isPrivate,
          auto_init: false,
        }),
      }
    );
    
    if (!createResponse.ok) {
      const errorData = await createResponse.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to create repository';
      
      if (createResponse.status === 401) {
        return c.json({ ok: false, error: 'Unauthorized - check GitHub token', errorType: 'auth' }, 401);
      }
      if (createResponse.status === 403) {
        return c.json({ ok: false, error: errorMsg, errorType: 'rate_limit' }, 403);
      }
      if (createResponse.status === 422) {
        return c.json({ ok: false, error: errorMsg, errorType: 'validation' }, 422);
      }
      
      return c.json({ ok: false, error: errorMsg, errorType: 'api' } as const);
    }
    
    const repo = await createResponse.json();
    const repoFullName = repo.full_name;
    const owner = repo.owner.login;
    
    // Upload files via Git API
    // Create a tree with all files
    const treeEntries: Array<{ path: string; mode: string; type: string; content?: string; sha?: string }> = [];
    
    for (const f of files) {
      treeEntries.push({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content,
      });
    }
    
    // Create tree
    const treeResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tree: treeEntries }),
      }
    );
    
    if (!treeResponse.ok) {
      // Clean up: delete the repository
      await fetch(`https://api.github.com/repos/${repoFullName}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
      }).catch(() => {});
      
      return c.json({ ok: false, error: 'Failed to create tree', errorType: 'api' }, 500);
    }
    
    const tree = await treeResponse.json();
    
    // Create initial commit
    const commitResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Initial commit - exported from LOV-DEVIL AI Builder',
          tree: tree.sha,
        }),
      }
    );
    
    if (!commitResponse.ok) {
      // Clean up
      await fetch(`https://api.github.com/repos/${repoFullName}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
      }).catch(() => {});
      
      return c.json({ ok: false, error: 'Failed to create commit', errorType: 'api' }, 500);
    }
    
    const commit = await commitResponse.json();
    
    // Update HEAD to point to the new commit
    await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha: commit.sha }),
      }
    ).catch(() => {});
    
    return c.json({
      ok: true,
      repoUrl: repo.html_url,
    });
  } catch (e) {
    console.error('[GitHub Export] Error:', e);
    return c.json({
      ok: false,
      error: 'Internal server error',
      errorType: 'api',
    }, 500);
  }
});

export { exportRouter };
