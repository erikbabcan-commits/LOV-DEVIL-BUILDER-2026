import { create } from 'zustand';
import { uid, now, dbg } from '../lib/utils';
import { buildSaas, buildKanban, buildSettings, buildDashboard, detectKind, KIND_INFO, AppKind } from '../lib/templates';
import { filesFor, filesToHtml, VfsFile } from '../lib/vfs/filesFor';

export interface PlanStep { label: string; state: 'pending' | 'running' | 'done' }
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  done?: boolean;
  code?: string;
  file?: string;
  plan?: PlanStep[];
  planTitle?: string;
  model?: string;
}
export interface Snapshot {
  id: string;
  v: number;
  prompt: string;
  kind: string;
  time: string;
  html: string;
  pinned?: boolean;
  msg?: string;
}
export interface ConsoleEntry { t: string; txt: string; cls: string }
export interface Branch { name: string; headIdx: number }

export interface AppState {
  /* workspace */
  model: string;
  mode: 'home' | 'work' | 'editor';
  viewport: 'desktop' | 'tablet' | 'mobile';
  zoomPct: number;
  tab: 'preview' | 'code' | 'console' | 'diff';
  editMode: boolean;
  isPublic: boolean;
  publishedUrl: string | null;
  messages: Message[];
  snapshots: Snapshot[];
  liveHtml: string | null;
  viewing: Snapshot | null;
  liveId: string | null;
  generating: boolean;
  console: ConsoleEntry[];
  mview: 'chat' | 'canvas';
  projectTitle: string;
  titleEditing: boolean;

  /* editor */
  vfs: Record<string, VfsFile[]>;
  branches: Branch[];
  branch: string;
  edFile: string | null;
  edEditing: boolean;
  edTab: 'preview' | 'files' | 'history' | 'backend' | 'team' | 'compliance' | 'gallery';

  /* UI */
  modelMenuOpen: boolean;
  settingsOpen: boolean;
  publishModalOpen: boolean;
  historyExpanded: boolean;
  toasts: { id: string; msg: string; kind: string }[];

  /* actions */
  setMode: (m: AppState['mode']) => void;
  setTab: (t: AppState['tab']) => void;
  setViewport: (v: AppState['viewport']) => void;
  setZoom: (z: number) => void;
  setMview: (v: AppState['mview']) => void;
  setModel: (m: string) => void;
  togglePublic: () => void;
  toggleEditMode: () => void;
  addMsg: (role: Message['role'], text: string, extra?: Partial<Message>) => Message;
  updateMsg: (id: string, patch: Partial<Message>) => void;
  log: (txt: string, cls?: string) => void;
  toast: (msg: string, kind?: string) => void;
  dismissToast: (id: string) => void;
  generate: (prompt: string, kindOverride?: AppKind) => void;
  createSnapshot: (kind: string, prompt: string, html: string) => Snapshot;
  manualSnapshot: () => void;
  viewSnapshot: (id: string) => void;
  backToLive: () => void;
  pinSnapshot: (id: string) => void;
  restoreSnapshot: (id: string) => void;
  goHome: () => void;
  goEditor: () => void;
  setEdTab: (t: AppState['edTab']) => void;
  setEdFile: (f: string | null) => void;
  startEdEditing: () => void;
  saveEdFile: (content: string) => void;
  setTitle: (t: string) => void;
  setTitleEditing: (v: boolean) => void;
  publish: () => void;
  toggleHistoryExpanded: () => void;
  newProject: () => void;
  setModelMenuOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setPublishModalOpen: (v: boolean) => void;
  currentHtml: () => string | null;
  edSnap: () => Snapshot | null;
}

let generationTimers: number[] = [];

