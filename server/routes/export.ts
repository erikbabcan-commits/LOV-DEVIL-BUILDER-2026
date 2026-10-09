/* M4 PHASE A & B: Server-side export routes
   
   ZIP Export: Server validates export requests (download happens client-side)
   GitHub Export: Server handles GitHub API calls with proper authentication
   
   Security: All sensitive operations happen on the server
   - GitHub tokens NEVER exposed to client
   - Path validation on server
   - Rate limiting
   - GitHub export BLOCKED without proper per-user authorization
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

/**
 * GitHub export is BLOCKED in this implementation.
 * 
 * REASON: Proper per-user OAuth authorization flow is not implemented.
 * - No session management
 * - No user identity binding
 * - No secure token storage
 * - No CSRF protection
 * - No state validation
 * 
 * The endpoints exist for API contract testing but will always return
 * BLOCKED unless all required environment variables are present AND
 * the GITHUB_BLOCK_EXPORT environment variable is explicitly set to 'false'.
 * 
 * This is intentional: we refuse to create repositories with a shared token.
 */

// Check if GitHub integration is configured
// Returns BLOCKED unless explicitly enabled via GITHUB_BLOCK_EXPORT=false
exportRouter.get('/api/github/status', (c) => {
  const hasClientId = !!process.env.GITHUB_CLIENT_ID;
  const hasClientSecret = !!process.env.GITHUB_CLIENT_SECRET;
  const hasToken = !!process.env.GITHUB_TOKEN;
  const explicitlyEnabled = process.env.GITHUB_BLOCK_EXPORT === 'false';
  
  // GitHub export is BLOCKED by default for security
  if (!explicitlyEnabled) {
    return c.json({
      available: false,
      message: 'GitHub export is BLOCKED. Per-user OAuth authorization is not implemented. Set GITHUB_BLOCK_EXPORT=false to enable (requires GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_TOKEN).',
      configured: false,
      blocked: true,
      blockReason: 'NO_PER_USER_AUTH',
    });
  }
  
  if (!hasClientId || !hasClientSecret) {
    return c.json({
      available: false,
      message: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
      configured: false,
      blocked: true,
      blockReason: 'MISSING_OAUTH_CREDENTIALS',
    });
  }
  
  return c.json({
    available: true,
    configured: true,
    message: hasToken ? 'GitHub integration configured' : 'GitHub OAuth configured (token available for server-side operations)',
    blocked: false,
  });
});

// Check authentication status - always returns unauthenticated for BLOCKED mode
exportRouter.get('/api/github/auth', async (c) => {
  const explicitlyEnabled = process.env.GITHUB_BLOCK_EXPORT === 'false';
  
  if (!explicitlyEnabled) {
    return c.json({
      authenticated: false,
      message: 'GitHub export is BLOCKED. Authentication not available.',
      blocked: true,
      blockReason: 'NO_PER_USER_AUTH',
    } as GitHubAuthState & { message: string; blocked: boolean; blockReason: string });
  }
  
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    return c.json({
      authenticated: false,
      message: 'GitHub token not configured.',
      blocked: true,
      blockReason: 'MISSING_TOKEN',
    } as GitHubAuthState & { message: string; blocked: boolean; blockReason: string });
  }
  
  // If we have a token, we can check GitHub API for user info
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
        message: 'Authenticated',
        blocked: false,
      } as GitHubAuthState & { message: string; blocked: boolean });
    } else {
      return c.json({
        authenticated: false,
        message: 'GitHub token authentication failed.',
        blocked: true,
        blockReason: 'INVALID_TOKEN',
      } as GitHubAuthState & { message: string; blocked: boolean; blockReason: string });
    }
  } catch (e) {
    return c.json({
      authenticated: false,
      message: 'GitHub API error: ' + String(e),
      blocked: true,
      blockReason: 'API_ERROR',
    } as GitHubAuthState & { message: string; blocked: boolean; blockReason: string });
  }
});

// OAuth flow start - BLOCKED without proper implementation
exportRouter.get('/api/github/auth/start', (c) => {
  const explicitlyEnabled = process.env.GITHUB_BLOCK_EXPORT === 'false';
  
  if (!explicitlyEnabled) {
    return c.json({
      ok: false,
      error: 'GitHub OAuth is BLOCKED. Per-user authorization flow not implemented.',
      blocked: true,
      blockReason: 'NO_PER_USER_AUTH',
    }, 403);
  }
  
  const hasClientId = !!process.env.GITHUB_CLIENT_ID;
  const hasStateSecret = !!process.env.GITHUB_OAUTH_STATE_SECRET;
  
  if (!hasClientId || !hasStateSecret) {
    return c.json({
      ok: false,
      error: 'GitHub OAuth not properly configured.',
      blocked: true,
      blockReason: 'MISSING_OAUTH_CONFIG',
    }, 403);
  }
  
  // In a real implementation, this would:
  // 1. Generate a secure state token
  // 2. Store it in HTTP-only session cookie
  // 3. Redirect to GitHub OAuth authorize URL
  // 4. Include scope=repo (least privilege)
  // 5. Use redirect_uri pointing back to this server
  
  // For now, return BLOCKED
  return c.json({
    ok: false,
    error: 'GitHub OAuth flow not yet implemented. Use ZIP export.',
    blocked: true,
    blockReason: 'NOT_IMPLEMENTED',
  }, 501);
});

