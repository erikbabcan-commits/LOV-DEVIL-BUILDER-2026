import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RollbackDialog } from '../../src/features/publish/RollbackDialog';

/* Bora W2 P2-1: the dialog must send the live version token from GET …/versions as
   expectedVersion (never a hard-coded null) and reload the list after a 409. */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';
const V2 = '44444444-4444-4444-8444-444444444444';
const row = (requestId: string, revision: number, isLive: boolean) => ({
  requestId, revision, snapshotId: 'snap-' + revision, createdAt: '2026-11-20T18:00:00.000Z', artifactBytes: 100, isLive,
});

let liveVersion = V1;
let rollbackResponses: Response[];
let posts: Array<{ requestId: string; expectedVersion: string | null; confirmed: true }>;

beforeEach(() => {
  liveVersion = V1;
  posts = [];
  rollbackResponses = [];
  document.cookie = 'lov_csrf=rollback-fixture; Path=/';
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/versions')) return Response.json({ liveVersion, versions: [row(B, 2, true), row(A, 1, false)] });
    if (path.endsWith('/rollback')) {
      posts.push(JSON.parse(String(init?.body)));
      return rollbackResponses.shift() ?? Response.json({ error: 'publish_unavailable' }, { status: 503 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function confirmAndSubmit() {
  await screen.findByText(/Revízia 1/);
  fireEvent.click(screen.getByRole('checkbox', { name: /Potvrdzujem prepnutie/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Obnoviť zvolenú verziu' }));
}

describe('RollbackDialog live version token', () => {
  it('sends the liveVersion from GET versions as expectedVersion', async () => {
    rollbackResponses.push(Response.json({ url: 'x', version: V2, current: { requestId: A, revision: 1 }, previous: null, elapsedMs: 1 }));
    const onClose = vi.fn(), onRolledBack = vi.fn();
    render(<RollbackDialog projectId="project-one" onClose={onClose} onRolledBack={onRolledBack} />);
    await confirmAndSubmit();
    await waitFor(() => expect(onRolledBack).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ requestId: A, expectedVersion: V1, confirmed: true }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('after a 409 publish_live_conflict it reloads the token, asks for a fresh confirmation and retries with the new token', async () => {
    rollbackResponses.push(Response.json({ error: 'publish_live_conflict' }, { status: 409 }));
    const onClose = vi.fn();
    render(<RollbackDialog projectId="project-one" onClose={onClose} />);
    await screen.findByText(/Revízia 1/);
    liveVersion = V2; // someone else switched the live address meanwhile
    await confirmAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Živá verzia sa medzitým zmenila');
    expect(screen.getByRole('checkbox', { name: /Potvrdzujem prepnutie/ })).not.toBeChecked();
    expect(onClose).not.toHaveBeenCalled();

    rollbackResponses.push(Response.json({ url: 'x', version: V1, current: { requestId: A, revision: 1 }, previous: null, elapsedMs: 1 }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potvrdzujem prepnutie/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Obnoviť zvolenú verziu' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts.map((p) => p.expectedVersion)).toEqual([V1, V2]);
  });
});
