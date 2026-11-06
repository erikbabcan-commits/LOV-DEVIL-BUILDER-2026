// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { verifyGitHubExport } from '../../../server/integrations/githubRecovery';
import { gitBlobSha } from '../../../server/integrations/githubCheckpoint';

function fixture(mode = 'ok') {
  const checkpoint = { version: 1, stage: 'commit_ready', githubId: 42,
    repository: { repositoryId: 99, repoFullName: 'fixture/export', repoUrl: 'https://github.com/fixture/export' }, branch: 'main',
    commitSha: 'd'.repeat(40), treeSha: 'c'.repeat(40), parentSha: 'a'.repeat(40), files: [{ path: 'src/main.tsx', sha: gitBlobSha('Žltý 🌍') }] };
  const api = vi.fn<typeof fetch>(async url => {
    const path = new URL(String(url)).pathname;
    if (mode === 'transport') throw new Error('private-provider-detail');
    if (mode === 'large') return new Response('x'.repeat(131073));
    if (path === '/user') return Response.json({ id: mode === 'user' ? 7 : 42, login: 'fixture' });
    if (path === '/repos/fixture/export') return Response.json({ id: mode === 'replaced' ? 100 : 99, full_name: 'fixture/export', private: mode === 'private', owner: { id: mode === 'transferred' ? 7 : 42, login: 'fixture' } });
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ ref: mode === 'branch' ? 'refs/heads/other' : 'refs/heads/main', object: { type: 'commit', sha: (mode === 'head' ? 'e' : 'd').repeat(40) } });
    if (path.endsWith('/git/commits/' + checkpoint.commitSha)) return Response.json({ sha: checkpoint.commitSha, tree: { sha: (mode === 'tree' ? 'e' : 'c').repeat(40) }, parents: [{ sha: (mode === 'parent' ? 'e' : 'a').repeat(40) }] });
    const entry = { path: checkpoint.files[0].path, sha: mode === 'blob' ? 'f'.repeat(40) : checkpoint.files[0].sha, type: 'blob', mode: mode === 'symlink' ? '120000' : '100644' };
    return Response.json({ sha: checkpoint.treeSha, truncated: mode === 'truncated', tree: mode === 'missing' ? [] : mode === 'duplicate' ? [entry, entry] : [entry] });
  });
  const guard = vi.fn(async () => undefined);
  return { checkpoint, api, guard, input: { token: 'synthetic-token', githubId: 42, username: 'fixture', checkpoint, assertAuthorized: guard, fetch: api } };
}
it('verifies the original public repository, exact branch commit/tree/parent and UTF-8 blob using GET only', async () => {
  const { input, api, guard } = fixture();
  expect(await verifyGitHubExport(input)).toEqual({ ok: true, ...input.checkpoint.repository, commitSha: input.checkpoint.commitSha, filesUploaded: 1 });
  expect(api).toHaveBeenCalledTimes(5);
  expect(guard).toHaveBeenCalledTimes(6);
  for (const [url, init] of api.mock.calls) {
    expect(new URL(String(url)).origin).toBe('https://api.github.com');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
  }
});
it.each(['user', 'replaced', 'private', 'transferred', 'branch', 'head', 'tree', 'parent', 'blob', 'symlink', 'truncated', 'missing', 'duplicate'])('does not mark a mismatched or incomplete remote result as success: %s', async mode => {
  const { input, api } = fixture(mode);
  expect(await verifyGitHubExport(input)).toEqual({ ok: false, error: 'export_not_verified' });
  expect(api.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
it.each(['transport', 'large'])('returns a bounded generic error without changing anything: %s', async mode => {
  const { input } = fixture(mode);
  expect(await verifyGitHubExport(input)).toEqual({ ok: false, error: 'github_recovery_unavailable' });
});
it('refuses another GitHub identity or unsafe persisted evidence before network access', async () => {
  const { input, api } = fixture();
  expect((await verifyGitHubExport({ ...input, githubId: 7 })).ok).toBe(false);
  expect((await verifyGitHubExport({ ...input, checkpoint: { ...input.checkpoint, branch: '../../user' } })).ok).toBe(false);
  expect((await verifyGitHubExport({ ...input, checkpoint: { ...input.checkpoint, repository: { ...input.checkpoint.repository, repoUrl: 'https://attacker.test' } } })).ok).toBe(false);
  expect(api).not.toHaveBeenCalled();
});
it('honors cancellation and rechecks authorization after reading the final remote response', async () => {
  const { input, api, guard } = fixture();
  expect((await verifyGitHubExport({ ...input, signal: AbortSignal.abort() })).ok).toBe(false);
  expect(api).not.toHaveBeenCalled();
  guard.mockImplementation(async () => { if (api.mock.calls.length === 5) throw new Error('revoked'); });
  expect(await verifyGitHubExport(input)).toEqual({ ok: false, error: 'github_recovery_unavailable' });
});
it('aborts a stalled response body instead of leaving a recovery request hanging', async () => {
  const { input } = fixture(); const abort = new AbortController(); let bodyCancelled = false;
  const api = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
  const result = verifyGitHubExport({ ...input, fetch: api, signal: abort.signal });
  await vi.waitFor(() => expect(api).toHaveBeenCalledOnce()); abort.abort();
  expect(await result).toEqual({ ok: false, error: 'github_recovery_unavailable' });
  expect(bodyCancelled).toBe(true);
});
