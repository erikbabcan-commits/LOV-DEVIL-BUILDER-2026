import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, saveProject, loadProjects, saveSnapshot, loadSnapshots, saveFile, loadFiles, saveRun, loadRuns, saveMeta, loadMeta, DB_VERSION, type StoredSnapshot } from '../../src/services/persistence/db';
import { persistProjectState, restoreWorkspace, nextRevision, type ProjectState } from '../../src/services/persistence/projectStore';

/* Workstream B/F: IndexedDB persistence — fake-indexeddb v jsdom prostredí.
   Používáme snake_case keys podľa IDB špecifikácie cez jsdom + fake-indexeddb. */

import 'fake-indexeddb/auto';

const pid = 'test-project';

beforeEach(async () => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const names = ['projects', 'snapshots', 'files', 'runs', 'meta'];
    const transaction = db.transaction(names, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    for (const name of names) transaction.objectStore(name).clear();
  });
});

function workspace(version = 1): ProjectState {
  return {
    project: { id: pid, title: 'CRM', createdAt: 1, updatedAt: version, liveSnapshotId: 's' + version, publishedUrl: null, isPublic: false },
    snapshots: Array.from({ length: version }, (_, index) => ({
      id: 's' + (index + 1), projectId: pid, v: index + 1, prompt: 'version ' + (index + 1),
      kind: 'ai', time: '10:00', html: '<p>v' + (index + 1) + '</p>', pinned: false,
    })),
    files: [{ projectId: pid, path: 'src/App.tsx', content: 'version ' + version, updatedAt: version, revision: version }],
  };
}

