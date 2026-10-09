import { create } from 'zustand';
import { uid, now, dbg } from '../lib/utils';
import { buildSaas, buildKanban, buildSettings, buildDashboard, detectKind, KIND_INFO, SNIPPETS, AppKind } from '../lib/templates';
import { filesFor, filesToHtml, VfsFile } from '../lib/vfs/filesFor';
import type { AgentEvent, GeneratedFile, Plan } from '../services/ai/types';
import { streamAgentEvents, AiNotConfiguredError, NetworkError } from '../services/ai/client';
import { restoreWorkspace, scheduleAutosave, persistProjectState, persistRun, nextRevision } from '../services/persistence/projectStore';
import type { StoredSnapshot } from '../services/persistence/db';

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

  /* M2: reálny AI engine */
  aiMode: boolean;
  aiConnected: boolean | null;
  projectId: string;
  aiAbort: AbortController | null;
  generateWithAi: (prompt: string, mode: 'create' | 'iterate' | 'fix') => Promise<void>;
  cancelAiRun: () => void;
  applyStagedFiles: (files: GeneratedFile[]) => void;
  restoreFromDb: () => Promise<void>;
  persistNow: () => Promise<void>;
}

const generationTimers: number[] = [];

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
      const snippet = (SNIPPETS as Record<string, string>)[kind.kind] || '';
      get().updateMsg(m.id, { plan: steps.map(st => ({ ...st, state: 'done' })), code: snippet, file: kind.file });
      set({ generating: false, liveHtml: html, viewing: null, liveId: snap.id, tab: 'preview' });
      get().log('✓ ' + kind.file + ' vygenerovaný (sandbox allow-scripts)', 'ok');
      /* streaming text asistenta — rovnaký ako legacy (55 ms interval, +3 slová) */
      const full = `Hotovo! Postavil som **${kind.name}** — beží v sandboxe \`allow-scripts\`, verzia v${snap.v} je v histórii.` +
        `\n\nMôžeš iterovať: „pridaj tmavú tému“, „zmeň CTA farbu“ alebo zapni Edit mode a klikni na element v preview.`;
      const words = full.split(' ');
      let i = 0;
      const iv = window.setInterval(() => {
        i += 3;
        get().updateMsg(m.id, { text: words.slice(0, i).join(' ') });
        if (i >= words.length){
          window.clearInterval(iv);
          get().updateMsg(m.id, { done: true });
          get().toast('Verzia v' + snap.v + ' hotová', 'ok');
          /* M2: perzistencia aj pre template mód (refresh restore) */
          void get().persistNow();
        }
      }, 55);
      generationTimers.push(iv);
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
    const fl = files.find(f => f.name === s.edFile) || files[0];
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

  /* ---------- M2: AI engine ---------- */
  aiMode: true,
  aiConnected: null,
  projectId: 'pilot-' + Math.random().toString(36).slice(2, 8),
  aiAbort: null,

  generateWithAi: async (prompt, mode) => {
    const st = get();
    if (st.generating) return;
    const text = prompt.trim();
    if (!text) return;
    get().addMsg('user', text);
    set({ generating: true, mode: 'work' });
    document.body.dataset.mode = 'work';

    const planMsg = get().addMsg('assistant', '', {});
    const abort = new AbortController();
    set({ aiAbort: abort });

    const events: AgentEvent[] = [];
    try {
      const ctxFiles = Object.values(st.vfs).flat().map(f => ({ path: f.name, content: f.content })).slice(0, 40);
      for await (const ev of streamAgentEvents({
        projectId: get().projectId,
        prompt: text,
        mode,
        context: {
          projectTitle: st.projectTitle !== 'Nový projekt' ? st.projectTitle : undefined,
          files: ctxFiles,
          history: st.snapshots.slice(-20).map(s => ({ v: s.v, prompt: s.prompt.slice(0, 300) })),
        },
      }, abort.signal)) {
        events.push(ev);
        if (ev.type === 'run_started') set({ aiConnected: true });
        if (ev.type === 'plan') {
          get().updateMsg(planMsg.id, { plan: ev.plan.steps.map(x => ({ label: x.title, state: 'pending' as const })), planTitle: 'AI plán', model: ev.plan.summary });
          get().log('› AI plán: ' + ev.plan.summary, 'info');
        }
        if (ev.type === 'plan_step') {
          const cur = get().messages.find(m => m.id === planMsg.id);
          if (cur?.plan) {
            get().updateMsg(planMsg.id, {
              plan: cur.plan.map((p, i) => (i === cur.plan!.findIndex(x => x.state === 'pending') ? { ...p, state: 'running' } : p)),
            });
          }
        }
        if (ev.type === 'file_started') get().log('› generujem ' + ev.path, 'info');
        if (ev.type === 'file_done') get().log('✓ ' + ev.path + ' (' + ev.bytes + ' B)', 'ok');
        if (ev.type === 'validation' && !ev.result.ok) {
          get().log('⚠ validácia: ' + ev.result.errors.map(e => e.path + ': ' + e.message).join('; ').slice(0, 200), 'warn');
        }
        if (ev.type === 'error') get().log('✗ AI: ' + ev.message, 'err');
      }

      const doneEv = events.find(e => e.type === 'done');
      const stage = events.find(e => e.type === 'stage');
      if (stage && stage.type === 'stage') {
        get().applyStagedFiles(stage.files);
        get().updateMsg(planMsg.id, { text: doneEv && doneEv.type === 'done' ? doneEv.summary : 'Súbory pripravené na review.', done: true });
      }
      set({ aiConnected: true });
      void get().persistNow();
    } catch (e) {
      if (e instanceof AiNotConfiguredError) {
        set({ aiConnected: false });
        get().toast('AI nie je nakonfigurované — použi Instant Draft mód', 'warn');
      } else if (e instanceof NetworkError) {
        set({ aiConnected: false });
        get().toast('AI server nedostupný — spusti server (npm run server)', 'warn');
      } else if (abort.signal.aborted) {
        get().log('⟲ AI generovanie zrušené', 'warn');
      } else {
        get().toast('AI generovanie zlyhalo: ' + String(e).slice(0, 120), 'err');
      }
      get().updateMsg(planMsg.id, { done: true });
    } finally {
      set({ generating: false, aiAbort: null });
    }
  },

  cancelAiRun: () => {
    const st = get();
    st.aiAbort?.abort(new Error('cancel'));
    set({ generating: false, aiAbort: null });
    get().toast('AI generovanie zrušené', 'warn');
  },

  applyStagedFiles: (files) => {
    /* REVIEW/APPLY: súbory z AI ide do VFS projektu (snapshot pred zmenou = immutabilita) */
    const st = get();
    const snap = st.edSnap();
    if (!snap) { get().toast('Najprv vytvor projekt (AI ho vytvorí automaticky pri create móde)', 'warn'); return; }
    const current = st.vfs[snap.id] ?? filesFor(snap);
    const next = [...current];
    for (const f of files) {
      const idx = next.findIndex(x => x.name === f.path);
      if (f.action === 'delete') { if (idx !== -1) next.splice(idx, 1); }
      else if (idx !== -1) next[idx] = { ...next[idx], content: f.content, modified: true };
      else next.push({ name: f.path, content: f.content, modified: true });
    }
    const html = filesToHtml(next);
    set(s2 => ({
      vfs: { ...s2.vfs, [snap.id]: next },
      liveHtml: s2.liveId === snap.id ? html : s2.liveHtml,
      snapshots: s2.snapshots.map(x => (x.id === snap.id ? { ...x, html } : x)),
    }));
    get().toast('Použitých ' + files.length + ' súborov z AI', 'ok');
  },

  restoreFromDb: async () => {
    try {
      const restored = await restoreWorkspace();
      if (!restored.project) return;
      const snaps: Snapshot[] = restored.snapshots.map(s => ({ ...s }));
      const live = snaps.find(s => s.id === restored.project?.liveSnapshotId) ?? snaps[snaps.length - 1];
      set({
        snapshots: snaps,
        liveId: live?.id ?? null,
        liveHtml: live?.html ?? null,
        viewing: null,
        projectTitle: restored.project.title,
        publishedUrl: restored.project.publishedUrl,
        isPublic: restored.project.isPublic,
        vfs: {},
        projectId: restored.project.id,
      });
      dbg('restore: projekt obnovený z IndexedDB', 'snapshotov=' + snaps.length);
    } catch (e) {
      dbg('restore: zlyhal (prvý spustenie?)', String(e));
    }
  },

  persistNow: async () => {
    const st = get();
    if (st.snapshots.length === 0) return;
    const now = Date.now();
    const err = await persistProjectState({
      project: {
        id: st.projectId,
        title: st.projectTitle,
        createdAt: now,
        updatedAt: now,
        liveSnapshotId: st.liveId,
        publishedUrl: st.publishedUrl,
        isPublic: st.isPublic,
      },
      snapshots: st.snapshots.map(s => ({ ...s, projectId: st.projectId, pinned: !!s.pinned })),
      files: Object.values(st.vfs).flat().map(f => ({ projectId: st.projectId, path: f.name, content: f.content, updatedAt: now, revision: nextRevision() })),
    });
    if (err) get().toast('Uloženie zlyhalo: ' + err.message.slice(0, 80), 'warn');
  },

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
