import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/stores/useAppStore';
import { filesFor } from '../../src/lib/vfs/filesFor';
import * as persistence from '../../src/services/persistence/projectStore';
import 'fake-indexeddb/auto';

describe('manual editor snapshot immutability', () => {
  it('creates a new revision without mutating prior source files', () => {
    vi.spyOn(persistence, 'persistProjectState').mockResolvedValue(null);
    useStore.getState().newProject();
    const old = useStore.getState().createSnapshot('manual', 'seed', '<html><body>Seed</body></html>');
    const source = filesFor(old).map(file => ({ ...file }));
    useStore.setState({ liveId: old.id, liveHtml: old.html, vfs: { [old.id]: source }, edFile: source[0].name });
    useStore.getState().saveEdFile('updated contents');
    const next = useStore.getState();
    expect(next.snapshots).toHaveLength(2);
    expect(next.snapshots[0]).toEqual(old);
    expect(next.liveId).not.toBe(old.id);
    expect(next.snapshots[1].v).toBeGreaterThan(old.v);
    expect(next.vfs[old.id]).toEqual(source);
    expect(next.vfs[next.liveId!][0].content).toBe('updated contents');
  });
});