describe('IndexedDB persistence (Workstream B)', () => {
  it('štruktúra: projects, snapshots, files, runs, meta s verzionovanou schémou', async () => {
    const db = await openDb();
    expect(db.version).toBe(DB_VERSION);
    for (const name of ['projects', 'snapshots', 'files', 'runs', 'meta']) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
  });

  it('project save/load', async () => {
    await saveProject({ id: pid, title: 'CRM', createdAt: 1, updatedAt: 2, liveSnapshotId: null, publishedUrl: null, isPublic: false });
    const list = await loadProjects();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('CRM');
  });

  it('snapshot immutability: add() nesmie prepísať existujúci snapshot', async () => {
    const snap = { id: 's1', projectId: pid, v: 1, prompt: 'p', kind: 'saas', time: '10:00', html: '<p>ORIG</p>', pinned: false };
    await saveSnapshot(snap);
    // pokus o prepis toho istého id musí zlyhať (add = immutabilita histórie)
    await expect(saveSnapshot({ ...snap, html: '<p>HACKED</p>' })).rejects.toThrow();
    const loaded = await loadSnapshots(pid);
    expect(loaded[0].html).toBe('<p>ORIG</p>');
  });

  it('file stale-write protection: stará revízia neprepíše novšiu', async () => {
    await saveFile({ projectId: pid, path: 'src/App.tsx', content: 'v1', updatedAt: 1, revision: 2 });
    // revision 1 (stale) nesmie prepísať revision 2
    const applied = await saveFile({ projectId: pid, path: 'src/App.tsx', content: 'stale', updatedAt: 2, revision: 1 });
    expect(applied).toBe(false);
    const files = await loadFiles(pid);
    expect(files[0].content).toBe('v1');
    // revision 3 (novšia) prepíše
    const appliedNew = await saveFile({ projectId: pid, path: 'src/App.tsx', content: 'v3', updatedAt: 3, revision: 3 });
    expect(appliedNew).toBe(true);
    const files2 = await loadFiles(pid);
    expect(files2[0].content).toBe('v3');
  });

  it('file load len pre daný projekt', async () => {
    await saveFile({ projectId: 'a', path: 'src/x.ts', content: 'x', updatedAt: 1, revision: 1 });
    await saveFile({ projectId: 'b', path: 'src/y.ts', content: 'y', updatedAt: 1, revision: 1 });
    const filesB = await loadFiles('b');
    expect(filesB).toHaveLength(1);
    expect(filesB[0].path).toBe('src/y.ts');
  });

  it('runs save/load per projekt', async () => {
    await saveRun({ id: 'r1', projectId: pid, prompt: 'CRM', mode: 'create', status: 'completed', model: 'mistral', createdAt: 1, planSummary: 's', fileCount: 5 });
    await saveRun({ id: 'r2', projectId: 'other', prompt: 'x', mode: 'create', status: 'failed', model: 'mistral', createdAt: 2, planSummary: null, fileCount: 0 });
    const runs = await loadRuns(pid);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('meta: lastProject', async () => {
    await saveMeta('lastProject', pid);
    expect(await loadMeta<string>('lastProject')).toBe(pid);
    expect(await loadMeta('missing')).toBeNull();
  });

  it('refresh recovery: ulož a obnov celý workspace', async () => {
    await saveProject({ id: pid, title: 'CRM', createdAt: 1, updatedAt: 1, liveSnapshotId: 's9', publishedUrl: null, isPublic: false });
    await saveSnapshot({ id: 's9', projectId: pid, v: 1, prompt: 'CRM dashboard', kind: 'ai', time: '10:00', html: '<p>CRM</p>', pinned: false });
    await saveFile({ projectId: pid, path: 'src/App.tsx', content: 'export default () => <h1>CRM</h1>;', updatedAt: 1, revision: 1 });
    const projects = await loadProjects();
    const project = projects.find(p => p.id === pid)!;
    const snaps = await loadSnapshots(pid);
    const files = await loadFiles(pid);
    expect(project.liveSnapshotId).toBe('s9');
    expect(snaps[0].html).toBe('<p>CRM</p>');
    expect(files[0].content).toContain('CRM');
  });
});

describe('atomic project-state persistence', () => {
  it('saves a second version and restores its live pointer, history and source', async () => {
    const first = workspace();
    const second = workspace(2);
    expect(await persistProjectState(first)).toBeNull();
    expect(await persistProjectState(second)).toBeNull();

    const restored = await restoreWorkspace();
    expect(restored.project).toEqual(second.project);
    expect(restored.snapshots).toEqual(second.snapshots);
    expect(restored.files).toEqual(second.files);
    expect(await loadMeta('lastProject')).toBe(pid);
  });

  it('retries identical state idempotently even if snapshot property order changes', async () => {
    const state = workspace(2);
    expect(await persistProjectState(state)).toBeNull();
    const reordered = state.snapshots.map(snapshot => Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as StoredSnapshot);
    expect(await persistProjectState({ ...state, snapshots: reordered })).toBeNull();
    expect(await loadSnapshots(pid)).toEqual(state.snapshots);
    expect(await loadFiles(pid)).toEqual(state.files);
  });

  it('persists pin and unpin metadata without changing immutable snapshot content', async () => {
    const state = workspace();
    state.snapshots[0] = { ...state.snapshots[0], runId: 'run-1', model: 'fixture-model' };
    expect(await persistProjectState(state)).toBeNull();
    expect(await persistProjectState({ ...state, snapshots: [{ ...state.snapshots[0], pinned: true }] })).toBeNull();
    expect(await loadSnapshots(pid)).toEqual([{ ...state.snapshots[0], pinned: true }]);
    expect(await persistProjectState(state)).toBeNull();
    expect(await loadSnapshots(pid)).toEqual(state.snapshots);
  });

  it('rolls back the project, inserted snapshots, pinned metadata, files and lastProject on immutable conflict', async () => {
    const initial = workspace(2);
    expect(await persistProjectState(initial)).toBeNull();
    await saveMeta('lastProject', 'other-project');
    const attempted = workspace(3);
    attempted.project.title = 'must roll back';
    attempted.snapshots = [
      { ...initial.snapshots[0], pinned: true },
      attempted.snapshots[2],
      { ...initial.snapshots[1], html: '<p>overwritten history</p>' },
    ];

    expect(await persistProjectState(attempted)).toEqual({ kind: 'io', message: 'Error: Immutable snapshot conflict' });
    expect(await loadProjects()).toEqual([initial.project]);
    expect(await loadSnapshots(pid)).toEqual(initial.snapshots);
    expect(await loadFiles(pid)).toEqual(initial.files);
    expect(await loadMeta('lastProject')).toBe('other-project');
  });

  it('rolls back prior writes when a later file cannot be cloned by IndexedDB', async () => {
    const initial = workspace();
    expect(await persistProjectState(initial)).toBeNull();
    await saveMeta('lastProject', 'other-project');
    const attempted = workspace(2);
    attempted.files.push({
      projectId: pid, path: 'src/broken.ts', content: (() => 'not cloneable') as unknown as string,
      updatedAt: 2, revision: 3,
    });

    expect(await persistProjectState(attempted)).toMatchObject({ kind: 'io' });
    expect(await loadProjects()).toEqual([initial.project]);
    expect(await loadSnapshots(pid)).toEqual(initial.snapshots);
    expect(await loadFiles(pid)).toEqual(initial.files);
    expect(await loadMeta('lastProject')).toBe('other-project');
  });

  it('rejects an older file revision without advancing any part of the workspace', async () => {
    const initial = workspace();
    initial.files[0].revision = 10;
    initial.files.push({ ...initial.files[0], path: 'src/newer-file.ts', content: 'must survive a stale deletion' });
    expect(await persistProjectState(initial)).toBeNull();
    const attempted = workspace(2);
    expect(await persistProjectState(attempted)).toEqual({ kind: 'io', message: 'Error: Stale file revision' });
    expect(await loadProjects()).toEqual([initial.project]);
    expect(await loadSnapshots(pid)).toEqual(initial.snapshots);
    expect(await loadFiles(pid)).toEqual(initial.files);
    expect(await loadMeta('lastProject')).toBe(pid);
  });

  it('keeps the newest duplicate file revision and can retry the same batch', async () => {
    const state = workspace(2);
    state.files = [state.files[0], workspace().files[0]];
    expect(await persistProjectState(state)).toBeNull();
    expect(await persistProjectState(state)).toBeNull();
    expect(await loadFiles(pid)).toEqual([state.files[0]]);
  });

  it('atomically removes absent live files while preserving other projects', async () => {
    const initial = workspace();
    initial.files.push({ ...initial.files[0], path: 'src/removed.ts', content: 'remove me' });
    expect(await persistProjectState(initial)).toBeNull();
    const otherFile = { ...initial.files[0], projectId: 'other-project', content: 'other project' };
    await saveFile(otherFile);

    const next = workspace(2);
    expect(await persistProjectState(next)).toBeNull();
    expect((await restoreWorkspace()).files).toEqual(next.files);
    expect(await loadFiles('other-project')).toEqual([otherFile]);
    expect(await persistProjectState({ ...next, files: [] })).toBeNull();
    expect(await loadFiles(pid)).toEqual([]);
    expect(await loadFiles('other-project')).toEqual([otherFile]);
  });

  it.each(['missing', 'other-snapshot'])('rejects an invalid live snapshot %s without committing a dangling pointer', async liveSnapshotId => {
    const initial = workspace();
    expect(await persistProjectState(initial)).toBeNull();
    await saveSnapshot({ ...initial.snapshots[0], id: 'other-snapshot', projectId: 'other-project' });
    const attempted = workspace(2);
    attempted.project.liveSnapshotId = liveSnapshotId;

    expect(await persistProjectState(attempted)).toEqual({ kind: 'io', message: 'Error: Live snapshot is missing or belongs to a different project' });
    expect(await loadProjects()).toEqual([initial.project]);
    expect(await loadSnapshots(pid)).toEqual(initial.snapshots);
    expect(await loadFiles(pid)).toEqual(initial.files);
    expect(await loadMeta('lastProject')).toBe(pid);
  });

  it('resumes nextRevision beyond stored revisions after restoring a workspace', async () => {
    const state = workspace();
    const persistedRevision = nextRevision() + 100;
    state.files[0].revision = persistedRevision;
    expect(await persistProjectState(state)).toBeNull();
    await restoreWorkspace();
    const resumedRevision = nextRevision();
    expect(resumedRevision).toBeGreaterThan(persistedRevision);
    const next = workspace(2);
    next.files[0].revision = resumedRevision;
    expect(await persistProjectState(next)).toBeNull();
    expect(await loadFiles(pid)).toEqual(next.files);
  });
});
