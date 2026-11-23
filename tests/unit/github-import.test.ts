import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { githubImporter } from '../../server/integrations/githubImporter';
import * as client from '../../src/services/githubImport';
import { useStore } from '../../src/stores/useAppStore';
import { selectPersistenceScope } from '../../src/services/persistence/projectStore';

const input = { repoFullName: 'alice/demo' };
const text = 'export default "Žilina";\n';
const size = Buffer.byteLength(text);
const entry = (path: string, n = size, mode = '100644') => ({
  path, size: n, sha: 'a'.repeat(40), mode, type: 'blob',
});
function harness(tree: ReturnType<typeof entry>[], options = { private: false, truncated: false }) {
  const get = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-token');
    const path = new URL(String(url)).pathname;
    if (path === '/repos/alice/demo') return Response.json({ full_name: 'alice/demo', default_branch: 'trunk', private: options.private });
    if (path.includes('/git/trees/')) return Response.json({ tree, truncated: options.truncated });
    if (path.endsWith('/git/blobs/' + 'a'.repeat(40))) return new Response(text);
    throw new Error('unexpected route');
  });
  return { api: githubImporter('session-token', false, new AbortController().signal, get), get };
}

describe('GitHub tree import', () => {
  it('converts allowed blobs to VFS using the default branch and skips excluded paths, links and oversized blobs before download', async () => {
    const { api, get } = harness([entry('lib/nested/app.ts'), entry('src/node_modules/pkg/x.js'), entry('src/.git/config'),
      entry('src/x.jpg'), entry('src/link', 5, '120000'), entry('public/big', 510_000), entry('src/../bad'), entry('src/a\\b')]);
    expect(await api.pull(input)).toEqual({ repoFullName: input.repoFullName, branch: 'trunk', files: [{ name: 'lib/nested/app.ts', content: text }], skipped: 7 });
    expect(get).toHaveBeenCalledTimes(3);
    expect(String(get.mock.calls[1][0])).toMatch(/trees\/trunk\?recursive=1$/);
  });
  it('encodes branches with slashes and filters binary data without a filename extension', async () => {
    const { api, get } = harness([entry('public/unknown', 3)]);
    get.mockImplementationOnce(async () => Response.json({ full_name: input.repoFullName, default_branch: 'main', private: false }))
      .mockImplementationOnce(async () => Response.json({ tree: [entry('public/unknown', 3)], truncated: false }))
      .mockImplementationOnce(async () => new Response(new Uint8Array([255, 0, 10])));
    await expect(api.pull({ ...input, branch: 'feat/ui' })).rejects.toMatchObject({ code: 'github_import_empty' });
    expect(String(get.mock.calls[1][0])).toContain('/trees/feat%2Fui?');
  });
  it('rejects truncated trees and excessive file counts without downloading blobs', async () => {
    for (const { api, get } of [harness([], { private: false, truncated: true }), harness(Array.from({ length: 41 }, (_, i) => entry('src/' + i)))]) {
      await expect(api.pull(input)).rejects.toMatchObject({ code: 'github_import_limit' });
      expect(get).toHaveBeenCalledTimes(2);
    }
  });
  it('enforces visibility and rejects malformed owner/repo before requesting a tree', async () => {
    const { api, get } = harness([], { private: true, truncated: false });
    await expect(api.pull({ repoFullName: 'alice/..' })).rejects.toMatchObject({ code: 'invalid_import' });
    await expect(api.pull(input)).rejects.toMatchObject({ code: 'github_import_forbidden' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('paginates the authenticated repository list and returns only display fields', async () => {
    const { api, get } = harness([]);
    get.mockResolvedValueOnce(Response.json([{ full_name: input.repoFullName, default_branch: 'trunk', private: false, extra: 'unused' }],
      { headers: { Link: '<https://api.github.com/user/repos?page=3>; rel="next"' } }));
    expect(await api.repos(2)).toEqual({ repos: [{ fullName: input.repoFullName, defaultBranch: 'trunk' }], more: true });
    expect(String(get.mock.calls[0][0])).toContain('page=2');
  });
});

describe('Pull to Editor', () => {
  afterEach(() => vi.restoreAllMocks());
  const result = { ...input, branch: 'trunk', skipped: 0, files: [{ name: 'index.html', content: '<main>Hello</main>' }] };
  function setup() {
    selectPersistenceScope({ kind: 'account', userId: 'git-import-test' });
    useStore.getState().newProject();
  }
  it('opens CodeMirror on a new snapshot and restores its files from IndexedDB', async () => {
    setup();
    vi.spyOn(client, 'pullGitHubFiles').mockResolvedValue(result);
    const previous = useStore.getState().createSnapshot('manual', 'before', '<p>original</p>');
    useStore.setState({ liveId: previous.id, liveHtml: previous.html });
    await useStore.getState().importFromGitHub(input.repoFullName);
    const state = useStore.getState();
    expect(state).toMatchObject({ tab: 'code', mode: 'work', edFile: 'index.html' });
    expect(state.snapshots[0]).toEqual(previous);
    expect(state.snapshots[1]).toMatchObject({ parentId: previous.id, prompt: 'git-import: alice/demo' });
    useStore.setState({ snapshots: [], vfs: {}, liveId: null });
    await state.restoreFromDb();
    expect(useStore.getState().vfs[state.liveId!][0]).toMatchObject(result.files[0]);
    await useStore.getState().importFromGitHub(input.repoFullName);
    expect(useStore.getState().snapshots).toHaveLength(3);
  });
  it('rejects a delayed response after switching projects and preserves unsaved edits', async () => {
    setup();
    const pull = vi.spyOn(client, 'pullGitHubFiles').mockImplementation(async () => {
      useStore.getState().newProject();
      return result;
    });
    await expect(useStore.getState().importFromGitHub(input.repoFullName)).rejects.toThrow('zmenil');
    useStore.setState({ codeDraftDirty: true });
    await expect(useStore.getState().importFromGitHub(input.repoFullName)).rejects.toThrow('úpravy');
    expect(pull).toHaveBeenCalledTimes(1);
    expect(useStore.getState().snapshots).toHaveLength(0);
    useStore.setState({ codeDraftDirty: false });
  });
});
