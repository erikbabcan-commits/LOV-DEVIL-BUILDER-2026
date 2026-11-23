import { z } from 'zod';
import { ImportRequest, RepoList, type importErrors } from '../../shared/githubImport';
import { isRepositorySourcePath, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, withinSizeLimits } from '../security/pathGuard';

type ErrorCode = keyof typeof importErrors;
export class ImportError extends Error {
  constructor(readonly code: ErrorCode, readonly status: 400 | 401 | 403 | 404 | 413 | 422 | 502) {
    super(code);
  }
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().nonnegative().optional() })),
});
const metadata = z.object({ full_name: z.string(), private: z.boolean(), default_branch: z.string() });
const binaryExtension = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|zip|gz|wasm|mp[34]|exe|sqlite)$/i;

export function githubImporter(token: string, privateAllowed: boolean, signal: AbortSignal, request = fetch) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(55_000)]);
  async function read(path: string, raw = false) {
    const response = await request('https://api.github.com' + path, {
      headers: { Authorization: 'Bearer ' + token, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' },
      signal: deadline, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      void response.body?.cancel();
      if (response.status === 404) throw new ImportError('github_import_missing', 404);
      if (response.status === 401 || response.status === 403) throw new ImportError('github_import_forbidden', 403);
      throw new ImportError('github_import_failed', 502);
    }
    return response;
  }

  async function repos(page: number) {
    const response = await read('/user/repos?sort=updated&per_page=100&page=' + page + '&visibility=' + (privateAllowed ? 'all' : 'public'));
    const list = metadata.array().parse(await response.json());
    return RepoList.parse({ repos: list.filter(repo => privateAllowed || !repo.private)
      .map(repo => ({ fullName: repo.full_name, defaultBranch: repo.default_branch })), more: /rel="next"/.test(response.headers.get('link') ?? '') });
  }

  async function pull(input: unknown) {
    const parsed = ImportRequest.safeParse(input);
    if (!parsed.success) throw new ImportError('invalid_import', 400);
    const base = '/repos/' + parsed.data.repoFullName;
    const repo = metadata.parse(await (await read(base)).json());
    if (repo.private && !privateAllowed) throw new ImportError('github_import_forbidden', 403);
    const branch = parsed.data.branch ?? repo.default_branch;
    const tree = treeSchema.parse(await (await read(base + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1')).json());
    if (tree.truncated) throw new ImportError('github_import_limit', 413);
    const blobs = tree.tree.filter(item => item.type === 'blob');
    const eligible = blobs.filter(({ path, mode, size }) =>
      (mode === '100644' || mode === '100755') && isRepositorySourcePath(path) &&
      size !== undefined && size <= MAX_FILE_BYTES && !binaryExtension.test(path));
    if (eligible.length > MAX_FILES) throw new ImportError('github_import_limit', 413);
    const files: { name: string; content: string }[] = [];
    let total = 0;
    // Fetch immutable blobs from the selected tree with bounded concurrency.
    for (let offset = 0; offset < eligible.length; offset += 4) {
      const batch = await Promise.all(eligible.slice(offset, offset + 4).map(async item => {
        const bytes = new Uint8Array(await (await read(base + '/git/blobs/' + item.sha, true)).arrayBuffer());
        if (bytes.length !== item.size) throw new ImportError('github_import_failed', 502);
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
        if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(content)) return null;
        total += bytes.length;
        return { name: item.path, content };
      }));
      if (total > MAX_TOTAL_BYTES) throw new ImportError('github_import_limit', 413);
      for (const file of batch) if (file) files.push(file);
    }
    if (!files.length) throw new ImportError('github_import_empty', 422);
    if (!withinSizeLimits(files.map(file => ({ path: file.name, content: file.content }))).ok)
      throw new ImportError('github_import_limit', 413);
    return { repoFullName: repo.full_name, branch, files, skipped: blobs.length - files.length };
  }
  return { repos, pull };
}

export async function githubImportResponse(importer: ReturnType<typeof githubImporter>, request: Request) {
  try {
    const query = new URL(request.url).search;
    const payload = request.method === 'GET'
      ? await importer.repos(query ? parsePage(query) : 1)
      : await importer.pull(await request.json().catch(() => null));
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = error instanceof ImportError ? error : new ImportError('github_import_failed', 502);
    return Response.json({ error: failure.code }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
function parsePage(search: string) {
  if (!/^\?page=[1-9]\d{0,4}$/.test(search)) throw new ImportError('invalid_import', 400);
  return Number(search.slice(6));
}
