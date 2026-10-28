import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureReviewBase, useStore } from '../../src/stores/useAppStore';
import * as aiClient from '../../src/services/ai/client';
import type { AgentEvent, GeneratedFile } from '../../src/services/ai/types';
import { filesFor } from '../../src/lib/vfs/filesFor';
import * as projectPersistence from '../../src/services/persistence/projectStore';
import 'fake-indexeddb/auto';

/* Workstream C/F: store AI integrácia — applyStagedFiles, cancel, persistNow, restore. */

const change: GeneratedFile[] = [{ path: 'src/App.tsx', content: 'export default () => <nav>AI CHANGE</nav>', action: 'create' }];

function stagedReview(runId = 'run-fixture', files = change) {
  return { runId, prompt: 'pridaj sidebar', files, base: captureReviewBase(useStore.getState()) };
}

function seedSnapshot(html = '<p>pôvodný projekt</p>') {
  const snapshot = useStore.getState().createSnapshot('ai', 'CRM', html);
  useStore.setState({ liveId: snapshot.id, liveHtml: snapshot.html, viewing: null });
  return snapshot;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function* successfulEvents(runId: string, gate?: Promise<void>): AsyncGenerator<AgentEvent> {
  yield { type: 'run_started', runId, model: 'mock' };
  if (gate) await gate;
  yield { type: 'validation', result: { ok: true, errors: [] } };
  yield { type: 'stage', files: change };
  yield { type: 'done', runId, summary: 'Ready for review' };
}

describe('Store M2 (AI + persistence)', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    useStore.setState({ aiMode: true, aiConnected: null, aiAbort: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applyStagedFiles: AI súbory sa aplikujú do VFS (create + modify + delete)', () => {
    const st = useStore.getState();
    const snap = st.createSnapshot('ai', 'CRM prompt', '<html><head><style>x{y:z}</style></head><body><h1>CRM</h1></body></html>');
    useStore.setState({ liveId: snap.id, liveHtml: snap.html, viewing: null });

    useStore.getState().applyStagedFiles([
      { path: 'src/App.tsx', content: 'export default () => <h1>CRM v2</h1>;', action: 'create' },
      { path: 'src/components/Sidebar.tsx', content: 'export default () => <nav/>;', action: 'create' },
    ]);
    const s = useStore.getState();
    const files = s.vfs[snap.id] ?? [];
    expect(files.find(f => f.name === 'src/App.tsx')?.content).toContain('CRM v2');
    expect(files.find(f => f.name === 'src/components/Sidebar.tsx')?.content).toContain('<nav/>');

    // modify
    useStore.getState().applyStagedFiles([{ path: 'src/App.tsx', content: 'export default () => <h1>CRM v3</h1>;', action: 'modify' }]);
    expect((useStore.getState().vfs[snap.id] ?? []).find(f => f.name === 'src/App.tsx')?.content).toContain('v3');

    // delete
    useStore.getState().applyStagedFiles([{ path: 'src/components/Sidebar.tsx', content: '', action: 'delete' }]);
    expect((useStore.getState().vfs[snap.id] ?? []).find(f => f.name === 'src/components/Sidebar.tsx')).toBeUndefined();
  });

  it('applyStagedFiles bez snapshotu: warn toast, nič nepadne', () => {
    useStore.getState().applyStagedFiles([{ path: 'x', content: 'y', action: 'create' }]);
    expect(useStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it('cancelAiRun: abort controller sa abortne a generating sa vypne', () => {
    const ac = new AbortController();
    useStore.setState({ aiAbort: ac, generating: true });
    useStore.getState().cancelAiRun();
    expect(ac.signal.aborted).toBe(true);
    expect(useStore.getState().generating).toBe(false);
    expect(useStore.getState().aiAbort).toBeNull();
  });

  it('Reject: stage neprepisuje existujúci projekt', () => {
    const st = useStore.getState();
    const snap = st.createSnapshot('ai', 'CRM', '<p>pôvodný projekt</p>');
    useStore.setState({ liveId: snap.id, liveHtml: snap.html });
    useStore.setState({ pendingReview: stagedReview('run-reject') });
    useStore.getState().rejectStagedRun();
    expect(useStore.getState().pendingReview).toBeNull();
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().liveHtml).toBe('<p>pôvodný projekt</p>');
    expect(useStore.getState().vfs[snap.id]).toBeUndefined();
  });

  it('Approve: tvorí obnoviteľný snapshot; opakovaný klik je idempotentný', () => {
    const st = useStore.getState();
    const snap = st.createSnapshot('ai', 'CRM', '<p>v1</p>');
    useStore.setState({ liveId: snap.id, liveHtml: snap.html });
    useStore.setState({ pendingReview: stagedReview('run-approve') });
    useStore.getState().approveStagedRun();
    useStore.getState().approveStagedRun();
    const next = useStore.getState();
    expect(next.snapshots).toHaveLength(2);
    expect(next.pendingReview).toBeNull();
    expect(next.liveId).not.toBe(snap.id);
    expect(next.vfs[next.liveId!].find(f => f.name === 'src/App.tsx')?.content).toContain('AI CHANGE');
    expect(next.snapshots[0].html).toBe('<p>v1</p>');
  });

  it('Approve rejects a review after the project identity changes without touching its data', () => {
    const snapshot = seedSnapshot();
    useStore.setState({ pendingReview: stagedReview() });
    useStore.setState({ projectId: 'different-project' });
    const before = useStore.getState();
    useStore.getState().approveStagedRun();
    const after = useStore.getState();
    expect(after.pendingReview).toBeNull();
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.vfs).toEqual(before.vfs);
    expect(after.liveId).toBe(snapshot.id);
    expect(after.liveHtml).toBe(snapshot.html);
    expect(after.toasts.at(-1)?.msg).toContain('zastaraný');
  });

  it('Approve rejects a review after restoring another snapshot', () => {
    const first = seedSnapshot('<p>v1</p>');
    const second = seedSnapshot('<p>v2</p>');
    useStore.setState({ pendingReview: stagedReview() });
    useStore.getState().restoreSnapshot(first.id);
    useStore.getState().approveStagedRun();
    const state = useStore.getState();
    expect(state.pendingReview).toBeNull();
    expect(state.snapshots).toHaveLength(2);
    expect(state.liveId).toBe(first.id);
    expect(state.liveHtml).toBe(first.html);
    expect(state.snapshots.find(snapshot => snapshot.id === second.id)?.html).toBe('<p>v2</p>');
    expect(state.vfs[first.id]).toBeUndefined();
  });

  it('Approve rejects a review after saving an edit to the same snapshot', () => {
    const snapshot = seedSnapshot();
    useStore.setState({ pendingReview: stagedReview() });
    useStore.getState().saveEdFile('<p>MANUAL EDIT</p>');
    const edited = useStore.getState();
    useStore.getState().approveStagedRun();
    const after = useStore.getState();
    expect(after.pendingReview).toBeNull();
    expect(after.snapshots).toHaveLength(1);
    expect(after.liveId).toBe(snapshot.id);
    expect(after.liveHtml).toContain('MANUAL EDIT');
    expect(after.vfs).toEqual(edited.vfs);
    expect(after.vfs[snapshot.id].some(file => file.name === 'src/App.tsx')).toBe(false);
  });

  it('Approve rejects a review when a manual editor draft is open', () => {
    seedSnapshot();
    useStore.setState({ pendingReview: stagedReview() });
    useStore.getState().startEdEditing();
    useStore.getState().approveStagedRun();
    expect(useStore.getState().pendingReview).toBeNull();
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().edEditing).toBe(true);
  });

  it('Approve rejects a source-only edit even when the rendered HTML stays identical', () => {
    const snapshot = seedSnapshot();
    useStore.getState().applyStagedFiles([{ path: 'src/data.ts', content: 'export const value = 1;', action: 'create' }]);
    const html = useStore.getState().liveHtml;
    useStore.setState({ pendingReview: stagedReview() });
    useStore.getState().setEdFile('src/data.ts');
    useStore.getState().saveEdFile('export const value = 2;');
    expect(useStore.getState().liveHtml).toBe(html);
    useStore.getState().approveStagedRun();
    const state = useStore.getState();
    expect(state.pendingReview).toBeNull();
    expect(state.snapshots).toHaveLength(1);
    expect(state.vfs[snapshot.id].find(file => file.name === 'src/data.ts')?.content).toBe('export const value = 2;');
    expect(state.vfs[snapshot.id].some(file => file.name === 'src/App.tsx')).toBe(false);
  });

  it('newProject changes identity and clears a pending review', () => {
    seedSnapshot();
    const projectId = useStore.getState().projectId;
    useStore.setState({ pendingReview: stagedReview() });
    useStore.getState().newProject();
    useStore.getState().approveStagedRun();
    const state = useStore.getState();
    expect(state.projectId).not.toBe(projectId);
    expect(state.pendingReview).toBeNull();
    expect(state.snapshots).toHaveLength(0);
    expect(state.vfs).toEqual({});
    expect(state.liveHtml).toBeNull();
  });

  it('binds the stage to the invocation context and allows unchanged approval', async () => {
    const snapshot = seedSnapshot();
    const base = captureReviewBase(useStore.getState());
    const stream = vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-bound'));
    await useStore.getState().generateWithAi('pridaj sidebar', 'iterate');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingReview?.base).toEqual(base);
    expect(useStore.getState().snapshots).toHaveLength(1);
    useStore.getState().approveStagedRun();
    useStore.getState().approveStagedRun();
    expect(useStore.getState().snapshots).toHaveLength(2);
    expect(useStore.getState().snapshots[0].html).toBe(snapshot.html);
    expect(useStore.getState().pendingReview).toBeNull();
  });

  it('sends only the current snapshot files even with more than 40 historical files', async () => {
    const historical = seedSnapshot('<p>historical</p>');
    const current = seedSnapshot('<p>current</p>');
    const currentFiles = [
      { name: 'src/App.tsx', content: 'export default () => <h1>CURRENT</h1>;', modified: false },
      { name: 'src/current.ts', content: 'export const current = true;', modified: false },
    ];
    useStore.setState({ vfs: {
      [historical.id]: Array.from({ length: 45 }, (_, index) => ({
        name: `src/historical-${index}.ts`, content: `export const historical = ${index};`, modified: false,
      })),
      [current.id]: currentFiles,
    } });
    const stream = vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-current-only'));
    await useStore.getState().generateWithAi('zmeň aktuálnu verziu', 'iterate');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0][0].context?.files).toEqual(currentFiles.map(file => ({ path: file.name, content: file.content })));
    expect(useStore.getState().pendingReview?.base.snapshotId).toBe(current.id);
  });

  it('sends the selected viewing snapshot instead of mixing it with live files', async () => {
    const viewing = seedSnapshot('<p>viewing</p>');
    const live = seedSnapshot('<p>live</p>');
    const selectedFiles = [{ name: 'src/App.tsx', content: 'export default () => <h1>VIEWING</h1>;', modified: false }];
    useStore.setState({ vfs: {
      [viewing.id]: selectedFiles,
      [live.id]: [{ name: 'src/App.tsx', content: 'export default () => <h1>LIVE</h1>;', modified: false }],
    } });
    useStore.getState().viewSnapshot(viewing.id);
    const stream = vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-viewing-only'));
    await useStore.getState().generateWithAi('uprav prezeranú verziu', 'iterate');
    expect(stream.mock.calls[0][0].context?.files).toEqual(selectedFiles.map(file => ({ path: file.name, content: file.content })));
    expect(useStore.getState().pendingReview?.base.snapshotId).toBe(viewing.id);
    expect(useStore.getState().liveId).toBe(live.id);
  });

  it('derives context files from the selected snapshot when its VFS is not materialized', async () => {
    const historical = seedSnapshot('<p>historical</p>');
    const current = seedSnapshot('<p>CURRENT FALLBACK</p>');
    useStore.setState({ vfs: {
      [historical.id]: [{ name: 'src/obsolete.ts', content: 'export const obsolete = true;', modified: false }],
    } });
    const stream = vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-fallback'));
    await useStore.getState().generateWithAi('uprav aktuálnu verziu', 'iterate');
    expect(stream.mock.calls[0][0].context?.files).toEqual(filesFor(current).map(file => ({ path: file.name, content: file.content })));
    expect(useStore.getState().pendingReview?.base.snapshotId).toBe(current.id);
    expect(useStore.getState().vfs[current.id]).toBeUndefined();
  });

  it('does not start a run over an unsaved editor draft', async () => {
    seedSnapshot();
    const stream = vi.spyOn(aiClient, 'streamAgentEvents');
    useStore.getState().startEdEditing();
    await useStore.getState().generateWithAi('pridaj sidebar', 'iterate');
    expect(stream).not.toHaveBeenCalled();
    expect(useStore.getState().generating).toBe(false);
    expect(useStore.getState().edEditing).toBe(true);
    expect(useStore.getState().pendingReview).toBeNull();
  });

  it('does not create a review when the source content changes while the stream is running', async () => {
    seedSnapshot();
    const gate = deferred();
    vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-edited', gate.promise));
    const running = useStore.getState().generateWithAi('pridaj sidebar', 'iterate');
    useStore.getState().saveEdFile('<p>EDIT DURING RUN</p>');
    gate.resolve();
    await running;
    const state = useStore.getState();
    expect(state.pendingReview).toBeNull();
    expect(state.snapshots).toHaveLength(1);
    expect(state.liveHtml).toContain('EDIT DURING RUN');
    expect(state.generating).toBe(false);
    expect(state.toasts.at(-1)?.msg).toContain('zastaraný');
  });

  it('drops a previous project response even if its mocked transport ignores abort', async () => {
    seedSnapshot();
    const gate = deferred();
    vi.spyOn(aiClient, 'streamAgentEvents').mockImplementation(() => successfulEvents('run-old-project', gate.promise));
    const running = useStore.getState().generateWithAi('pridaj sidebar', 'iterate');
    const previousController = useStore.getState().aiAbort;
    useStore.getState().newProject();
    gate.resolve();
    await running;
    const state = useStore.getState();
    expect(previousController?.signal.aborted).toBe(true);
    expect(state.pendingReview).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.snapshots).toEqual([]);
    expect(state.liveHtml).toBeNull();
    expect(state.generating).toBe(false);
  });

  it('late completion of a cancelled run cannot clear or stage over a newer run', async () => {
    seedSnapshot();
    const firstGate = deferred();
    const secondGate = deferred();
    const stream = vi.spyOn(aiClient, 'streamAgentEvents');
    stream.mockImplementationOnce(() => successfulEvents('run-first', firstGate.promise));
    stream.mockImplementationOnce(() => successfulEvents('run-second', secondGate.promise));
    const first = useStore.getState().generateWithAi('prvý run', 'iterate');
    useStore.getState().cancelAiRun();
    const second = useStore.getState().generateWithAi('druhý run', 'iterate');
    const secondController = useStore.getState().aiAbort;
    firstGate.resolve();
    await first;
    expect(useStore.getState().aiAbort).toBe(secondController);
    expect(useStore.getState().generating).toBe(true);
    expect(useStore.getState().pendingReview).toBeNull();
    secondGate.resolve();
    await second;
    expect(useStore.getState().pendingReview?.runId).toBe('run-second');
    expect(useStore.getState().generating).toBe(false);
  });

  it('persistNow saves only live files, excluding historical deletions even while viewing history', async () => {
    const historical = seedSnapshot('<p>historical</p>');
    const live = seedSnapshot('<p>live</p>');
    useStore.setState({ vfs: {
      [historical.id]: [
        { name: 'src/App.tsx', content: 'OLD CONTENT', modified: false },
        { name: 'src/deleted.ts', content: 'SHOULD STAY DELETED', modified: false },
      ],
      [live.id]: [{ name: 'src/App.tsx', content: 'LIVE CONTENT', modified: false }],
    } });
    useStore.getState().viewSnapshot(historical.id);
    const persist = vi.spyOn(projectPersistence, 'persistProjectState').mockResolvedValue(null);
    await useStore.getState().persistNow();
    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0][0];
    expect(payload.project.liveSnapshotId).toBe(live.id);
    expect(payload.files.map(file => ({ path: file.path, content: file.content }))).toEqual([
      { path: 'src/App.tsx', content: 'LIVE CONTENT' },
    ]);
    expect(payload.snapshots.map(snapshot => snapshot.id)).toEqual([historical.id, live.id]);
    expect(useStore.getState().viewing?.id).toBe(historical.id);
    expect(useStore.getState().vfs[historical.id]).toHaveLength(2);
  });

  it('persistNow derives files from the live snapshot when its VFS is not materialized', async () => {
    const historical = seedSnapshot('<p>historical</p>');
    const live = seedSnapshot('<p>LIVE FALLBACK</p>');
    useStore.setState({ vfs: {
      [historical.id]: [{ name: 'src/obsolete.ts', content: 'OBSOLETE', modified: false }],
    } });
    useStore.getState().viewSnapshot(historical.id);
    const persist = vi.spyOn(projectPersistence, 'persistProjectState').mockResolvedValue(null);
    await useStore.getState().persistNow();
    const payload = persist.mock.calls[0][0];
    expect(payload.project.liveSnapshotId).toBe(live.id);
    expect(payload.files.map(file => ({ path: file.path, content: file.content }))).toEqual(
      filesFor(live).map(file => ({ path: file.name, content: file.content })),
    );
  });

  it('persistNow saves no files when there is no live snapshot instead of using history', async () => {
    const historical = seedSnapshot('<p>historical</p>');
    useStore.setState({ liveId: null, vfs: {
      [historical.id]: [{ name: 'src/obsolete.ts', content: 'OBSOLETE', modified: false }],
    } });
    useStore.getState().viewSnapshot(historical.id);
    const persist = vi.spyOn(projectPersistence, 'persistProjectState').mockResolvedValue(null);
    await useStore.getState().persistNow();
    const payload = persist.mock.calls[0][0];
    expect(payload.project.liveSnapshotId).toBeNull();
    expect(payload.files).toEqual([]);
    expect(payload.snapshots.map(snapshot => snapshot.id)).toEqual([historical.id]);
  });

  it('persistNow + immutabilné snapshoty v DB: história sa nezmení pri novej verzii', async () => {
    const st = useStore.getState();
    const snap1 = st.createSnapshot('ai', 'v1 prompt', '<p>V1</p>');
    useStore.setState({ liveId: snap1.id, liveHtml: snap1.html });
    await useStore.getState().persistNow();
    // nová verzia
    const snap2 = useStore.getState().createSnapshot('ai', 'v2 prompt', '<p>V2</p>');
    useStore.setState({ liveId: snap2.id, liveHtml: snap2.html });
    await useStore.getState().persistNow();
    // snapshot1 ostáva immutabilný
    const { loadSnapshots } = await import('../../src/services/persistence/db');
    const snaps = await loadSnapshots(useStore.getState().projectId);
    const s1 = snaps.find(s => s.id === snap1.id);
    expect(s1?.html).toBe('<p>V1</p>');
  });

  it('restoreFromDb: projekt sa obnoví po "refreshi"', async () => {
    const st = useStore.getState();
    const snap = st.createSnapshot('ai', 'CRM', '<p>CRM RESTORE</p>');
    useStore.setState({ liveId: snap.id, liveHtml: snap.html, projectTitle: 'Moj CRM' });
    await useStore.getState().persistNow();

    // simuluj refresh: nový store obsah
    useStore.getState().newProject();
    expect(useStore.getState().liveHtml).toBeNull();

    await useStore.getState().restoreFromDb();
    const restored = useStore.getState();
    expect(restored.liveHtml).toContain('CRM RESTORE');
    expect(restored.projectTitle).toBe('Moj CRM');
  });
});
