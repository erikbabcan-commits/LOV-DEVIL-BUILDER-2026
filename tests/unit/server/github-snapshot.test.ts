// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadGitHubSnapshot } from '../../../server/integrations/githubSnapshot';
import type { DbLike } from '../../../server/db/pool';

const selection = { projectId: 'p1', snapshotId: 's1', expectedRevision: 2 };
function fixture(sourceFiles: string | undefined = JSON.stringify([{ name: 'src/main.tsx', content: 'export const version = 1;' }])) {
  const workspace = { title: 'Export', isPublic: false, liveId: 's1', snapshots: [{ id: 's1', v: 1, prompt: 'Build', kind: 'manual', time: 'now', html: '<main>Exact legacy snapshot</main>', ...(sourceFiles === undefined ? {} : { sourceFiles }) }],
    files: [{ name: 'src/main.tsx', content: 'new unsaved content' }] };
  const row = { revision: 2, deleted_at: null as Date | null, workspace };
  const query = vi.fn<DbLike['query']>().mockResolvedValue({ rows: [row], rowCount: 1 });
  return { row, db: { query }, query };
}
describe('server-selected GitHub snapshot input', () => {
  it('uses historical sources, not the mutable current workspace, and pins a deterministic fingerprint', async () => {
    const { db, row, query } = fixture();
    const first = await loadGitHubSnapshot(db, 'alice', selection);
    expect(first).toMatchObject({ ok: true, files: [{ path: 'src/main.tsx', content: 'export const version = 1;' }] });
    row.workspace.files[0].content = 'different unsaved content';
    expect(await loadGitHubSnapshot(db, 'alice', selection)).toEqual(first);
    expect(query.mock.calls[0][1]).toEqual(['alice', 'p1']);
    if (!first.ok) throw new Error('Expected snapshot');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const other = await loadGitHubSnapshot(db, 'bob', selection);
    if (!other.ok) throw new Error('Fixture returns a row for both identities');
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });
  it('exports exact HTML for genuine legacy snapshots without inventing files', async () => {
    const { db, row } = fixture(); delete row.workspace.snapshots[0].sourceFiles;
    expect(await loadGitHubSnapshot(db, 'alice', selection)).toMatchObject({ ok: true, files: [{ path: 'index.html', content: '<main>Exact legacy snapshot</main>' }] });
  });
  it.each(['[]', 'not-json', JSON.stringify([{ name: '.env', content: 'private' }]), JSON.stringify([{ name: 'src/main.tsx', content: 'ghp_' + 'A'.repeat(36) }])])('rejects empty, corrupt, unsafe or secret sources: %s', async sources => {
    expect(await loadGitHubSnapshot(fixture(sources).db, 'alice', selection)).toEqual({ ok: false, error: 'invalid_sources' });
  });
  it('rejects unknown selection fields before reading storage', async () => {
    const { db, query } = fixture();
    expect(await loadGitHubSnapshot(db, 'alice', { ...selection, ...{ files: [] } })).toEqual({ ok: false, error: 'invalid_selection' });
    expect(query).not.toHaveBeenCalled();
  });
  it('reports deleted, stale and missing snapshots without producing export files', async () => {
    const { db, row } = fixture(); row.deleted_at = new Date();
    expect(await loadGitHubSnapshot(db, 'alice', selection)).toEqual({ ok: false, error: 'project_deleted' });
    row.deleted_at = null; row.revision = 3;
    expect(await loadGitHubSnapshot(db, 'alice', selection)).toEqual({ ok: false, error: 'project_conflict' });
    row.revision = 2;
    expect(await loadGitHubSnapshot(db, 'alice', { ...selection, snapshotId: 'missing' })).toEqual({ ok: false, error: 'snapshot_not_found' });
  });
});
