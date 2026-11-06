import { vi } from 'vitest';
import { gitBlobSha } from '../../server/integrations/githubCheckpoint';

/** Stateful synthetic GitHub. No real network, credentials or repository. */
export function githubExportProvider(files: Array<{ path: string; content: string }>, losePatchResponse = false) {
  const parent = 'a'.repeat(40), tree = 'c'.repeat(40), commit = 'd'.repeat(40);
  let exists = false, name = 'export', head = parent, lost = false;
  const user = { id: 42, login: 'fixture-user' };
  const repository = () => ({ id: 99, full_name: user.login + '/' + name, private: false, default_branch: 'main', owner: user });
  const api = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (path === '/user' && method === 'GET') return json(user);
    if (path === '/user/repos' && method === 'POST') { exists = true; name = JSON.parse(String(init?.body)).name; return json(repository(), 201); }
    if (path === '/repos/' + user.login + '/' + name && method === 'GET') return exists ? json(repository()) : json({}, 404);
    if (path.endsWith('/git/ref/heads/main') && method === 'GET') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } });
    if (path.endsWith('/git/commits/' + parent) && method === 'GET') return json({ sha: parent, tree: { sha: 'b'.repeat(40) }, parents: [] });
    if (path.endsWith('/git/trees') && method === 'POST') return json({ sha: tree }, 201);
    if (path.endsWith('/git/commits') && method === 'POST') return json({ sha: commit }, 201);
    if (path.endsWith('/git/commits/' + commit) && method === 'GET') return json({ sha: commit, tree: { sha: tree }, parents: [{ sha: parent }] });
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      head = commit;
      if (losePatchResponse && !lost) { lost = true; throw new Error('synthetic_lost_patch_response'); }
      return json({ object: { sha: head } });
    }
    if (path.endsWith('/git/trees/' + tree) && method === 'GET') return json({ sha: tree, truncated: false,
      tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: gitBlobSha(file.content) })) });
    throw new Error('unexpected_synthetic_github_request');
  });
  return { api, user, parent, tree, commit };
}
