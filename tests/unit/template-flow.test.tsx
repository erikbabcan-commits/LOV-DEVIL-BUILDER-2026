import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { BLUEPRINT_REGISTRY } from '../../src/templates/registry';
import { brandBlueprint } from '../../src/templates/factory';
import { TemplateGallery } from '../../src/features/templates/TemplateGallery';
import { ReviewPanel } from '../../src/features/workspace/ReviewPanel';
import { LandingPage } from '../../src/features/landing/LandingPage';
import { loadSnapshots } from '../../src/services/persistence/db';

const blueprint = () => brandBlueprint(BLUEPRINT_REGISTRY[1], { name: 'Moje štúdio', color: '#2563eb' });
beforeEach(() => { useStore.getState().newProject(); useStore.setState({ mode: 'home', toasts: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('template review and composer flow', () => {
  it('stages without AI or overwriting the current project; reject is lossless', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const old = useStore.getState().createSnapshot('manual', 'pôvodný', '<p>old</p>');
    useStore.setState({ liveId: old.id, liveHtml: old.html });
    useStore.getState().stageTemplate(blueprint());
    expect(useStore.getState().liveHtml).toBe(old.html);
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().pendingReview?.source).toBe('template');
    expect(fetch).not.toHaveBeenCalled();
    useStore.getState().rejectStagedRun();
    expect(useStore.getState().pendingReview).toBeNull();
    expect(useStore.getState().liveId).toBe(old.id);
  });

  it('applies a complete new version, removes obsolete sources and preserves the old VFS', () => {
    const old = useStore.getState().createSnapshot('manual', 'old', '<p>old</p>');
    useStore.setState({ liveId: old.id, liveHtml: old.html, vfs: { [old.id]: [{ name: 'src/obsolete.ts', content: 'old', modified: false }] } });
    useStore.getState().stageTemplate(blueprint());
    expect(useStore.getState().approveStagedRun()).toBe(true);
    expect(useStore.getState().approveStagedRun()).toBe(false);
    const state = useStore.getState();
    expect(state.snapshots).toHaveLength(2);
    expect(state.vfs[state.liveId!]).toHaveLength(13);
    expect(state.vfs[state.liveId!].some(file => file.name === 'src/obsolete.ts')).toBe(false);
    expect(state.vfs[old.id][0].content).toBe('old');
    expect(state.templateFollowups).toHaveLength(3);
    expect(state.projectTitle).toBe('Kanban board');
  });

  it('does not apply a stale template review or start compilation', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    useStore.getState().stageTemplate(blueprint());
    useStore.getState().setTitle('Changed while reviewing');
    render(<ReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Použiť zmeny' }));
    expect(useStore.getState().snapshots).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('filters the gallery, customizes a template and opens real file review', () => {
    render(<TemplateGallery />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kanban' } });
    expect(screen.getByRole('status')).toHaveTextContent('1 z 12');
    fireEvent.click(screen.getByRole('button', { name: /Použiť šablónu/ }));
    const form = screen.getByRole('form', { name: 'Prispôsobiť šablónu' });
    fireEvent.change(within(form).getByLabelText('Názov značky'), { target: { value: 'Studio Board' } });
    fireEvent.click(within(form).getByRole('button', { name: /Prezrieť súbory/ }));
    const review = useStore.getState().pendingReview;
    expect(review?.files.find(file => file.path === 'src/brand.ts')?.content).toContain('Studio Board');
    expect(useStore.getState().mode).toBe('work');
  });

  it('prompt handoff actually fills the home composer without generating', () => {
    useStore.getState().usePrompt('Postav web pre [značku]');
    render(<LandingPage />);
    expect(screen.getByRole('textbox', { name: 'Tvoj nápad' })).toHaveValue('Postav web pre [značku]');
    expect(useStore.getState().generating).toBe(false);
    expect(useStore.getState().snapshots).toHaveLength(0);
  });

  it('keeps historical React sources after persistence and reload; manual checkpoints copy sources', async () => {
    useStore.getState().stageTemplate(blueprint()); useStore.getState().approveStagedRun();
    const first = useStore.getState().liveId!;
    useStore.getState().manualSnapshot();
    const manual = useStore.getState().liveId!;
    expect(useStore.getState().vfs[manual]).toEqual(useStore.getState().vfs[first]);
    expect(useStore.getState().vfs[manual]).not.toBe(useStore.getState().vfs[first]);
    useStore.getState().stageTemplate(BLUEPRINT_REGISTRY[4]); useStore.getState().approveStagedRun();
    await useStore.getState().persistNow();
    const projectId = useStore.getState().projectId;
    expect((await loadSnapshots(projectId)).find(s => s.id === first)?.sourceFiles).toContain('src/App.tsx');
    useStore.setState({ snapshots: [], vfs: {}, liveId: null, liveHtml: null });
    await useStore.getState().restoreFromDb();
    expect(useStore.getState().projectId).toBe(projectId);
    expect(useStore.getState().vfs[first]).toHaveLength(13);
    useStore.getState().restoreSnapshot(first);
    expect(useStore.getState().vfs[first].find(file => file.name === 'src/App.tsx')?.content).toContain('Pracovná tabuľa');
  });
});

describe('sandbox request identity', () => {
  function seed() { useStore.getState().stageTemplate(blueprint()); useStore.getState().approveStagedRun(); }
  it('aborts on stop and ignores a late response after changing project', async () => {
    seed();
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const pending = useStore.getState().runSandbox();
    const signal = fetch.mock.calls[0][1]?.signal;
    useStore.getState().newProject();
    expect(signal?.aborted).toBe(true);
    finish(Response.json({ ok: true, html: '<p>old result</p>', errors: [] })); await pending;
    expect(useStore.getState().sandboxHtml).toBeNull(); expect(useStore.getState().sandboxBuilding).toBe(false);
  });

  it('ignores a response when a different version is restored', async () => {
    seed(); const first = useStore.getState().liveId!;
    useStore.getState().stageTemplate(BLUEPRINT_REGISTRY[0]); useStore.getState().approveStagedRun();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const pending = useStore.getState().runSandbox();
    useStore.getState().restoreSnapshot(first);
    finish(Response.json({ ok: true, html: '<p>wrong version</p>', errors: [] })); await pending;
    expect(useStore.getState().sandboxHtml).toBeNull();
    expect(useStore.getState().liveId).toBe(first);
  });
});
