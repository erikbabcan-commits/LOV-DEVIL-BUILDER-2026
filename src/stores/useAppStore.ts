import {applyFileOperations} from '../lib/projectChanges';
import {requestBuildRepair} from '../services/ai/buildRepair';
import {ConversationSchema,type ConversationTurn} from '../../shared/conversation';
import { apiHeaders } from '../lib/csrf';
import { create } from 'zustand';
import { uid, now, dbg } from '../lib/utils';
import { buildSaas, buildKanban, buildSettings, buildDashboard, detectKind, KIND_INFO, SNIPPETS, AppKind } from '../lib/templates';
import { filesFor, filesToHtml, VfsFile } from '../lib/vfs/filesFor';
import type { AgentEvent, GeneratedFile, Plan } from '../services/ai/types';
import { streamAgentEvents, AiNotConfiguredError, AiRequestError, NetworkError } from '../services/ai/client';
import { restoreWorkspace, scheduleAutosave, persistProjectState, persistRun, nextRevision } from '../services/persistence/projectStore';
import type { StoredSnapshot } from '../services/persistence/db';
import { persistenceScope } from '../services/persistence/db';
import { prepareVfsForExport } from '../services/export/zipExport';
import { createProjectZip, downloadProjectZip } from '../services/export/projectZip';
import { inspectProjectSources } from '../services/export/projectZip';
import { WorkspaceSchema } from '../../shared/projectSchema';
import { matchesCodeEditBase, type CodeEditBase } from '../services/editor/codeDrafts';
import { exportToGitHub as doGitHubExport, checkGitHubAuth as doCheckGitHubAuth, checkGitHubAvailable, initiateGitHubAuth, type GitHubExportRequest, type GitHubAuthState } from '../services/export/githubExport';
import type { Blueprint } from '../templates/types';

export interface PlanStep { label: string; state: 'pending' | 'running' | 'done' }
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  reviewPending?: boolean;
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
  /** Scalar payload keeps historical React file sets restorable in IndexedDB v2. */
  sourceFiles?: string;
  parentId?: string | null;
}
export interface ConsoleEntry { t: string; txt: string; cls: string }
export interface Branch { name: string; headIdx: number }
export interface ReviewBase {
  projectId: string;
  snapshotId: string | null;
  liveId: string | null;
  viewingId: string | null;
  branch: string;
  fingerprint: string;
}
export interface PendingReview { messageId?:string; runId: string; prompt: string; files: GeneratedFile[]; base: ReviewBase; source?: 'template'|'patch'; summary?:string; title?: string; followups?: string[] }

export interface AppState {
  /* workspace */
  model: string;
  aiModelId: string | undefined;
  aiFallbackIds: string[];
  chooseAiModel: (id: string, label: string) => void;
  setAiFallback: (ids: string[]) => void;
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
  remoteRevision: number;
  remoteSnapshotIds: Record<string,string>;
  titleEditing: boolean;
  promptDraft: string;
  templateFollowups: string[];

  /* editor */
  vfs: Record<string, VfsFile[]>;
  branches: Branch[];
  branch: string;
  edFile: string | null;
  edEditing: boolean;
  edTab: 'preview' | 'files' | 'history' | 'blueprints' | 'prompts' | 'backend' | 'team' | 'compliance' | 'gallery';

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
  setPromptDraft: (text: string) => void;
  usePrompt: (text: string) => void;
  stageTemplate: (template: Blueprint) => void;
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
  workspaceEpoch: number;
  codeDraftDirty: boolean;
  aiAbort: AbortController | null;
  pendingReview: PendingReview | null;
  generateWithAi: (prompt: string, mode: 'create' | 'iterate' | 'fix' | 'explain' | 'auto') => Promise<void>;
  cancelAiRun: () => void;
  approveStagedRun: () => boolean;
  rejectStagedRun: () => void;
  applyStagedFiles: (files: GeneratedFile[], base?: CodeEditBase) => Promise<boolean>;
  restoreFromDb: () => Promise<void>;
  persistNow: () => Promise<boolean>;

  /* M3 sandbox */
  sandboxHtml: string | null;
  sandboxBuilding: boolean;
  sandboxErrors: Array<{ file: string; message: string }>;
  runSandbox: () => Promise<void>;
  repairSandbox: () => Promise<void>;
  stopSandbox: () => void;

  /* M4 export */
  githubAuthState: { authenticated: boolean; username?: string; avatarUrl?: string };
  githubExportInProgress: boolean;
  exportToZip: () => Promise<void>;
  exportToGitHub: () => Promise<void>;
  checkGitHubAuth: () => Promise<void>;
}

const generationTimers: number[] = [];
let sandboxController: AbortController | null = null;
let githubExportRun = 0;

function reviewSnapshot(state: AppState): Snapshot | null {
  return state.viewing ?? state.snapshots.find(item => item.id === state.liveId) ?? state.snapshots[state.snapshots.length - 1] ?? null;
}

function requestContext(state: AppState) {
  const snapshot = reviewSnapshot(state);
  const files = snapshot ? state.vfs[snapshot.id] ?? filesFor(snapshot) : [];
  return {
    projectTitle: state.projectTitle !== 'Nový projekt' ? state.projectTitle : undefined,
    files: files.map(file => ({ path: file.name, content: file.content })),
    history: state.snapshots.slice(-20).map(snapshot => ({ v: snapshot.v, prompt: snapshot.prompt.slice(0, 300) })),
  };
}