export const useStore = create<AppState>((set, get) => ({
  model: 'Lovable Cloud',
  mode: 'home',
  viewport: 'desktop',
  zoomPct: 100,
  tab: 'preview',
  editMode: false,
  isPublic: false,
  publishedUrl: null,
  messages: [],
  snapshots: [],
  liveHtml: null,
  viewing: null,
  liveId: null,
  generating: false,
  console: [],
  mview: 'chat',
  projectTitle: 'Nový projekt',
  titleEditing: false,
  vfs: {},
  branches: [{ name: 'main', headIdx: Infinity }],
  branch: 'main',
  edFile: null,
  edEditing: false,
  edTab: 'preview',
  modelMenuOpen: false,
  settingsOpen: false,
  publishModalOpen: false,
  historyExpanded: false,
  toasts: [],

  setMode: m => {
    document.body.dataset.mode = m;
    set({ mode: m });
  },
  setTab: t => set({ tab: t }),
  setViewport: v => set({ viewport: v }),
  setZoom: z => set({ zoomPct: Math.max(50, Math.min(150, z)) }),
  setMview: v => {
    document.body.dataset.view = v;
    set({ mview: v });
  },
  setModel: m => { set({ model: m, modelMenuOpen: false }); get().log('model: ' + m); },
  togglePublic: () => set(s => ({ isPublic: !s.isPublic })),
  toggleEditMode: () => set(s => ({ editMode: !s.editMode })),

  addMsg: (role, text, extra) => {
    const m: Message = { id: uid(), role, text, ...extra };
    set(s => ({ messages: [...s.messages, m] }));
    return m;
  },
  updateMsg: (id, patch) => set(s => ({
    messages: s.messages.map(m => (m.id === id ? { ...m, ...patch } : m)),
  })),
  log: (txt, cls = 'info') => set(s => ({ console: [...s.console, { t: now(), txt, cls }] })),
  toast: (msg, kind = 'ok') => {
    const id = uid();
    set(s => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => get().dismissToast(id), 2600);
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  generate: (prompt, kindOverride) => {
    const s = get();
    if (s.generating) { dbg('generate: ignorujem — už prebieha'); return; }
    const text = prompt.trim();
    if (!text) { dbg('generate: prázdny prompt'); return; }
    const kind = kindOverride && KIND_INFO[kindOverride]
      ? { kind: kindOverride, ...KIND_INFO[kindOverride] }
      : detectKind(text);
    dbg('generate →', 'prompt=' + text.slice(0, 60), 'kind=' + kind.kind);

    get().addMsg('user', text);
    set({ generating: true, mode: 'work' });
    document.body.dataset.mode = 'work';
    get().log(`› prompt prijatý (${Math.ceil(text.length / 4)} tok) · agent: ${s.model}`);

    const steps: PlanStep[] = [
      { label: 'Analyzujem prompt…', state: 'running' },
      { label: 'Plánujem štruktúru aplikácie', state: 'pending' },
      { label: `Navrhujem UI a generujem ${kind.file}`, state: 'pending' },
      { label: 'Ukladám verziu do histórie', state: 'pending' },
    ];
    const m = get().addMsg('assistant', '', { plan: steps, planTitle: kind.name, model: s.model });

    [450, 950, 1550].forEach((delay, i) => {
      const t = window.setTimeout(() => {
        get().updateMsg(m.id, {
          plan: steps.map((st, j) => (j === i ? { ...st, state: 'done' } : j === i + 1 ? { ...st, state: 'running' } : st)),
        });
        get().log('✓ krok: ' + steps[i].label, 'ok');
      }, delay);
      generationTimers.push(t);
    });

    const t = window.setTimeout(() => {
      const html = (kind.kind === 'saas' ? buildSaas : kind.kind === 'kanban' ? buildKanban : kind.kind === 'settings' ? buildSettings : buildDashboard)(text);
      const snap = get().createSnapshot(kind.kind, text, html);
      get().updateMsg(m.id, { plan: steps.map(st => ({ ...st, state: 'done' })), done: true, code: kind.file, file: kind.file });
      set({ generating: false, liveHtml: html, viewing: null, liveId: snap.id, tab: 'preview' });
      get().log('✓ hotovo: ' + kind.file + ' · verzia v' + snap.v, 'ok');
    }, 2200);
    generationTimers.push(t);
  },

  createSnapshot: (kind, prompt, html) => {
    const s = get();
    const snap: Snapshot = { id: uid(), v: s.snapshots.length + 1, prompt, kind, time: now(), html };
    set({ snapshots: [...s.snapshots, snap] });
    return snap;
  },
  manualSnapshot: () => {
    const s = get();
    if (!s.liveHtml) { get().toast('Najprv vygeneruj appku', 'warn'); return; }
    const snap = get().createSnapshot('manual', 'Ručný checkpoint', s.liveHtml);
    set({ liveId: snap.id });
    get().toast('Verzia uložená (Ctrl+S)', 'ok');
  },
  viewSnapshot: id => {
    const s = get();
    const snap = s.snapshots.find(x => x.id === id);
    if (!snap) return;
    set({ viewing: snap, tab: 'preview' });
  },
  backToLive: () => set({ viewing: null }),
  pinSnapshot: id => set(s => ({
    snapshots: s.snapshots.map(x => (x.id === id ? { ...x, pinned: !x.pinned } : x)),
  })),
  restoreSnapshot: id => {
    const s = get();
    const snap = s.snapshots.find(x => x.id === id);
    if (!snap) return;
    set({ liveHtml: snap.html, viewing: null, liveId: snap.id });
    get().log('✓ obnovené: v' + snap.v, 'ok');
  },
  goHome: () => {
    set({ mode: 'home' });
    document.body.dataset.mode = 'home';
  },
  goEditor: () => {
    set({ mode: 'editor' });
    document.body.dataset.mode = 'editor';
    dbg('editor: dashboard otvorený · projektov=' + get().snapshots.length);
  },
  setEdTab: t => set({ edTab: t, edEditing: false }),
  setEdFile: f => set({ edFile: f }),
  startEdEditing: () => set({ edEditing: true }),

  saveEdFile: content => {
    const s = get();
    if (s.viewing) {
      set({ edEditing: false });
      get().toast('Read-only — prezeráš historickú verziu. Obnov ju (Obnoviť) pre editáciu.', 'warn');
      return;
    }
    const snap = s.edSnap();
    if (!snap) return;
    const files = s.vfs[snap.id] || filesFor(snap);
    let fl = files.find(f => f.name === s.edFile) || files[0];
    if (fl && s.edFile !== fl.name) set({ edFile: fl.name });
    if (!fl) return;
    fl.content = content;
    fl.modified = true;
    const html = filesToHtml(files);
    set(st => ({
      vfs: { ...st.vfs, [snap.id]: files },
      snapshots: st.snapshots.map(x => (x.id === snap.id ? { ...x, html } : x)),
      liveHtml: st.liveId === snap.id ? html : st.liveHtml,
      edEditing: false,
    }));
    get().toast('💾 ' + fl.name + ' uložený', 'ok');
  },

  setTitle: t => set({ projectTitle: t }),
  setTitleEditing: v => set({ titleEditing: v }),

  publish: () => {
    const url = 'forge.app/p/' + uid() + '-' + uid().slice(0, 4);
    set({ publishedUrl: url, publishModalOpen: true });
    setTimeout(() => {
      set(st => ({ publishModalOpen: st.publishModalOpen }));
      get().log('✓ deployed: https://' + url, 'ok');
      get().toast('Aplikácia je live: ' + url, 'ok');
    }, 2800);
  },
  toggleHistoryExpanded: () => set(s => ({ historyExpanded: !s.historyExpanded })),
  newProject: () => set({
    messages: [], snapshots: [], liveHtml: null, viewing: null, liveId: null,
    publishedUrl: null, vfs: {}, edFile: null, edEditing: false,
    projectTitle: 'Nový projekt', branches: [{ name: 'main', headIdx: Infinity }], branch: 'main',
  }),
  setModelMenuOpen: v => set({ modelMenuOpen: v }),
  setSettingsOpen: v => set({ settingsOpen: v }),
  setPublishModalOpen: v => set({ publishModalOpen: v }),

  currentHtml: () => {
    const s = get();
    return s.viewing ? s.viewing.html : s.liveHtml;
  },
  edSnap: () => {
    const s = get();
    if (s.viewing) return s.viewing;
    return s.snapshots.find(x => x.id === s.liveId) || s.snapshots[s.snapshots.length - 1] || null;
  },
}));
