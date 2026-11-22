/**
 * GitHub Repository Provisioner
 * Creates a new standalone repo, scaffolds project files, and makes an initial commit.
 * All GitHub API calls happen server-side; tokens never leave the server.
 */

import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────────────────────

export const ProvisionRequest = z.object({
  repoName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/),
  isPrivate: z.boolean(),
  description: z.string().max(255).optional(),
  appTitle: z.string().max(80).optional(),
  htmlContent: z.string().max(500_000).optional(),
});

export type ProvisionRequestInput = z.infer<typeof ProvisionRequest>;

export interface ProvisionResult {
  ok: true;
  repoUrl: string;
  cloneUrl: string;
  repoFullName: string;
  commitSha: string;
  filesUploaded: number;
}

export interface ProvisionError {
  ok: false;
  error:
    | 'repo_exists'
    | 'github_unauthorized'
    | 'github_api_error'
    | 'invalid_input'
    | 'timeout';
  message?: string;
}

export type ProvisionOutcome = ProvisionResult | ProvisionError;

// ─── Scaffold generator ───────────────────────────────────────────────────────

function scaffoldFiles(
  repoName: string,
  appTitle: string,
  htmlContent: string
): Array<{ path: string; content: string }> {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const title = appTitle || slug;

  const packageJson = JSON.stringify(
    {
      name: slug,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc -b && vite build',
        preview: 'vite preview',
        lint: 'eslint . --ext ts,tsx',
      },
      dependencies: {
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      devDependencies: {
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@vitejs/plugin-react': '^4.4.1',
        autoprefixer: '^10.4.20',
        postcss: '^8.4.49',
        tailwindcss: '^3.4.17',
        typescript: '^5.6.3',
        vite: '^6.0.5',
      },
    },
    null,
    2
  );

  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});
