import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, saveProject, loadProjects, saveSnapshot, loadSnapshots, saveFile, loadFiles, saveRun, loadRuns, saveMeta, loadMeta, DB_VERSION } from '../../src/services/persistence/db';

/* Workstream B/F: IndexedDB persistence — fake-indexeddb v jsdom prostredí.
   Používáme snake_case keys podľa IDB špecifikácie cez jsdom + fake-indexeddb. */

import 'fake-indexeddb/auto';

const pid = 'test-project';

beforeEach(async () => {
  const db = await openDb();
  for (const name of ['projects', 'snapshots', 'files', 'runs', 'meta']) {
    db.transaction(name, 'readwrite').objectStore(name).clear();
  }
});

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
