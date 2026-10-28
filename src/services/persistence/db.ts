/* Workstream B: IndexedDB perzistencia — verzovaná schéma, atómické zápisy,
   obnova po refreshi, migrácie, quota reporting, immutabilné snapshoty.
   Podľa docs/PERSISTENCE-PLAN.md (M0 návrh, M2 implementácia). */

export const DB_NAME = 'forge-builder';
export const DB_VERSION = 2;

export interface StoredProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  liveSnapshotId: string | null;
  publishedUrl: string | null;
  isPublic: boolean;
}

export interface StoredSnapshot {
  id: string;
  projectId: string;
  v: number;
  prompt: string;
  kind: string;
  time: string;
  html: string;
  pinned: boolean;
  /* AI run metadata (M2): ktorý run snapshot vytvoril */
  runId?: string;
  model?: string;
}

export interface StoredFile {
  projectId: string;
  path: string;
  content: string;
  updatedAt: number;
  revision: number;
}

export interface StoredRun {
  id: string;
  projectId: string;
  prompt: string;
  mode: string;
  status: 'completed' | 'failed' | 'cancelled';
  model: string;
  createdAt: number;
  planSummary: string | null;
  fileCount: number;
}

export interface StoredMeta { key: string; value: unknown }

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      const oldVersion = e.oldVersion;
      /* v1 → v2 migrácia: pridáme runs store + file revision index */
      if (oldVersion < 1) {
        db.createObjectStore('projects', { keyPath: 'id' });
        const snaps = db.createObjectStore('snapshots', { keyPath: 'id' });
        snaps.createIndex('byProject', 'projectId');
        db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('runs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) {
          const s = db.createObjectStore('snapshots', { keyPath: 'id' });
          s.createIndex('byProject', 'projectId');
        }
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T;
    let failed = false;
    let failure: unknown;
    const abort = (error: unknown) => {
      failed = true;
      failure = error;
      try { t.abort(); }
      catch { reject(error); }
    };
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(failed ? failure : t.error ?? new Error('transaction aborted'));
    // Callback validation/clone errors must roll back queued writes too, not only
    // reject this Promise while IndexedDB commits a partially updated workspace.
    try { Promise.resolve(fn(t)).then(r => { result = r; }, abort); }
    catch (error) { abort(error); }
  }));
}

function rq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class QuotaError extends Error {
  constructor(public original: unknown) { super('IndexedDB quota prekročená — projekt sa nezmestí do úložiska.'); }
}

async function guarded<T>(p: Promise<T>): Promise<T> {
  try { return await p; }
  catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'AbortError')) throw new QuotaError(e);
    throw e;
  }
}

/* ---------- projects ---------- */

export async function saveProject(p: StoredProject): Promise<void> {
  await guarded(tx(['projects'], 'readwrite', t => { t.objectStore('projects').put(p); }));
}

export async function loadProjects(): Promise<StoredProject[]> {
  return guarded(tx(['projects'], 'readonly', t => rq(t.objectStore('projects').getAll() as IDBRequest<StoredProject[]>)));
}

/* Every persisted snapshot field is scalar. Only pinned is mutable UI metadata;
   compare all other fields without relying on object property insertion order. */
function sameSnapshotContent(existing: StoredSnapshot, incoming: StoredSnapshot): boolean {
  const keys = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  return [...keys].every(key => key === 'pinned' || Reflect.get(existing, key) === Reflect.get(incoming, key));
}

