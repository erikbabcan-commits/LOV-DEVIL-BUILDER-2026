import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../../src/stores/useAppStore';

describe('Zustand store (state transitions, D1/D2 parita)', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    useStore.setState({ mode: 'home', titleEditing: false });
    vi.clearAllTimers?.();
  });

  it('D1 parita: saveEdFile s null edFile uloží zobrazený súbor (fallback)', () => {
    const st = useStore.getState();
    const snap = st.createSnapshot('saas', 'test', '<html><head><style>x{y:z}</style></head><body><h1>D1</h1></body></html>');
    useStore.setState({ liveId: snap.id, liveHtml: snap.html, edFile: null });
    useStore.getState().saveEdFile('<html><body><h1>D1-SAVED</h1></body></html>');
    const after = useStore.getState().snapshots.find(s => s.id === snap.id)!;
    expect(after.html).toContain('D1-SAVED');
    expect(useStore.getState().edFile).not.toBeNull();
  });

  it('D2 parita: saveEdFile počas viewing NEmutuje historický snapshot', () => {
    const st = useStore.getState();
    const hist = st.createSnapshot('saas', 'hist', '<p>HIST-ORIGINAL</p>');
    const live = st.createSnapshot('saas', 'live', '<p>LIVE</p>');
    useStore.setState({ liveId: live.id, liveHtml: live.html, viewing: hist, edFile: 'index.html' });
    useStore.getState().saveEdFile('<p>HIST-HACKED</p>');
    const histAfter = useStore.getState().snapshots.find(s => s.id === hist.id)!;
    expect(histAfter.html).toBe('<p>HIST-ORIGINAL</p>');
  });

  it('snapshot restore: nemení históriu, prepne live', () => {
    const st = useStore.getState();
    const v1 = st.createSnapshot('saas', 'v1', '<p>V1</p>');
    const v2 = st.createSnapshot('saas', 'v2', '<p>V2</p>');
    useStore.getState().restoreSnapshot(v1.id);
    const s = useStore.getState();
    expect(s.liveHtml).toBe('<p>V1</p>');
    expect(s.viewing).toBeNull();
    expect(s.snapshots.length).toBe(2);
    expect(s.snapshots.find(x => x.id === v2.id)!.html).toBe('<p>V2</p>');
  });

  it('zoom clamp 50–150', () => {
    const st = useStore.getState();
    st.setZoom(200); expect(useStore.getState().zoomPct).toBe(150);
    st.setZoom(10); expect(useStore.getState().zoomPct).toBe(50);
    st.setZoom(75); expect(useStore.getState().zoomPct).toBe(75);
  });

  it('createSnapshot: deterministické verzovanie', () => {
    const st = useStore.getState();
    const a = st.createSnapshot('saas', 'a', '<p>a</p>');
    const b = st.createSnapshot('saas', 'b', '<p>b</p>');
    expect(a.v).toBe(1);
    expect(b.v).toBe(2);
    expect(useStore.getState().snapshots.length).toBe(2);
  });

  it('manualSnapshot bez HTML len upozorní (toast), snapshot nepridá', () => {
    const toastsBefore = useStore.getState().toasts.length;
    useStore.getState().manualSnapshot();
    expect(useStore.getState().snapshots.length).toBe(0);
    expect(useStore.getState().toasts.length).toBe(toastsBefore + 1);
    expect(useStore.getState().toasts[useStore.getState().toasts.length - 1].msg).toContain('Najprv');
  });
});
