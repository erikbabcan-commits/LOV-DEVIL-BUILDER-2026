import { describe, it, expect, vi, beforeEach } from 'vitest';
import { provisionRepository, ProvisionRequest } from '../../server/integrations/githubProvisioner';
import { triggerDeployHook, DeployHookRequest } from '../../server/integrations/deployHook';

describe('1-Click GitHub Export & Cloud Deploy Provisioner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('githubProvisioner', () => {
    it('validates repoName and inputs according to schema', () => {
      const valid = ProvisionRequest.safeParse({
        repoName: 'lov-project-my-app',
        isPrivate: false,
        appTitle: 'My App',
      });
      expect(valid.success).toBe(true);

      const invalid = ProvisionRequest.safeParse({
        repoName: '-invalid-name-',
        isPrivate: false,
      });
      expect(invalid.success).toBe(false);
    });

    it('provisions repository, creates blobs, tree, commit, and refs', async () => {
      const createdRequests: Array<{ url: string; method: string; body: unknown }> = [];

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        createdRequests.push({ url, method, body });

        if (url.endsWith('/user/repos') && method === 'POST') {
          return new Response(
            JSON.stringify({
              full_name: 'vorkei/lov-project-test',
              html_url: 'https://github.com/vorkei/lov-project-test',
              clone_url: 'https://github.com/vorkei/lov-project-test.git',
              default_branch: 'main',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('/git/blobs') && method === 'POST') {
          return new Response(
            JSON.stringify({ sha: 'blob_sha_12345' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('/git/trees') && method === 'POST') {
          return new Response(
            JSON.stringify({ sha: 'tree_sha_67890' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('/git/commits') && method === 'POST') {
          return new Response(
            JSON.stringify({ sha: 'commit_sha_abcdef' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('/git/refs') && method === 'POST') {
          return new Response(
            JSON.stringify({ ref: 'refs/heads/main' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('/repos/vorkei/lov-project-test') && method === 'PATCH') {
          return new Response(
            JSON.stringify({ default_branch: 'main' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      });

      const outcome = await provisionRepository(
        {
          repoName: 'lov-project-test',
          isPrivate: false,
          appTitle: 'Test Title',
          htmlContent: '<h1>Hello World</h1>',
        },
        { token: 'gho_mock_token', username: 'vorkei' },
        { fetch: mockFetch as unknown as typeof fetch }
      );

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.repoFullName).toBe('vorkei/lov-project-test');
        expect(outcome.repoUrl).toBe('https://github.com/vorkei/lov-project-test');
        expect(outcome.cloneUrl).toBe('https://github.com/vorkei/lov-project-test.git');
        expect(outcome.commitSha).toBe('commit_sha_abcdef');
        expect(outcome.filesUploaded).toBeGreaterThanOrEqual(11);
      }

      // Overenie, že sa vytvoril strom so súbormi package.json, vercel.json a App.tsx
      const treeReq = createdRequests.find((r) => r.url.includes('/git/trees'));
      expect(treeReq).toBeDefined();
      const treeBody = treeReq?.body as { tree: Array<{ path: string }> };
      const paths = treeBody.tree.map((f) => f.path);
      expect(paths).toContain('package.json');
      expect(paths).toContain('vite.config.ts');
      expect(paths).toContain('tailwind.config.js');
      expect(paths).toContain('src/App.tsx');
      expect(paths).toContain('vercel.json');
      expect(paths).toContain('netlify.toml');
      expect(paths).toContain('README.md');
      expect(paths).toContain('public/preview.html');
    });

    it('returns repo_exists error when GitHub returns 422', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(JSON.stringify({ message: 'Repository already exists' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const outcome = await provisionRepository(
        { repoName: 'already-exists', isPrivate: true },
        { token: 'gho_mock_token', username: 'vorkei' },
        { fetch: mockFetch as unknown as typeof fetch }
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBe('repo_exists');
      }
    });

    it('returns github_unauthorized when token is invalid (401)', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const outcome = await provisionRepository(
        { repoName: 'test-unauth', isPrivate: false },
        { token: 'bad_token', username: 'vorkei' },
        { fetch: mockFetch as unknown as typeof fetch }
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBe('github_unauthorized');
      }
    });
  });

  describe('deployHook', () => {
    it('validates webhook URL domains (accepts vercel & netlify only)', () => {
      const vercel = DeployHookRequest.safeParse({
        webhookUrl: 'https://api.vercel.com/v1/integrations/deploy/prj_123/hook_abc',
        provider: 'vercel',
      });
      expect(vercel.success).toBe(true);

      const netlify = DeployHookRequest.safeParse({
        webhookUrl: 'https://api.netlify.com/build_hooks/60f789abc',
        provider: 'netlify',
      });
      expect(netlify.success).toBe(true);

      const invalidDomain = DeployHookRequest.safeParse({
        webhookUrl: 'https://malicious-site.com/hook',
        provider: 'vercel',
      });
      expect(invalidDomain.success).toBe(false);
    });

    it('triggers Vercel deploy hook successfully and parses response', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            job: {
              id: 'job_vercel_999',
              state: 'QUEUED',
              createdAt: Date.now(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const outcome = await triggerDeployHook(
        {
          webhookUrl: 'https://api.vercel.com/v1/integrations/deploy/prj_123/hook_abc',
          provider: 'vercel',
          repoFullName: 'vorkei/lov-project-app',
        },
        { fetch: mockFetch as unknown as typeof fetch }
      );

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.provider).toBe('vercel');
        expect(outcome.jobId).toBe('job_vercel_999');
        expect(outcome.statusUrl).toContain('vercel.com/dashboard');
      }
    });

    it('handles webhook errors honestly', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('Unauthorized webhook', { status: 403 });
      });

      const outcome = await triggerDeployHook(
        {
          webhookUrl: 'https://api.netlify.com/build_hooks/fail_hook',
          provider: 'netlify',
        },
        { fetch: mockFetch as unknown as typeof fetch }
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBe('hook_rejected');
      }
    });
  });
});