export function conversationContext(messages:Message[]):ConversationTurn[]{
  return messages.filter(message=>message.text.trim()&&!message.pending).map(({role,text,reviewPending})=>({role,content:reviewPending?'Návrh bol pripravený na kontrolu; jeho aplikovanie sa tým nepotvrdilo.':text}));
}

/* Local compare-and-apply binding, not an authorization token or cryptographic hash.
   Store the exact serialized content, so no async hashing window or hash collision
   can allow a stale run to apply to a different/edited project. */
export function captureReviewBase(state: AppState): ReviewBase {
  const snapshot = reviewSnapshot(state);
  return {
    projectId: state.projectId,
    snapshotId: snapshot?.id ?? null,
    liveId: state.liveId,
    viewingId: state.viewing?.id ?? null,
    branch: state.branch,
    fingerprint: JSON.stringify({
      context: requestContext(state),
      projectTitle: state.projectTitle,
      liveHtml: state.liveHtml,
      snapshot: snapshot ? { id: snapshot.id, v: snapshot.v, html: snapshot.html, prompt: snapshot.prompt } : null,
      files: snapshot ? state.vfs[snapshot.id]?.map(file => ({ name: file.name, content: file.content })) ?? null : null,
      edEditing: state.edEditing,
      codeDraftDirty: state.codeDraftDirty,
    }),
  };
}

function matchesReviewIdentity(state: AppState, base: ReviewBase): boolean {
  return state.projectId === base.projectId && state.liveId === base.liveId &&
    (state.viewing?.id ?? null) === base.viewingId && state.branch === base.branch;
}

export function matchesReviewBase(state: AppState, base: ReviewBase): boolean {
  if (!matchesReviewIdentity(state, base)) return false;
  const current = captureReviewBase(state);
  return current.snapshotId === base.snapshotId && current.fingerprint === base.fingerprint;
}