export async function saveProjectState(state: {
  project: StoredProject;
  snapshots: StoredSnapshot[];
  files: StoredFile[];
}): Promise<void> {
  await guarded(tx(['projects', 'snapshots', 'files', 'meta'], 'readwrite', async t => {
    const { project } = state;
    const snapshots = t.objectStore('snapshots');
    await rq(t.objectStore('projects').put(project));
    await rq(t.objectStore('meta').put({ key: 'lastProject', value: project.id } as StoredMeta));

    for (const snapshot of state.snapshots) {
      if (snapshot.projectId !== project.id) throw new Error('Snapshot belongs to a different project');
      const existing = await rq(snapshots.get(snapshot.id) as IDBRequest<StoredSnapshot | undefined>);
      if (!existing) {
        await rq(snapshots.add(snapshot));
      } else {
        if (!sameSnapshotContent(existing, snapshot)) throw new Error('Immutable snapshot conflict');
        if (existing.pinned !== snapshot.pinned) await rq(snapshots.put({ ...existing, pinned: snapshot.pinned }));
      }
    }

    if (project.liveSnapshotId !== null) {
      const live = await rq(snapshots.get(project.liveSnapshotId) as IDBRequest<StoredSnapshot | undefined>);
      if (!live || live.projectId !== project.id) throw new Error('Live snapshot is missing or belongs to a different project');
    }

    // Previously prepared batches may contain several revisions of one path.
    // Keep the newest so retrying the same batch remains idempotent.
    const newestFiles = new Map<string, StoredFile>();
    for (const file of state.files) {
      if (file.projectId !== project.id) throw new Error('File belongs to a different project');
      const previous = newestFiles.get(file.path);
      if (!previous || previous.revision <= file.revision) newestFiles.set(file.path, file);
    }
    const files = t.objectStore('files');
    for (const file of newestFiles.values()) {
      if (!await saveFileInTransaction(files, file)) {
        // Do not advance the project pointer while retaining a different/newer
        // source version from a previously committed workspace.
        throw new Error('Stale file revision');
      }
    }
    // This is the complete live file set, not a patch. Keep deletions in the
    // same commit so a reload cannot resurrect files removed by an approval.
    const previousFiles = await rq(files.getAll(IDBKeyRange.bound([project.id, ''], [project.id, '\uffff'])) as IDBRequest<StoredFile[]>);
    for (const file of previousFiles) {
      if (!newestFiles.has(file.path)) await rq(files.delete([project.id, file.path]));
    }
  }));
}

/* ---------- snapshots (immutable: nikdy put na existujúci id) ---------- */

export async function saveSnapshot(s: StoredSnapshot): Promise<void> {
  await guarded(tx(['snapshots'], 'readwrite', t => rq(t.objectStore('snapshots').add(s))));
}

export async function loadSnapshots(projectId: string): Promise<StoredSnapshot[]> {
  return guarded(tx(['snapshots'], 'readonly', t =>
    rq(t.objectStore('snapshots').index('byProject').getAll(projectId) as IDBRequest<StoredSnapshot[]>)));
}

/* ---------- files (revízie chránia proti stale async prepisu) ---------- */

async function saveFileInTransaction(store: IDBObjectStore, file: StoredFile): Promise<boolean> {
  const existing = await rq(store.get([file.projectId, file.path]) as IDBRequest<StoredFile | undefined>);
  if (existing && existing.revision > file.revision) return false;
  await rq(store.put(file));
  return true;
}

export async function saveFile(f: StoredFile): Promise<boolean> {
  return guarded(tx(['files'], 'readwrite', t => saveFileInTransaction(t.objectStore('files'), f)));
}

export async function loadFiles(projectId: string): Promise<StoredFile[]> {
  return guarded(tx(['files'], 'readonly', t =>
    rq((t.objectStore('files') as IDBObjectStore & { getAllByPrefix?: unknown }).getAll(IDBKeyRange.bound([projectId, ''], [projectId, '\uffff'])) as IDBRequest<StoredFile[]>)));
}

/* ---------- runs ---------- */

export async function saveRun(r: StoredRun): Promise<void> {
  await guarded(tx(['runs'], 'readwrite', t => { t.objectStore('runs').put(r); }));
}

export async function loadRuns(projectId: string): Promise<StoredRun[]> {
  const all = await guarded(tx(['runs'], 'readonly', t => rq(t.objectStore('runs').getAll() as IDBRequest<StoredRun[]>)));
  return all.filter(r => r.projectId === projectId);
}

/* ---------- meta ---------- */

export async function saveMeta(key: string, value: unknown): Promise<void> {
  await guarded(tx(['meta'], 'readwrite', t => { t.objectStore('meta').put({ key, value } as StoredMeta); }));
}

export async function loadMeta<T>(key: string): Promise<T | null> {
  const m = await guarded(tx(['meta'], 'readonly', t => rq(t.objectStore('meta').get(key) as IDBRequest<StoredMeta | undefined>)));
  return m ? (m.value as T) : null;
}
