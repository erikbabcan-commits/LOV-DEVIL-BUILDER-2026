import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { selectDatabaseScope } from '../../src/services/persistence/db';

describe('GitHub export visibility and confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.getState().newProject();
    const snapshot = useStore.getState().createSnapshot('ai', 'Export fixture', '<main>Fixture</main>');
    useStore.setState({
      liveId: snapshot.id,
      projectTitle: 'Export fixture',
      vfs: { [snapshot.id]: [{ name: 'index.html', content: '<main>Fixture</main>', modified: false }] },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    selectDatabaseScope({ kind: 'pilot' });
    useStore.setState({ githubExportInProgress: false });
  });

  function mockGitHub(scopes: string[] | undefined, confirmed = true, onAuth?: (call: number) => string) {
    let authCalls = 0;
    const exports: Array<{ isPrivate: boolean; confirmed: boolean }> = [];
    const confirmation = vi.fn((_message: string) => confirmed);
    vi.stubGlobal('confirm', confirmation);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (path === '/api/github/status') return json({ available: true, configured: true });
      if (path === '/api/github/auth') return json({
        authenticated: true, configured: true, scopes, csrfToken: onAuth?.(++authCalls) ?? 'fixture-csrf',
      });
      if (path === '/api/github/export' && init?.method === 'POST') {
        exports.push(JSON.parse(String(init.body)));
        return json({ ok: true, repoUrl: 'https://github.com/example/export-fixture' });
      }
      throw new Error('Unexpected fixture request');
    }));
    return { exports, confirmation };
  }

  it('public_repo exports publicly only after a clear publication confirmation', async () => {
    const { exports, confirmation } = mockGitHub(['public_repo']);
    await useStore.getState().exportToGitHub();
    expect(confirmation).toHaveBeenCalledOnce();
    expect(confirmation.mock.calls[0][0]).toContain('PUBLIC repository');
    expect(confirmation.mock.calls[0][0]).toContain('visible to everyone');
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ isPrivate: false, confirmed: true });
  });

  it.each([{ scopes: ['repo'] }, { scopes: ['repo', 'public_repo'] }])('keeps private export for an explicitly granted broad scope: $scopes', async ({ scopes }) => {
    const { exports, confirmation } = mockGitHub(scopes);
    await useStore.getState().exportToGitHub();
    expect(confirmation.mock.calls[0][0]).toContain('private repository');
    expect(exports[0]).toMatchObject({ isPrivate: true, confirmed: true });
  });

  it.each([undefined, [], ['read:user']])('blocks export without verified repository permissions: %j', async scopes => {
    const { exports, confirmation } = mockGitHub(scopes);
    await useStore.getState().exportToGitHub();
    expect(confirmation).not.toHaveBeenCalled();
    expect(exports).toHaveLength(0);
    expect(useStore.getState().githubExportInProgress).toBe(false);
  });

  it('cancelling the public confirmation never sends project files', async () => {
    const { exports, confirmation } = mockGitHub(['public_repo'], false);
    await useStore.getState().exportToGitHub();
    expect(confirmation).toHaveBeenCalledOnce();
    expect(exports).toHaveLength(0);
    expect(useStore.getState().githubExportInProgress).toBe(false);
  });

  it('requires a fresh confirmation when the GitHub connection changes after confirmation', async () => {
    const { exports, confirmation } = mockGitHub(['public_repo'], true, call => call === 1 ? 'first-connection' : 'second-connection');
    await useStore.getState().exportToGitHub();
    expect(confirmation).toHaveBeenCalledOnce();
    expect(exports).toHaveLength(0);
    expect(useStore.getState().githubExportInProgress).toBe(false);
  });

  it.each([1, 2])('does not send the old project after an account switch at auth check %s', async switchAt => {
    const { exports, confirmation } = mockGitHub(['public_repo'], true, call => {
      if (call === switchAt) selectDatabaseScope({ kind: 'account', userId: 'other-account' });
      return 'fixture-csrf';
    });
    await useStore.getState().exportToGitHub();
    expect(exports).toHaveLength(0);
    expect(confirmation).toHaveBeenCalledTimes(switchAt === 1 ? 0 : 1);
  });
});