`;

  const tailwindConfig = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
`;

  const postcssConfig = `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`;

  const tsconfig = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        skipLibCheck: true,
      },
      include: ['src'],
    },
    null,
    2
  );

  const appTsx = `import './App.css';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">${title}</h1>
        <div className="prose prose-gray max-w-none">
          {/* Exported from LOV-DEVIL Builder – https://lov.vorkei.com */}
        </div>
      </div>
    </div>
  );
}
`;

  const appCss = `@tailwind base;
@tailwind components;
@tailwind utilities;
`;

  const mainTsx = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

  const indexHtml = `<!doctype html>
<html lang="sk">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

  const vercelJson = JSON.stringify(
    {
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      framework: 'vite',
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
    },
    null,
    2
  );

  const netlifyToml = `[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
`;

  const readme = `# ${title}

Exported from [LOV-DEVIL Builder](https://lov.vorkei.com) 🚀

## Quick start

\`\`\`bash
npm install
npm run dev
\`\`\`

## Deploy

**Vercel:** [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/${slug})

**Netlify:** [![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/${slug})

## Stack

- React 19 + TypeScript
- Vite 6
- Tailwind CSS 3
`;

  const files: Array<{ path: string; content: string }> = [
    { path: 'package.json', content: packageJson },
    { path: 'vite.config.ts', content: viteConfig },
    { path: 'tailwind.config.js', content: tailwindConfig },
    { path: 'postcss.config.js', content: postcssConfig },
    { path: 'tsconfig.json', content: tsconfig },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.tsx', content: mainTsx },
    { path: 'src/App.tsx', content: appTsx },
    { path: 'src/App.css', content: appCss },
    { path: 'vercel.json', content: vercelJson },
    { path: 'netlify.toml', content: netlifyToml },
    { path: 'README.md', content: readme },
  ];

  // If the user has custom HTML, include it as a standalone page too
  if (htmlContent && htmlContent.trim().length > 0) {
    files.push({ path: 'public/preview.html', content: htmlContent });
  }

  return files;
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

interface GitHubApiOptions {
  token: string;
  signal: AbortSignal;
  customFetch?: typeof fetch;
}

async function ghRequest(
  path: string,
  method: string,
  body: unknown,
  opts: GitHubApiOptions,
  allowStatus?: number
): Promise<{ status: number; data: unknown }> {
  const f = opts.customFetch ?? fetch;
  const res = await f('https://api.github.com' + path, {
    method,
    signal: opts.signal,
    redirect: 'error',
    headers: {
      Authorization: 'Bearer ' + opts.token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore parse errors
  }

  if (allowStatus && res.status === allowStatus) return { status: res.status, data };
  if (res.status === 401) throw new Error('github_unauthorized');
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'message' in data
        ? String((data as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    throw new Error('github_api_error:' + msg);
  }
  return { status: res.status, data };
}

// ─── Main provisioner ─────────────────────────────────────────────────────────

export async function provisionRepository(
  input: ProvisionRequestInput,
  credentials: { token: string; username: string },
  opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}
): Promise<ProvisionOutcome> {
  const signal = opts.signal ?? AbortSignal.timeout(30_000);
  const apiOpts: GitHubApiOptions = { token: credentials.token, signal, customFetch: opts.fetch };

  try {
    // 1. Create the repository
    const createRes = await ghRequest(
      '/user/repos',
      'POST',
      {
        name: input.repoName,
        description: input.description ?? `Exported from LOV-DEVIL Builder – https://lov.vorkei.com`,
        private: input.isPrivate,
        auto_init: false,
      },
      apiOpts,
      422 // 422 = repo already exists
    );

    if (createRes.status === 422) {
      return { ok: false, error: 'repo_exists', message: `Repository "${input.repoName}" already exists` };
    }

    const repo = createRes.data as {
      full_name: string;
      html_url: string;
      clone_url: string;
      default_branch: string;
    };

    const repoFullName = repo.full_name;
    const [owner, repoName] = repoFullName.split('/');

    // 2. Generate scaffold files
    const files = scaffoldFiles(
      input.repoName,
      input.appTitle ?? input.repoName,
      input.htmlContent ?? ''
    );

    // 3. Create initial commit via Git Trees API (single-round-trip, no base tree)
    signal.throwIfAborted();

    // Create blobs for each file
    const blobShas: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      signal.throwIfAborted();
      const blobRes = await ghRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/blobs`,
        'POST',
        { content: Buffer.from(file.content).toString('base64'), encoding: 'base64' },
        apiOpts
      );
      blobShas.push({ path: file.path, sha: (blobRes.data as { sha: string }).sha });
    }

    // Create tree
    signal.throwIfAborted();
    const treeRes = await ghRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees`,
      'POST',
      {
        tree: blobShas.map(({ path, sha }) => ({
          path,
          mode: '100644',
          type: 'blob',
          sha,
        })),
      },
      apiOpts
    );
    const treeSha = (treeRes.data as { sha: string }).sha;

    // Create commit
    signal.throwIfAborted();
    const commitRes = await ghRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits`,
      'POST',
      {
        message: `chore: initial scaffold from LOV-DEVIL Builder\n\nhttps://lov.vorkei.com`,
        tree: treeSha,
        parents: [],
      },
      apiOpts
    );
    const commitSha = (commitRes.data as { sha: string }).sha;

    // Set HEAD to main branch
    signal.throwIfAborted();
    await ghRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`,
      'POST',
      { ref: 'refs/heads/main', sha: commitSha },
      apiOpts
    );

    // Update default branch to main
    signal.throwIfAborted();
    await ghRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
      'PATCH',
      { default_branch: 'main' },
      apiOpts
    );

    return {
      ok: true,
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      repoFullName,
      commitSha,
      filesUploaded: files.length,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return { ok: false, error: 'timeout', message: 'GitHub API timeout' };
      }
      if (err.message === 'github_unauthorized') {
        return { ok: false, error: 'github_unauthorized', message: 'GitHub token expired or invalid' };
      }
      if (err.message.startsWith('github_api_error:')) {
        return { ok: false, error: 'github_api_error', message: err.message.slice(17) };
      }
    }
    return { ok: false, error: 'github_api_error', message: String(err) };
  }
}
