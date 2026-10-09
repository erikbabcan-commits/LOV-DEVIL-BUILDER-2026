import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../src/stores/useAppStore';
import 'fake-indexeddb/auto';

/* Workstream C/F: store AI integrácia — applyStagedFiles, cancel, persistNow, restore. */

describe('Store M2 (AI + persistence)', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    useStore.setState({ aiMode: true, aiConnected: null, aiAbort: null });
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