export const useStore = create<AppState>((set, get) => ({
  workspaceEpoch: persistenceScope().epoch,
  codeDraftDirty: false,
  model: 'Instant Draft',
  aiModelId: undefined,
  aiFallbackIds: [],
  chooseAiModel: (id,label) => set({model:label,aiModelId:id,aiFallbackIds:[],modelMenuOpen:false}),
  setAiFallback: ids => set({aiFallbackIds:[...ids]}),
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
  promptDraft: '',
  templateFollowups: [],
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

  /* M4 export state */
  githubAuthState: { authenticated: false },
  remoteRevision: 0,
  remoteSnapshotIds: {},
  githubExportInProgress: false,

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
  setModel: m => { set({ model: m, modelMenuOpen: false, aiModelId: undefined, aiFallbackIds: [] }); get().log('model: ' + m); },
  setPromptDraft: promptDraft => set({ promptDraft }),
  usePrompt: promptDraft => {
    set({ promptDraft });
    get().setMode(get().snapshots.length ? 'work' : 'home');
    get().setMview('chat');
  },
  stageTemplate: template => {
    const state = get();
    if (state.generating || state.pendingReview || state.codeDraftDirty) { state.toast('Najprv ulož koncept kódu alebo dokonči pripravené zmeny.', 'warn'); return; }
    const snap = reviewSnapshot(state);
    const existing = snap ? state.vfs[snap.id] ?? filesFor(snap) : [];
    const names = new Set(template.files.map(file => file.path));
    const files: GeneratedFile[] = [
      ...template.files.map(file => ({ ...file, action: existing.some(item => item.name === file.path) ? 'modify' as const : 'create' as const })),
      ...existing.filter(file => !names.has(file.name)).map(file => ({ path: file.name, content: '', action: 'delete' as const })),
    ];
    set({ pendingReview: { runId: 'template-' + uid(), source: 'template', title: template.title,
      prompt: 'Šablóna: ' + template.title, files, followups: [...template.followups], base: captureReviewBase(state) } });
    get().setMode('work'); get().setMview('chat');
  },
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
    if (s.pendingReview) { get().toast('Najprv schváľ alebo odmietni AI zmeny', 'warn'); return; }
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
    const snap: Snapshot = { id: uid(), parentId: s.liveId, v: Math.max(0, ...s.snapshots.map(item => item.v)) + 1, prompt, kind, time: now(), html };
    set({ snapshots: [...s.snapshots, snap] });
    return snap;
  },
  manualSnapshot: () => {
    const s = get();
    if (s.codeDraftDirty) { s.toast('Najprv ulož alebo zruš koncept v záložke Code.', 'warn'); return; }
    if (!s.liveHtml) { get().toast('Najprv vygeneruj appku', 'warn'); return; }
    const snap = get().createSnapshot('manual', 'Ručný checkpoint', s.liveHtml);
    const previous = s.snapshots.find(item => item.id === s.liveId);
    const files = previous ? (s.vfs[previous.id] ?? filesFor(previous)).map(file => ({ ...file })) : [];
    const captured = { ...snap, sourceFiles: JSON.stringify(files) };
    set(state => ({ snapshots: state.snapshots.map(item => item.id === snap.id ? captured : item),
      liveId: snap.id, vfs: { ...state.vfs, [snap.id]: files }, viewing: null }));
    void get().persistNow();
    get().toast('Verzia uložená (Ctrl+S)', 'ok');
  },
  viewSnapshot: id => {
    const s = get();
    const snap = s.snapshots.find(x => x.id === id);
    if (!snap) return;
    sandboxController?.abort();
    set({ viewing: snap, tab: 'preview', sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false });
  },
  backToLive: () => { sandboxController?.abort(); set({ viewing: null, sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false }); },
  pinSnapshot: id => set(s => ({
    snapshots: s.snapshots.map(x => (x.id === id ? { ...x, pinned: !x.pinned } : x)),
  })),
  restoreSnapshot: id => {
    const s = get();
    if (s.codeDraftDirty) { s.toast('Najprv ulož alebo zruš koncept v záložke Code.', 'warn'); return; }
    const snap = s.snapshots.find(x => x.id === id);
    if (!snap) return;
    sandboxController?.abort();
    set({ liveHtml: snap.html, viewing: null, liveId: snap.id, sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false });
    void get().persistNow();
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
    if (s.codeDraftDirty) { s.toast('Najprv ulož alebo zruš koncept v záložke Code.', 'warn'); return; }
    if (s.viewing) {
      set({ edEditing: false });
      get().toast('Read-only — prezeráš historickú verziu. Obnov ju (Obnoviť) pre editáciu.', 'warn');
      return;
    }
    const snap = s.edSnap();
    if (!snap) return;
    const files = (s.vfs[snap.id] || filesFor(snap)).map(file => ({ ...file }));
    const fl = files.find(f => f.name === s.edFile) || files[0];
    if (!fl) return;
    if (s.edFile !== fl.name) set({ edFile: fl.name });
    if (fl.content === content) { set({ edEditing: false }); return; }
    fl.content = content;
    fl.modified = true;
    const html = filesToHtml(files);
    const next: Snapshot = {
      id: uid(), parentId: snap.id, v: Math.max(0, ...s.snapshots.map(x => x.v)) + 1,
      prompt: 'Ručná úprava: ' + fl.name, kind: 'manual', time: now(), html, sourceFiles: JSON.stringify(files),
    };
    set({
      vfs: { ...s.vfs, [next.id]: files },
      snapshots: [...s.snapshots, next],
      liveId: next.id, liveHtml: html, viewing: null, edEditing: false,
      sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false,
    });
    void get().persistNow();
    get().toast('💾 ' + fl.name + ' uložený ako v' + next.v, 'ok');
  },

  setTitle: t => set({ projectTitle: t }),
  setTitleEditing: v => set({ titleEditing: v }),

  publish: () => {
    get().log('Publikovanie je demo — reálny deployment nie je nakonfigurovaný', 'warn');
    get().toast('Publikovanie zatiaľ nie je pripojené k hostingu', 'warn');
  },
  toggleHistoryExpanded: () => set(s => ({ historyExpanded: !s.historyExpanded })),
  newProject: () => {
    sandboxController?.abort();
    get().aiAbort?.abort(new Error('project changed'));
    for (const timer of generationTimers.splice(0)) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    set({
      workspaceEpoch: persistenceScope().epoch,
      codeDraftDirty: false,
      messages: [], snapshots: [], liveHtml: null, viewing: null, liveId: null,
      publishedUrl: null, vfs: {}, edFile: null, edEditing: false,
      projectTitle: 'Nový projekt', projectId: 'pilot-' + uid(),
      remoteRevision: 0,
      remoteSnapshotIds: {},
      branches: [{ name: 'main', headIdx: Infinity }], branch: 'main', pendingReview: null,
      generating: false, aiAbort: null,
      sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false, promptDraft: '', templateFollowups: [],
    });
  },
  setModelMenuOpen: v => set({ modelMenuOpen: v }),
  setSettingsOpen: v => set({ settingsOpen: v }),
  setPublishModalOpen: v => set({ publishModalOpen: v }),

  /* ---------- M2: AI engine ---------- */
  aiMode: true,
  aiConnected: null,
  projectId: 'pilot-' + Math.random().toString(36).slice(2, 8),
  aiAbort: null,
  pendingReview: null,

  generateWithAi: async (prompt, mode) => {
    const st = get();
    if (st.generating) return;
    const text = prompt.trim();
    if (!text) return;
    if (st.pendingReview) { get().toast('Najprv schváľ alebo odmietni pripravené zmeny', 'warn'); return; }
    if (st.edEditing || st.codeDraftDirty) { get().toast('Najprv ulož alebo zruš manuálnu úpravu súboru.', 'warn'); return; }
    const base = captureReviewBase(st);
    const context = {...requestContext(st),conversation:conversationContext(st.messages)};
    get().addMsg('user', text);
    set({ generating: true, mode: 'work' });
    document.body.dataset.mode = 'work';

    const planMsg = get().addMsg('assistant', '', {});
    const abort = new AbortController();
    set({ aiAbort: abort });

    const events: AgentEvent[] = [];
    let resolvedIntent:'create'|'iterate'|'fix'|'explain'|undefined;
    let answerText='';
    const expireRun = () => {
      abort.abort(new Error('review base changed'));
      get().updateMsg(planMsg.id, { text: 'Projekt sa počas generovania zmenil. AI návrh bol zahodený; spusti nový run.',plan:undefined, done: true });
      get().toast('AI návrh je zastaraný — projekt sa zmenil. Spusti nový run.', 'warn');
    };
    try {
      for await (const ev of streamAgentEvents({
        modelId: st.aiModelId,
        allowFallback: st.aiFallbackIds.length > 0,
        fallbackIds: [...st.aiFallbackIds],
        projectId: base.projectId,
        prompt: text,
        mode,
        context,
      }, abort.signal)) {
        // A cancelled/previous run must not mutate a newly opened project or run.
        if (get().aiAbort !== abort || abort.signal.aborted) return;
        if (!matchesReviewIdentity(get(), base) || (ev.type === 'stage' && !matchesReviewBase(get(), base))) {
          expireRun();
          return;
        }
        events.push(ev);
        if (ev.type === 'run_started') set({ aiConnected: true });
        if(ev.type==='intent_selected'){
          resolvedIntent=ev.intent;
          get().log('› Zámer: '+({create:'nová aplikácia',iterate:'úprava',fix:'oprava',explain:'odpoveď bez zmien'}[ev.intent]),'info');
          if(ev.intent==='explain')get().updateMsg(planMsg.id,{text:'Pripravujem odpoveď bez zmien súborov…'});
        }
        if(ev.type==='text_delta'){
          answerText+=ev.delta;get().updateMsg(planMsg.id,{text:answerText});
        }
        if (ev.type === 'provider_update') {
          get().updateMsg(planMsg.id,{text:ev.message+' ('+ev.provider+' · '+ev.model+')'});
          get().log('› '+ev.message+' '+ev.provider+' / '+ev.model,'warn');
        }
        if(ev.type==='context_update'){
          const note=ev.state==='summarizing'?`Zhrniem ${ev.summarizedTurns} starších správ, aby zostal priestor pre aktuálny kód.`:`Kontext pripravený: zhrnutých ${ev.summarizedTurns} správ. Počet AI volaní navyše: ${ev.summaryCalls}.`;
          get().updateMsg(planMsg.id,{text:note});get().log('› '+note,'info');
        }
        if (ev.type === 'plan') {
          get().updateMsg(planMsg.id, { text:'', plan: ev.plan.steps.map(x => ({ label: x.title, state: 'pending' as const })), planTitle: 'AI plán', model: ev.plan.summary });
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
        if (ev.type === 'error') {
          get().log('✗ AI: ' + ev.message, 'err');
          get().updateMsg(planMsg.id, { text: answerText?answerText+'\n\nOdpoveď sa prerušila a zostala neúplná. Súbory sa nemenili.':'AI úlohu sa nepodarilo dokončiť. Projekt zostal zachovaný; podrobnosti sú v konzole.',plan:undefined, done: true });
          get().toast('AI úloha zlyhala. Lokálna práca zostala zachovaná.', 'warn');
        }
        if (ev.type === 'cancelled') {
          get().updateMsg(planMsg.id, { text: answerText?answerText+'\n\nOdpoveď bola zastavená a zostala neúplná. Súbory sa nemenili.':'AI úloha sa zastavila pred dokončením. Projekt zostal zachovaný.', done: true });
          get().toast('AI úloha bola zastavená.', 'warn');
        }
      }

      const doneEv = events.find(e => e.type === 'done');
      const stage = events.find(e => e.type === 'stage');
      const runStarted = events.find(e => e.type === 'run_started');
      const validation = events.find(e => e.type === 'validation');
      if (get().aiAbort !== abort || abort.signal.aborted) return;
      if(resolvedIntent==='explain'&&doneEv?.type==='done'&&runStarted?.type==='run_started'&&doneEv.runId===runStarted.runId&&!stage&&!events.some(event=>event.type==='error'||event.type==='cancelled')){
        if(!answerText.trim())throw new AiRequestError('stream_interrupted',true);
        get().updateMsg(planMsg.id,{done:true});get().toast('Odpoveď je pripravená. Súbory sa nemenili.','ok');
      }
      if (resolvedIntent!=='explain'&&doneEv?.type === 'done' && stage?.type === 'stage' && runStarted?.type === 'run_started' &&
          doneEv.runId === runStarted.runId && validation?.type === 'validation' && validation.result.ok &&
          !events.some(event => event.type === 'error' || event.type === 'cancelled')) {
        if (!matchesReviewBase(get(), base)) { expireRun(); return; }
        set({ pendingReview: { messageId:planMsg.id, runId: runStarted.runId, prompt: text, files: stage.files.map(file => ({ ...file })),base,...(stage.editMode==='patch'?{source:'patch' as const,summary:stage.summary}:{}) } });
        get().updateMsg(planMsg.id, { text: `Súbory čakajúce na schválenie: ${stage.files.length}. Žiadne zmeny sa zatiaľ neaplikovali.`, reviewPending:true,plan:get().messages.find(message=>message.id===planMsg.id)?.plan?.map(step=>({...step,state:'done'})), done: true });
        get().toast('AI zmeny pripravené na kontrolu', 'warn');
      }
      set({ aiConnected: true });
    } catch (e) {
      if (get().aiAbort !== abort) return;
      if (e instanceof AiNotConfiguredError) {
        set({ aiConnected: false });
        get().toast('AI teraz nie je dostupné — použi Instant Draft mód', 'warn');
      } else if (e instanceof AiRequestError) {
        get().toast(e.message, 'warn');
      } else if (e instanceof NetworkError) {
        set({ aiConnected: false });
        get().toast('AI server teraz nie je dostupný. Skús to znova o chvíľu.', 'warn');
      } else if (abort.signal.aborted) {
        get().log('⟲ AI generovanie zrušené', 'warn');
      } else {
        get().toast('AI generovanie zlyhalo. Lokálna práca zostala zachovaná.', 'err');
      }
      get().updateMsg(planMsg.id, { text: answerText?answerText+'\n\nOdpoveď sa prerušila a zostala neúplná. Súbory sa nemenili.':e instanceof AiRequestError || e instanceof AiNotConfiguredError || e instanceof NetworkError ? e.message : abort.signal.aborted ? 'AI generovanie bolo zrušené.' : 'AI úlohu sa nepodarilo dokončiť. Lokálna práca zostala zachovaná.', done: true });
    } finally {
      if (get().aiAbort === abort) {set({ generating: false, aiAbort: null });void get().persistNow();}
    }
  },

  cancelAiRun: () => {
    const st = get();
    if(st.aiAbort){const active=st.messages.at(-1);if(active?.role==='assistant')get().updateMsg(active.id,{text:(active.text?active.text+'\n\n':'')+'AI odpoveď bola zastavená. Súbory sa nemenili.',done:true});}
    st.aiAbort?.abort(new Error('cancel'));
    set({ generating: false, aiAbort: null });
    void get().persistNow();
    get().toast('AI generovanie zrušené', 'warn');
  },

  approveStagedRun: () => {
    const state = get();
    const review = state.pendingReview;
    if (!review) return false; // idempotentný opakovaný klik
    if (!review.base || !matchesReviewBase(state, review.base)) {
      set({ pendingReview: null });
      get().toast('AI návrh je zastaraný — projekt sa zmenil. Spusti nový run.', 'warn');
      return false;
    }
    const previous = review.base.snapshotId ? state.snapshots.find(snapshot => snapshot.id === review.base.snapshotId) : null;
    const before=previous?(state.vfs[previous.id]??filesFor(previous)):[];
    const nextFiles=applyFileOperations(before,review.files,review.source==='patch');
    if(!nextFiles){get().toast('Návrh obsahuje konfliktné súbory. Nič sa nepoužilo.','warn');return false;}
    const html = filesToHtml(nextFiles);
    const snap: Snapshot = { id: uid(), parentId: previous?.id ?? null, v: Math.max(0, ...state.snapshots.map(item => item.v)) + 1,
      prompt: review.prompt, kind: review.source === 'template' ? 'template' : 'ai', time: now(), html,
      sourceFiles: JSON.stringify(nextFiles) };
    // Consume the review and publish the new immutable snapshot in one state update.
    set({
      pendingReview: null, snapshots: [...state.snapshots, snap],
      liveId: snap.id, liveHtml: html, viewing: null,
      vfs: { ...state.vfs, [snap.id]: nextFiles },
      sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false,
      templateFollowups: review.followups ?? state.templateFollowups,
      projectTitle: state.projectTitle === 'Nový projekt' && review.title ? review.title : state.projectTitle,
    });
    if(review.messageId)get().updateMsg(review.messageId,{text:`Použité súbory: ${review.files.length}. Zmeny sú v aktuálnom projekte.`,reviewPending:false,done:true,plan:get().messages.find(message=>message.id===review.messageId)?.plan?.map(step=>({...step,state:'done'}))});
    get().toast('Zmeny použité — pôvodná verzia zostáva v histórii.', 'ok');
    get().log(`✓ ${review.source === 'template' ? 'Šablóna' : 'AI run'} ${review.runId}: schválených ${review.files.length} súborov`, 'ok');
    void get().persistNow();
    return true;
  },

  rejectStagedRun: () => {
    const review=get().pendingReview;if (!review) return;
    set({ pendingReview: null });
    if(review.messageId)get().updateMsg(review.messageId,{text:'Návrh odmietnutý. Jeho súbory sa do projektu nepoužili.',reviewPending:false,done:true,plan:undefined});
    void get().persistNow();
    get().log('⟲ AI zmeny odmietnuté bez zásahu do projektu', 'warn');
    get().toast('Zmeny odmietnuté — projekt nezmenený', 'warn');
  },

  applyStagedFiles: async (files, base) => {
    const st = get();
    const scope = persistenceScope();
    if (scope.databaseName === null || st.workspaceEpoch !== scope.epoch || st.generating || st.sandboxBuilding || st.pendingReview || st.edEditing || st.viewing || (st.codeDraftDirty && !base) || (base && !matchesCodeEditBase(st, base))) {
      get().toast('Zdrojová verzia alebo účet sa zmenili, prípadne prebieha iná úloha. Koncept zostal zachovaný.', 'warn');
      return false;
    }
    const snap = st.edSnap();
    if (!snap) { get().toast('Najprv vytvor projekt.', 'warn'); return false; }
    const current = st.vfs[snap.id] ?? filesFor(snap);
    const operations = files.map(file => ({ ...file, action: file.action ?? (current.some(f => f.name === file.path) ? 'modify' as const : 'create' as const) }));
    const next = applyFileOperations(current, operations, true);
    if (!next || (next.length && inspectProjectSources(next).errors.length)) {
      get().toast('Súbory neprešli kontrolou. Nič sa nepoužilo.', 'warn'); return false;
    }
    if (JSON.stringify(current.map(({name,content})=>({name,content}))) === JSON.stringify(next.map(({name,content})=>({name,content})))) return false;
    const html = filesToHtml(next);
    const child: Snapshot = { id: uid(), parentId: snap.id, v: Math.max(0,...st.snapshots.map(s=>s.v))+1,
      prompt: 'Ručná úprava: ' + files.map(f=>f.path).join(', ').slice(0,1000), kind: 'manual', time: now(), html, sourceFiles: JSON.stringify(next) };
    try {
      WorkspaceSchema.parse({title:st.projectTitle,isPublic:st.isPublic,liveId:child.id,files:next,
        snapshots:[...st.snapshots,child].map(({id,v,prompt,kind,time,html,pinned,msg,parentId,sourceFiles})=>({id,v,prompt,kind,time,html,pinned,msg,parentId,sourceFiles}))});
    } catch { get().toast('Úpravy prekračujú limity projektu alebo histórie. Koncept zostal zachovaný.','warn'); return false; }
    set({vfs:{...st.vfs,[child.id]:next},snapshots:[...st.snapshots,child],liveId:child.id,liveHtml:html,viewing:null,codeDraftDirty:false,
      sandboxHtml:null,sandboxErrors:[],sandboxBuilding:false});
    const persisted = await get().persistNow();
    if (persistenceScope().epoch === scope.epoch && get().projectId === st.projectId)
      get().toast(persisted ? 'Ručné zmeny uložené ako v' + child.v + '. Pôvodná verzia zostala v histórii.' : 'Nová verzia je v pamäti. Lokálne uloženie zlyhalo; koncept zálohy zostal zachovaný.', persisted ? 'ok' : 'warn');
    return persisted;
  },

  restoreFromDb: async () => {
    const epoch = persistenceScope().epoch;
    const projectId = get().projectId;
    try {
      const restored = await restoreWorkspace();
      if (persistenceScope().epoch !== epoch || get().projectId !== projectId) return;
      if (!restored.project) return;
      const snaps: Snapshot[] = restored.snapshots.map(s => ({ ...s }));
      const live = snaps.find(s => s.id === restored.project?.liveSnapshotId) ?? snaps[snaps.length - 1];
      const restoredVfs: Record<string, VfsFile[]> = {};
      for (const snapshot of snaps) {
        if (!snapshot.sourceFiles) continue;
        try {
          const files: unknown = JSON.parse(snapshot.sourceFiles);
          if (Array.isArray(files) && files.every(file => file && typeof file.name === 'string' && typeof file.content === 'string'))
            restoredVfs[snapshot.id] = files.map(file => ({ name: file.name, content: file.content, modified: false }));
        } catch { /* legacy snapshots still restore from their HTML */ }
      }
      if (live && restored.files.length) restoredVfs[live.id] = restored.files.map(f => ({ name: f.path, content: f.content, modified: false }));
      const transcript=ConversationSchema.safeParse(restored.project.conversation);
      const restoredMessages=transcript.success?transcript.data.map(turn=>({id:uid(),role:turn.role,text:turn.content,done:true})):[];
      set({
        messages: restoredMessages,
        workspaceEpoch: epoch,
        codeDraftDirty: false,
        snapshots: snaps,
        liveId: live?.id ?? null,
        liveHtml: live?.html ?? null,
        viewing: null,
        projectTitle: restored.project.title,
        remoteRevision: restored.project.remoteRevision ?? 0,
        remoteSnapshotIds: restored.project.remoteSnapshotIds ?? {},
        publishedUrl: restored.project.publishedUrl,
        isPublic: restored.project.isPublic,
        vfs: restoredVfs,
        projectId: restored.project.id,
      });
      if(live)get().setMode('work');
      dbg('restore: projekt obnovený z IndexedDB', 'snapshotov=' + snaps.length);
    } catch (e) {
      dbg('restore: zlyhal (prvý spustenie?)', String(e));
    }
  },

  /* ---------- M3 sandbox ---------- */
  sandboxHtml: null,
  sandboxBuilding: false,
  sandboxErrors: [],

  repairSandbox: async()=>{
    const st=get();
    if(st.generating||st.sandboxBuilding||st.pendingReview||st.edEditing||st.codeDraftDirty||st.viewing)return;
    const base=captureReviewBase(st),files=requestContext(st).files.filter(file=>/^(src\/|public\/)/.test(file.path)||/^(package\.json|index\.html|tsconfig\.json|vite\.config\.ts|README\.md)$/.test(file.path));
    if(!files.some(file=>file.path==='src/main.tsx')){get().toast('AI oprava náhľadu potrebuje React projekt.','warn');return;}
    const abort=new AbortController();
    const prompt='Oprava chýb zostavenia náhľadu';get().addMsg('user',prompt);
    const message=get().addMsg('assistant','Overujem build a pripravujem cielenú opravu…');
    set({generating:true,aiAbort:abort});get().setMode('work');get().setMview('chat');
    try{
      const result=await requestBuildRepair(files,{modelId:st.aiModelId,allowFallback:st.aiFallbackIds.length>0,fallbackIds:[...st.aiFallbackIds]},abort.signal);
      if(get().aiAbort!==abort||abort.signal.aborted)return;
      if(!matchesReviewBase(get(),base)){get().updateMsg(message.id,{text:'Projekt sa počas opravy zmenil. Návrh bol zahodený; spusti novú úlohu.',done:true});return;}
      if(!result.ok){get().updateMsg(message.id,{text:'AI oprava neprešla overením. Projekt zostal zachovaný; podrobnosti sú v konzole.',done:true});get().log('✗ AI oprava: '+result.buildErrors.map(error=>error.file+': '+error.message).join('; ').slice(0,800),'err');return;}
      if(!result.changes.length){get().updateMsg(message.id,{text:'Aktuálny projekt prešiel buildom bez AI opravy. Súbory sa nemenili.',done:true});return;}
      set({pendingReview:{runId:'build-repair-'+uid(),messageId:message.id,prompt,source:'patch',base,files:result.changes,summary:'Návrh prešiel buildom. '+(result.summary??'Skontroluj cielené zmeny.')},tab:'diff'});get().setMview('canvas');
      get().updateMsg(message.id,{text:'Oprava prešla buildom a čaká na tvoju kontrolu. Projekt sa zatiaľ nemenil.',reviewPending:true,done:true});
      get().log('✓ AI oprava overená buildom; čaká na schválenie. Pokusy: '+result.attempts,'ok');
    }catch(error){
      if(get().aiAbort!==abort)return;
      const text=error instanceof AiRequestError||error instanceof NetworkError?error.message:abort.signal.aborted?'AI oprava bola zastavená. Projekt zostal zachovaný.':'AI opravu sa nepodarilo dokončiť. Projekt zostal zachovaný.';
      get().updateMsg(message.id,{text,done:true});get().toast(text,'warn');
    }finally{if(get().aiAbort===abort){set({generating:false,aiAbort:null});void get().persistNow();}}
  },

  runSandbox: async () => {
    const st = get();
    if(st.codeDraftDirty){st.toast('Najprv ulož rozpracovaný koncept kódu.','warn');return;}
    const snap = st.edSnap();
    if (!snap) { get().toast('Najprv vygeneruj projekt', 'warn'); return; }
    /* len cesty povolené server pathGuardom — legacy VFS šablóna (styles.css, app.js) sa do buildu neposiela */
    const files = (st.vfs[snap.id] ?? filesFor(snap))
      .filter(f => /^(src\/|public\/)/.test(f.name) || /^(package\.json|index\.html|tsconfig\.json|vite\.config\.ts|README\.md)$/.test(f.name))
      .map(f => ({ path: f.name, content: f.content }));
    if (!files.some(f => f.path === 'src/main.tsx')) {
      set({ sandboxErrors: [{ file: '-', message: 'Projekt nemá src/main.tsx — sandbox podporuje React projekty z AI generovania (M3)' }] });
      get().toast('Sandbox: chýba src/main.tsx (React projekt)', 'warn');
      return;
    }
    sandboxController?.abort();
    const controller = new AbortController(); sandboxController = controller;
    const base = captureReviewBase(st);
    set({ sandboxBuilding: true, sandboxErrors: [], sandboxHtml: null });
    try {
      const res = await fetch((import.meta.env?.VITE_AI_API_BASE ?? '') + '/api/sandbox/build', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ files }),
        signal: controller.signal,
      });
      const result = await res.json() as { ok: boolean; html: string | null; errors: Array<{ file: string; message: string }> };
      if (controller.signal.aborted || sandboxController !== controller || !matchesReviewBase(get(), base)) return;
      if (result.ok && result.html) {
        set({ sandboxHtml: result.html, sandboxBuilding: false });
        get().log('✓ sandbox: projekt zabudovaný a spustený', 'ok');
      } else {
        set({ sandboxErrors: result.errors ?? [{ file: '-', message: 'build zlyhal' }], sandboxBuilding: false });
        get().log('✗ sandbox build: ' + (result.errors ?? []).map(e => e.message.slice(0, 80)).join('; '), 'err');
      }
    } catch (e) {
      if (controller.signal.aborted || sandboxController !== controller || !matchesReviewBase(get(), base)) return;
      set({ sandboxBuilding: false, sandboxErrors: [{ file: '-', message: 'Sandbox server nedostupný: ' + String(e).slice(0, 120) }] });
      get().toast('Sandbox server nedostupný — spusti npm run server', 'warn');
    } finally {
      if (sandboxController === controller) { sandboxController = null; set({ sandboxBuilding: false }); }
    }
  },

  stopSandbox: () => {
    sandboxController?.abort(); sandboxController = null;
    set({ sandboxHtml: null, sandboxErrors: [], sandboxBuilding: false });
    get().log('⟲ sandbox zastavený', 'warn');
  },

  persistNow: async () => {
    const st = get();
    if (st.snapshots.length === 0 && st.messages.length === 0) return true;
    const live = st.snapshots.find(snapshot => snapshot.id === st.liveId);
    const files = live ? st.vfs[live.id] ?? filesFor(live) : [];
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
        remoteRevision: st.remoteRevision,
        remoteSnapshotIds: st.remoteSnapshotIds,
        conversation: conversationContext(st.messages),
      },
      snapshots: st.snapshots.map(s => ({ ...s, projectId: st.projectId, pinned: !!s.pinned })),
      files: files.map(f => ({ projectId: st.projectId, path: f.name, content: f.content, updatedAt: now, revision: nextRevision() })),
    });
    if (err) get().toast('Uloženie zlyhalo: ' + err.message.slice(0, 80), 'warn');
    return !err;
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

  /* M4 Export actions */
  exportToZip: async () => {
    const st = get();
    if(st.codeDraftDirty){st.toast('Najprv ulož alebo zruš koncept kódu. ZIP obsahuje schválenú verziu.','warn');return;}
    const snap = st.edSnap();
    if (!snap) {
      get().toast('Najprv vygeneruj projekt', 'warn');
      return;
    }
    const epoch = persistenceScope().epoch, sourceFiles = st.vfs[snap.id], files = sourceFiles ?? [];
    const isCurrent = () => persistenceScope().epoch === epoch && get().projectId === st.projectId &&
      get().edSnap()?.id === snap.id && get().vfs[snap.id] === sourceFiles;
    try {
      const archive = await createProjectZip(files, st.projectTitle, snap.v);
      if (!isCurrent()) return;
      downloadProjectZip(archive);
      get().log('✓ ZIP export: ' + archive.filename, 'ok');
      get().toast('ZIP export úspešný: ' + archive.filename, 'ok');
    } catch {
      if (isCurrent()) get().toast('ZIP sa nepodarilo vytvoriť. Skontroluj cesty, veľkosť a možné kľúče v súboroch.', 'err');
    }
  },

  exportToGitHub: async () => {
    const st = get();
    if(st.codeDraftDirty){st.toast('Najprv ulož alebo zruš koncept kódu.','warn');return;}
    const epoch = persistenceScope().epoch;
    const run = ++githubExportRun;
    const isCurrent = () => githubExportRun === run && persistenceScope().epoch === epoch && get().projectId === st.projectId;
    const snap = st.edSnap();
    if (!snap) {
      get().toast('Najprv vygeneruj projekt', 'warn');
      return;
    }
    
    // Check GitHub availability first
    const githubStatus = await checkGitHubAvailable();
    if (!isCurrent()) return;
    if (!githubStatus.available || githubStatus.blocked) {
      const msg = githubStatus.blockReason 
        ? `GitHub export BLOCKED: ${githubStatus.blockReason} - ${githubStatus.message || ''}`
        : `GitHub export BLOCKED: ${githubStatus.message || 'Not configured'}`;
      get().toast(msg, 'err');
      return;
    }
    
    // Check auth
    const authState = await doCheckGitHubAuth();
    if (!isCurrent()) return;
    if (!authState.authenticated || authState.blocked) {
      const msg = authState.blockReason
        ? `GitHub export BLOCKED: ${authState.blockReason} - ${authState.message || ''}`
        : 'GitHub export BLOCKED: Nie ste prihlásený.';
      get().toast(msg, 'warn');
      // Offer to connect GitHub
      if (!authState.authenticated && !authState.blocked) {
        const tryConnect = confirm('Chcete sa pripojiť k GitHub?');
        if (tryConnect) {
          initiateGitHubAuth();
        }
      }
      return;
    }
    
    set({ githubExportInProgress: true });
    try {
      const { files, warnings, missingRequired } = prepareVfsForExport(st.vfs, snap.id);
      
      // Check for secrets
      const hasSecretWarning = warnings.some(w => w.includes('SECRET'));
      if (hasSecretWarning) {
        get().toast('GitHub export BLOCKED: Potential secrets detected. ' + warnings.join('; '), 'err');
        return;
      }
      
      if (files.length === 0) {
        get().toast('Projekt nemá žiadne exportovateľné súbory', 'warn');
        return;
      }
      
      // For now, use a default repo name based on project title
      const repoName = 'lov-devil-' + st.projectTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36).slice(-6);
      const isPrivate = authState.scopes?.includes('repo') === true;
      if (!isPrivate && !authState.scopes?.includes('public_repo')) {
        get().toast('GitHub export BLOCKED: Chýba overené oprávnenie na repozitáre. Pripoj GitHub znova.', 'warn');
        return;
      }
      
      // Show confirmation dialog
      const userConfirmed = confirm(
        `Create GitHub repository '${repoName}'?\n\n` +
        `This will create a new ${isPrivate ? 'private' : 'PUBLIC'} repository under your GitHub account.\n` +
        (isPrivate ? '' : 'The repository and exported source files will be visible to everyone.\n\n') +
        `Files: ${files.length} | Description: ${'Exported from LOV-DEVIL AI Builder - ' + st.projectTitle}\n\n` +
        (missingRequired.length > 0 ? `WARNING: Missing required files: ${missingRequired.join(', ')}\n` : '') +
        `Click OK to confirm.`
      );
      
      if (!isCurrent()) return;
      if (!userConfirmed) {
        get().toast('GitHub export cancelled', 'warn');
        return;
      }
      
      const request: GitHubExportRequest = {
        repoName,
        description: 'Exported from LOV-DEVIL AI Builder - ' + st.projectTitle,
        isPrivate,
        files: files.map(f => ({ path: f.path, content: f.content })),
      };
      
      if (!authState.csrfToken) return;
      const result = await doGitHubExport(request, true, { csrfToken: authState.csrfToken, isCurrent });
      if (!isCurrent()) return;
      if (result.ok && result.repoUrl) {
        get().log('✓ GitHub export: ' + result.repoUrl, 'ok');
        get().toast('GitHub export úspešný! ' + result.repoUrl, 'ok');
      } else if (result.blocked) {
        get().toast('GitHub export BLOCKED: ' + (result.blockReason || result.error || 'Unknown'), 'err');
      } else {
        get().toast('GitHub export zlyhal: ' + (result.error || 'Neznáma chyba'), 'err');
      }
    } catch (e) {
      if (!isCurrent()) return;
      get().toast('GitHub export zlyhal: ' + String(e).slice(0, 100), 'err');
    } finally {
      if (githubExportRun === run && persistenceScope().epoch === epoch) set({ githubExportInProgress: false });
    }
  },

  connectGitHub: () => {
    initiateGitHubAuth();
  },

  checkGitHubAuth: async () => {
    const epoch = persistenceScope().epoch;
    try {
      const authState = await doCheckGitHubAuth();
      if (persistenceScope().epoch !== epoch) return;
      set({ githubAuthState: authState });
    } catch {
      if (persistenceScope().epoch === epoch) set({ githubAuthState: { authenticated: false } });
    }
  },
}));
