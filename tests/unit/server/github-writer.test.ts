// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { writeGitHubRepository } from '../../../server/integrations/githubWriter';

const files = [{ path: 'src/main.tsx', content: 'export const name = "Žltý 🌍";' }];
function fixture(mode = 'ok') {
  let refs = 0;
  const api = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (path === '/user') return json({ id: mode === 'identity' ? 7 : 42, login: 'fixture' });
    if (path === '/repos/fixture/export') return json({}, mode === 'exists' ? 200 : mode === 'rate' ? 403 : 404);
    if (path === '/user/repos') {
      expect(JSON.parse(String(init?.body)).private).toBe(false);
      return json({ id: 99, full_name: 'fixture/export', private: mode === 'private', default_branch: mode === 'branch' ? '../../user' : 'main', owner: { id: 42, login: 'fixture' } });
    }
    if (path.endsWith('/git/ref/heads/main')) return json({ object: { sha: (++refs === 1 ? 'a' : 'd').repeat(40) } });
    if (path.endsWith('/git/commits/' + 'a'.repeat(40))) return json({ tree: { sha: 'b'.repeat(40) } });
    if (path.endsWith('/git/commits/' + 'd'.repeat(40))) return json({ tree: { sha: (mode === 'commit' ? 'e' : 'c').repeat(40) }, parents: [{ sha: 'a'.repeat(40) }] });
    if (path.endsWith('/git/trees')) {
      expect(JSON.parse(String(init?.body)).base_tree).toBe('b'.repeat(40));
      return json({ sha: 'c'.repeat(40) });
    }
    if (path.endsWith('/git/commits')) return json({ sha: 'd'.repeat(40) });
    if (path.endsWith('/git/refs/heads/main')) {
      expect(JSON.parse(String(init?.body))).toEqual({ sha: 'd'.repeat(40), force: false }); return json({});
    }
    if (path.endsWith('/git/trees/' + 'c'.repeat(40))) {
      const bytes = Buffer.from(files[0].content);
      return json({ truncated: false, tree: [{ path: files[0].path, type: 'blob', sha: mode === 'corrupt' ? 'f'.repeat(40) : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }] });
    }
    throw new Error('Unexpected fixture request');
  });
  const guard = vi.fn(async () => undefined);
  const input = { token: 'fixture-server-token', githubId: 42, username: 'fixture', repoName: 'export', files, assertAuthorized: guard, fetch: api };
  return { input, api, guard };
}
it('creates a public repo, preserves the initial tree and verifies UTF-8 blobs and the resulting commit', async () => {
  const { input, api, guard } = fixture();
  expect(await writeGitHubRepository(input)).toEqual({ ok: true, repositoryId: 99, repoFullName: 'fixture/export', repoUrl: 'https://github.com/fixture/export', commitSha: 'd'.repeat(40), filesUploaded: 1 });
  expect(guard).toHaveBeenCalledTimes(api.mock.calls.length);
  for (const [, init] of api.mock.calls) expect(init?.redirect).toBe('error');
});
it.each(['exists', 'rate', 'identity'])('never writes when the preflight fails: %s', async mode => {
  const { input, api } = fixture(mode);
  expect((await writeGitHubRepository(input)).ok).toBe(false);
  expect(api.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
it('reports a partially created repo if verification fails, without deleting or retrying it', async () => {
  const { input, api } = fixture('corrupt');
  expect(await writeGitHubRepository(input)).toMatchObject({ ok: false, error: 'github_write_failed', repository: { repositoryId: 99 } });
  expect(api.mock.calls.filter(([url]) => String(url).endsWith('/user/repos'))).toHaveLength(1);
  expect(api.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});
it('stops before the next API operation when connection authorization is revoked', async () => {
  const { input, api, guard } = fixture(); guard.mockImplementation(async () => { if (api.mock.calls.length >= 3) throw new Error('revoked'); });
  expect(await writeGitHubRepository(input)).toMatchObject({ ok: false, repository: { repositoryId: 99 } });
  expect(api).toHaveBeenCalledTimes(3);
});
it.each(['private', 'branch'])('rejects an unexpected repository response before uploading files: %s', async mode => {
  const { input, api } = fixture(mode);
  expect((await writeGitHubRepository(input)).ok).toBe(false);
  expect(api).toHaveBeenCalledTimes(3);
});
it('does not update a branch when the returned commit points to a different tree', async () => {
  const { input, api } = fixture('commit');
  expect((await writeGitHubRepository(input)).ok).toBe(false);
  expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
});
it('rejects secrets and an already-aborted request before network writes', async () => {
  const { input, api } = fixture();
  expect((await writeGitHubRepository({ ...input, files: [{ path: 'src/main.tsx', content: 'ghp_' + 'A'.repeat(36) }] })).ok).toBe(false);
  expect((await writeGitHubRepository({ ...input, signal: AbortSignal.abort() })).ok).toBe(false);
  expect(api).not.toHaveBeenCalled();
});
it('persists source-free recovery evidence before publishing the branch', async () => {
  const { input, api } = fixture(); const checkpoint = vi.fn(async () => { expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false); });
  expect((await writeGitHubRepository({ ...input, checkpoint })).ok).toBe(true);
  expect(checkpoint).toHaveBeenCalledTimes(2);
  expect(checkpoint.mock.calls[1]).toEqual([expect.objectContaining({ stage: 'commit_ready', commitSha: 'd'.repeat(40), files: [{ path: files[0].path, sha: expect.stringMatching(/^[a-f0-9]{40}$/) }] })]);
  expect(JSON.stringify(checkpoint.mock.calls)).not.toContain(files[0].content);
  expect(JSON.stringify(checkpoint.mock.calls)).not.toContain(input.token);
});
it('stops before branch publication if durable commit evidence cannot be saved', async () => {
  const { input, api } = fixture(); const checkpoint = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('storage unavailable'));
  expect(await writeGitHubRepository({ ...input, checkpoint })).toMatchObject({ ok: false, repository: { repositoryId: 99 } });
  expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  expect(api.mock.calls.filter(([url]) => String(url).endsWith('/user/repos'))).toHaveLength(1);
});
