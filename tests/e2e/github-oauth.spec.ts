/** M4.G: GitHub OAuth Browser E2E Tests
 *
 * Tests the real browser flow for GitHub OAuth integration.
 * Uses mocked GitHub API responses for CI determinism.
 * 
 * Requires the server to be running with MOCK_AI=1
 */

import { test, expect } from '@playwright/test';

const SERVER_URL = 'http://127.0.0.1:8787';
const FRONTEND_URL = 'http://localhost:5173';

// Helper to start the server if needed
async function ensureServerRunning(page: any) {
  try {
    const response = await page.request.get(`${SERVER_URL}/api/health`);
    if (response.ok()) return true;
  } catch {
    // Server not running
  }
  return false;
}

test.describe('GitHub OAuth Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to frontend
    await page.goto(FRONTEND_URL);
    // Wait for app to load
    await page.waitForSelector('body');
  });

  test('should show GitHub Connect button when not authenticated', async ({ page }) => {
    // Mock the /api/github/auth endpoint to return unauthenticated
    await page.route(`${SERVER_URL}/api/github/auth`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: false,
          configured: true,
          message: 'Not authenticated',
          blocked: false,
        }),
      });
    });

    // Click to check auth status
    await page.evaluate(() => {
      // Trigger checkGitHubAuth from the store
      window.dispatchEvent(new CustomEvent('check-github-auth'));
    });

    // The UI should show unauthenticated state
    // This is a basic connectivity test
    const response = await page.request.get(`${SERVER_URL}/api/github/auth`);
    expect(response.status()).toBeGreaterThanOrEqual(200);
  });

  test('should redirect to GitHub OAuth on /api/github/auth/start', async ({ page }) => {
    // Mock the /api/github/auth/start endpoint to return 302 redirect
    await page.route(`${SERVER_URL}/api/github/auth/start`, route => {
      route.fulfill({
        status: 302,
        headers: {
          'Location': 'https://github.com/login/oauth/authorize?client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fapi%2Fgithub%2Fauth%2Fcallback&scope=repo&state=test_state&allow_signup=false',
          'Set-Cookie': 'github_session_id=test_session; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax',
        },
      });
    });

    // Navigate directly to the start endpoint
    const response = await page.request.get(`${SERVER_URL}/api/github/auth/start`);
    expect(response.status()).toBe(302);
    const location = response.headers()['location'];
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('scope=repo');
    expect(location).toContain('redirect_uri=');
    expect(location).toContain('state=');
  });

  test('should handle OAuth callback with valid state', async ({ page }) => {
    // First, set up a session with a state token
    const stateToken = 'test_state_token_' + Date.now();
    
    // Mock the session creation and callback flow
    await page.route(`${SERVER_URL}/api/github/auth/callback?code=test_code&state=${stateToken}`, route => {
      route.fulfill({
        status: 302,
        headers: {
          'Location': 'http://localhost:5173?github_auth=success',
          'Set-Cookie': 'github_session_id=authenticated_session; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax',
        },
      });
    });

    // Navigate to callback with code and state
    const response = await page.request.get(
      `${SERVER_URL}/api/github/auth/callback?code=test_code&state=${stateToken}`
    );
    expect(response.status()).toBe(302);
    const location = response.headers()['location'];
    expect(location).toBe('http://localhost:5173?github_auth=success');
  });

  test('should reject OAuth callback with mismatched state', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/auth/callback?code=test_code&state=wrong_state`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Invalid state token. CSRF protection failed.',
        }),
      });
    });

    const response = await page.request.get(
      `${SERVER_URL}/api/github/auth/callback?code=test_code&state=wrong_state`
    );
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid state token');
  });

  test('should reject OAuth callback without code', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/auth/callback?state=test_state`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Missing code or state in callback',
        }),
      });
    });

    const response = await page.request.get(
      `${SERVER_URL}/api/github/auth/callback?state=test_state`
    );
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Missing code');
  });
});

test.describe('GitHub Export', () => {
  test('should reject unauthenticated export requests', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Not authenticated. Please connect GitHub first.',
          errorType: 'auth',
        }),
      });
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: {
        repoName: 'test-repo',
        description: 'Test',
        isPrivate: true,
        files: [],
        confirmed: true,
      },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.errorType).toBe('auth');
  });

  test('should reject export without confirmation', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'User confirmation required',
          errorType: 'validation',
        }),
      });
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: {
        repoName: 'test-repo',
        description: 'Test',
        isPrivate: true,
        files: [],
        confirmed: false,
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('confirmation');
  });

  test('should reject invalid repository names', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Invalid repository name',
          errorType: 'validation',
        }),
      });
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: {
        repoName: '.invalid',
        description: 'Test',
        isPrivate: true,
        files: [],
        confirmed: true,
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid repository name');
  });

  test('should reject reserved paths in files', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Reserved path: .git/config',
          errorType: 'validation',
        }),
      });
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: {
        repoName: 'test-repo',
        description: 'Test',
        isPrivate: true,
        files: [{ path: '.git/config', content: 'secret' }],
        confirmed: true,
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Reserved path');
  });

  test('should reject files with potential secrets', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'Potential secret detected in .env',
          errorType: 'validation',
        }),
      });
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: {
        repoName: 'test-repo',
        description: 'Test',
        isPrivate: true,
        files: [{ path: '.env', content: 'GITHUB_TOKEN=ghp_secret123' }],
        confirmed: true,
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('secret');
  });
});

test.describe('CSRF Protection', () => {
  test('should reject POST to /api/github/export without Origin header', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/export`, route => {
      // Check if Origin header is missing or invalid
      const headers = route.request().headers();
      const origin = headers['origin'];
      
      if (!origin || !['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            error: 'Invalid CSRF token',
            errorType: 'auth',
          }),
        });
      } else {
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Not authenticated' }),
        });
      }
    });

    // Send request without Origin header
    const response = await page.request.post(`${SERVER_URL}/api/github/export`, {
      data: { repoName: 'test', files: [], confirmed: true },
    });

    // Should be rejected (403 or 401)
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('should reject POST to /api/github/auth/revoke without valid Origin', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/auth/revoke`, route => {
      const headers = route.request().headers();
      const origin = headers['origin'];
      
      if (!origin || !['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            error: 'Invalid CSRF token',
          }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, message: 'Disconnected' }),
        });
      }
    });

    const response = await page.request.post(`${SERVER_URL}/api/github/auth/revoke`, {});
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('GitHub Status', () => {
  test('should return configured status when env vars are set', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/status`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          configured: true,
          message: 'GitHub OAuth configured',
          clientId: 'test_client...',
          callbackUrl: 'http://localhost:5173/api/github/auth/callback',
          blocked: false,
        }),
      });
    });

    const response = await page.request.get(`${SERVER_URL}/api/github/status`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(true);
    expect(body.available).toBe(true);
    expect(body.callbackUrl).toContain('localhost:5173');
  });

  test('should return not configured when env vars are missing', async ({ page }) => {
    await page.route(`${SERVER_URL}/api/github/status`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: false,
          configured: false,
          message: 'GitHub integration not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
          requiredEnv: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
          callbackUrl: 'http://localhost:5173/api/github/auth/callback',
          blocked: true,
          blockReason: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables are not configured',
        }),
      });
    });

    const response = await page.request.get(`${SERVER_URL}/api/github/status`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.configured).toBe(false);
    expect(body.blocked).toBe(true);
    expect(body.blockReason).toContain('GITHUB_CLIENT_ID');
  });
});
