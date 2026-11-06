import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { selectDatabaseScope } from '../../src/services/persistence/db';
import type { ProjectZip } from '../../src/services/export/projectZip';
const mock = vi.hoisted(() => ({ create: vi.fn(), download: vi.fn() }));
vi.mock('../../src/services/export/projectZip', () => ({ createProjectZip: mock.create, downloadProjectZip: mock.download }));
beforeEach(() => {
  vi.useFakeTimers();
  useStore.getState().newProject();
  const snap = useStore.getState().createSnapshot('ai', 'ZIP fixture', '<h1>ZIP</h1>');
  useStore.setState({ liveId: snap.id, projectTitle: 'ZIP fixture', vfs: { [snap.id]: [
    { name: 'index.html', content: '<h1>ZIP</h1>', modified: false },
    { name: '.gitignore', content: 'node_modules\n.env\n', modified: false },
  ] } });
  mock.download.mockClear(); mock.create.mockClear();
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); selectDatabaseScope({ kind: 'pilot' });
});
describe('main source ZIP action', () => {
  it('passes every current VFS source without filtering .gitignore or replacing README', async () => {
    const bytes = new Uint8Array([1]), archive = { bytes, filename: 'project.zip', fileCount: 2 };
    mock.create.mockResolvedValueOnce(archive);
    const state = useStore.getState(); await state.exportToZip();
    expect(mock.create).toHaveBeenCalledWith(state.vfs[state.liveId!], state.projectTitle, 1);
    expect(mock.download).toHaveBeenCalledExactlyOnceWith(archive);
  });
  it.each(['account', 'project', 'version', 'files'])('never downloads a delayed previous export after changing %s', async change => {
    let finish!: (value: ProjectZip) => void;
    mock.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = useStore.getState().exportToZip();
    const state = useStore.getState();
    if (change === 'account') selectDatabaseScope({ kind: 'account', userId: 'other' });
    else if (change === 'project') useStore.getState().newProject();
    else if (change === 'version') useStore.setState({ viewing: { ...state.edSnap()!, id: 'another' } });
    else useStore.setState({ vfs: { ...state.vfs, [state.liveId!]: [{ name: 'index.html', content: 'changed', modified: true }] } });
    finish({ bytes: new Uint8Array([1]), filename: 'old.zip', fileCount: 1 }); await pending;
    expect(mock.download).not.toHaveBeenCalled();
  });
  it('does not download a partial result when source validation fails', async () => {
    mock.create.mockRejectedValueOnce(new Error('unsafe source'));
    await useStore.getState().exportToZip();
    expect(mock.download).not.toHaveBeenCalled();
  });
});
