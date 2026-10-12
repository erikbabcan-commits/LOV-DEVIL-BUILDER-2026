import { openDb, saveProject, loadProjects, saveSnapshot, loadSnapshots, saveFile, loadFiles, saveRun, loadRuns, saveMeta, loadMeta, StoredProject, StoredSnapshot, StoredFile, StoredRun, QuotaError, DB_VERSION } from './db';

/* Projekťový persistence servis: debounced autosave, restore, obnova po prerušení.
   Stale async zápisy nemôžu prepísať novšiu revíziu (revision guard v db.saveFile). */

export { QuotaError };

export interface PersistError { message: string; kind: 'quota' | 'io' }

let lastAutosaveTimer: number | null = null;
let currentRevision = 0;

export function nextRevision(): number {
  return ++currentRevision;
}

/* ---------- autosave (debounced) ---------- */

export function scheduleAutosave(save: () => Promise<void>, debounceMs = 600): void {
  if (lastAutosaveTimer !== null) clearTimeout(lastAutosaveTimer);
  lastAutosaveTimer = window.setTimeout(() => {
    lastAutosaveTimer = null;
    void save().catch(err => {
      if (err instanceof QuotaError) console.warn('[Forge persistence]', err.message);
      else console.warn('[Forge persistence] autosave zlyhal:', err);
    });
  }, debounceMs);
}

/* ---------- plný stav projektu ---------- */

export interface ProjectState {
  project: StoredProject;
  snapshots: StoredSnapshot[];
  files: StoredFile[];
}

export async function persistProjectState(state: ProjectState): Promise<PersistError | null> {
  try {
    await saveProject(state.project);
    for (const s of state.snapshots) await saveSnapshot(s);
    for (const f of state.files) await saveFile(f);
    await saveMeta('lastProject', state.project.id);
    return null;
  } catch (e) {
    if (e instanceof QuotaError) return { message: e.message, kind: 'quota' };
    return { message: String(e), kind: 'io' };
  }
}

export async function persistRun(run: StoredRun): Promise<void> {
  await saveRun(run);
}

/* ---------- restore po refreshi ---------- */

export interface RestoredWorkspace {
  project: StoredProject | null;
  snapshots: StoredSnapshot[];
  files: StoredFile[];
  runs: StoredRun[];
}

export async function restoreWorkspace(): Promise<RestoredWorkspace> {
  await openDb();
  const lastId = await loadMeta<string>('lastProject');
  const projects = await loadProjects();
  if (projects.length === 0) {
    return { project: null, snapshots: [], files: [], runs: [] };
  }
  const project = projects.find(p => p.id === lastId) ?? projects[projects.length - 1];
  const [snapshots, files, runs] = await Promise.all([
    loadSnapshots(project.id),
    loadFiles(project.id),
    loadRuns(project.id),
  ]);
  return { project, snapshots, files, runs };
}

export async function markInterruptedWrites(): Promise<string[]> {
  /* Obnova po prerušených zápisoch: runs bez completed statusu v meta označíme ako interrupted */
  const interrupted = await loadMeta<string[]>('interruptedRuns');
  if (interrupted && interrupted.length) await saveMeta('interruptedRuns', []);
  return interrupted ?? [];
}