// OAuth callback - BLOCKED
exportRouter.get('/api/github/auth/callback', (c) => {
  return c.json({
    ok: false,
    error: 'GitHub OAuth callback not implemented.',
    blocked: true,
    blockReason: 'NOT_IMPLEMENTED',
  }, 501);
});

// OAuth revoke - BLOCKED
exportRouter.post('/api/github/auth/revoke', (c) => {
  return c.json({
    ok: false,
    error: 'GitHub OAuth revoke not implemented.',
    blocked: true,
    blockReason: 'NOT_IMPLEMENTED',
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
  // Explicit user confirmation required
  confirmed: z.boolean().optional().default(false),
});

/**
 * GitHub export endpoint.
 * 
 * BLOCKED by default for security reasons:
 * - No per-user authorization
 * - No session binding
 * - No user identity verification
 * 
 * Returns BLOCKED unless:
 * 1. GITHUB_BLOCK_EXPORT=false is explicitly set
 * 2. All required credentials are present
 * 3. User has explicitly confirmed the export (confirmed=true)
 * 4. Repository name is valid
 * 5. All files pass validation
 * 6. Repository doesn't already exist
 */
exportRouter.post('/api/github/export', async (c) => {
  const explicitlyEnabled = process.env.GITHUB_BLOCK_EXPORT === 'false';
  
  // BLOCKED by default
  if (!explicitlyEnabled) {
    return c.json({
      ok: false,
      error: 'GitHub export is BLOCKED. Per-user authorization is not implemented. Set GITHUB_BLOCK_EXPORT=false to enable (requires proper OAuth flow).',
      errorType: 'auth',
      blocked: true,
      blockReason: 'NO_PER_USER_AUTH',
    }, 403);
  }
  
  const token = process.env.GITHUB_TOKEN;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const owner = process.env.GITHUB_OWNER;
  
  if (!token || !clientId || !clientSecret) {
    return c.json({
      ok: false,
      error: 'GitHub integration not configured. Set GITHUB_TOKEN, GITHUB_CLIENT_ID, and GITHUB_CLIENT_SECRET.',
      errorType: 'auth',
      blocked: true,
      blockReason: 'MISSING_CREDENTIALS',
    }, 401);
  }
  
  try {
    const body = await c.req.json();
    const parsed = GitHubExportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: 'Invalid export data: ' + JSON.stringify(parsed.error.issues.slice(0, 3)),
        errorType: 'validation',
      }, 400);
    }
    
    const { repoName, description, isPrivate, files, confirmed } = parsed.data;
    
    // REQUIRE explicit confirmation
    if (!confirmed) {
      return c.json({
        ok: false,
        error: 'User confirmation required. Set confirmed=true to create repository.',
        errorType: 'validation',
      }, 400);
    }
    
    // Validate repository name
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(repoName)) {
      return c.json({
        ok: false,
        error: 'Invalid repository name. Use alphanumeric characters, hyphens, underscores, or dots (1-100 chars, no leading/trailing special chars).',
        errorType: 'validation',
      }, 400);
    }
    
    // Validate paths
    const reserved = new Set(['.git', '.github', 'node_modules', '.env', '.vscode', '.gitignore']);
    for (const f of files) {
      const parts = f.path.split('/');
      if (parts.some(p => reserved.has(p))) {
        return c.json({
          ok: false,
          error: `Reserved path: ${f.path}. Cannot export Git or Node.js metadata.`,
          errorType: 'validation',
        }, 400);
      }
    }
    
    // Check for secrets in file contents (basic check)
    const secretPatterns = [
      /MISTRAL_API_KEY/, /GITHUB_TOKEN/, /GITHUB_CLIENT_SECRET/, /NPM_TOKEN/, /PRIVATE_KEY/,
      /aws_access_key_id/, /aws_secret_access_key/, /password[=:]/i, /api[_-]?key[=:]/i,
    ];
    for (const f of files) {
      for (const pattern of secretPatterns) {
        if (pattern.test(f.content)) {
          return c.json({
            ok: false,
            error: `Potential secret detected in ${f.path}. Remove secrets before export.`,
            errorType: 'validation',
          }, 400);
        }
      }
    }
    
    // Check if repository already exists
    const targetOwner = owner || 'erikbabcan-commits';
    try {
      const checkResponse = await fetch(
        `https://api.github.com/repos/${targetOwner}/${repoName}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } }
      );
      
      if (checkResponse.status === 200) {
        return c.json({
          ok: false,
          error: `Repository '${targetOwner}/${repoName}' already exists. Choose a different name.`,
          errorType: 'conflict',
        }, 409);
      }
      
      if (checkResponse.status !== 404) {
        // Unexpected error checking existence
        return c.json({
          ok: false,
          error: `Failed to check repository existence: HTTP ${checkResponse.status}`,
          errorType: 'api',
        }, 500);
      }
    } catch (e) {
      return c.json({
        ok: false,
        error: `Failed to check repository existence: ${String(e)}`,
        errorType: 'api',
      }, 500);
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
          description: description || 'Exported from LOV-DEVIL AI Builder',
          private: isPrivate,
          auto_init: false, // We'll create the initial commit manually
        }),
      }
    );
    
    if (!createResponse.ok) {
      const errorData = await createResponse.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to create repository';
      
      if (createResponse.status === 401) {
        return c.json({ ok: false, error: 'Unauthorized - GitHub token invalid', errorType: 'auth' }, 401);
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
    const actualOwner = repo.owner.login;
    
    // Get the default branch - empty repos may not have 'main'
    let defaultBranch = 'main';
    try {
      const repoInfo = await fetch(
        `https://api.github.com/repos/${repoFullName}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } }
      );
      if (repoInfo.ok) {
        const info = await repoInfo.json();
        defaultBranch = info.default_branch || 'main';
      }
    } catch {
      // Use 'main' as fallback
    }
    
    // Create tree with all files
    const treeEntries: Array<{ path: string; mode: string; type: string; content?: string }> = [];
    
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
      const errorData = await treeResponse.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to create tree';
      
      // Attempt cleanup: delete the repository
      try {
        await fetch(`https://api.github.com/repos/${repoFullName}`, {
          method: 'DELETE',
          headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
        });
      } catch {
        // Cleanup failed - repository may be orphaned
        // This is a failure state that requires manual intervention
      }
      
      return c.json({
        ok: false,
        error: `Failed to create tree: ${errorMsg}. Repository may have been created but is incomplete.`,
        errorType: 'api',
        cleanupFailed: true,
        orphanedRepo: repoFullName,
      }, 500);
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
      const errorData = await commitResponse.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to create commit';
      
      // Attempt cleanup
      try {
        await fetch(`https://api.github.com/repos/${repoFullName}`, {
          method: 'DELETE',
          headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
        });
      } catch {
        // Cleanup failed
      }
      
      return c.json({
        ok: false,
        error: `Failed to create commit: ${errorMsg}. Repository may have been created but is incomplete.`,
        errorType: 'api',
        cleanupFailed: true,
        orphanedRepo: repoFullName,
      }, 500);
    }
    
    const commit = await commitResponse.json();
    
    // Create the initial branch reference
    // For empty repos, the default branch reference may not exist yet
    const refResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${defaultBranch}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha: commit.sha }),
      }
    );
    
    if (!refResponse.ok) {
      const errorData = await refResponse.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to create branch reference';
      
      // Attempt cleanup
      try {
        await fetch(`https://api.github.com/repos/${repoFullName}`, {
          method: 'DELETE',
          headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
        });
      } catch {
        // Cleanup failed
      }
      
      return c.json({
        ok: false,
        error: `Failed to create branch reference: ${errorMsg}. Repository may have been created but is incomplete.`,
        errorType: 'api',
        cleanupFailed: true,
        orphanedRepo: repoFullName,
      }, 500);
    }
    
    // Verify the branch exists and points to our commit
    const verifyResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${defaultBranch}`,
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } }
    );
    
    if (!verifyResponse.ok) {
      // Branch verification failed - this is a real problem
      return c.json({
        ok: false,
        error: 'Failed to verify branch creation. Export incomplete.',
        errorType: 'api',
        cleanupFailed: false,
        repoUrl: repo.html_url,
      }, 500);
    }
    
    const refInfo = await verifyResponse.json();
    if (refInfo.object.sha !== commit.sha) {
      return c.json({
        ok: false,
        error: 'Branch reference does not point to expected commit. Export incomplete.',
        errorType: 'api',
        cleanupFailed: false,
        repoUrl: repo.html_url,
      }, 500);
    }
    
    // Success! Return the repository URL
    return c.json({
      ok: true,
      repoUrl: repo.html_url,
      repoFullName,
      defaultBranch,
      commitSha: commit.sha,
      fileCount: files.length,
    });
  } catch (e) {
    console.error('[GitHub Export] Error:', e);
    return c.json({
      ok: false,
      error: 'Internal server error: ' + String(e),
      errorType: 'api',
    }, 500);
  }
});

export { exportRouter };
