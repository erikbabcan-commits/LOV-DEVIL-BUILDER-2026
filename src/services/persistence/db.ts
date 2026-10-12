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
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    t.onerror = () => reject(t.error ?? new Error('transaction error'));
    Promise.resolve(fn(t)).then(r => { result = r; }).catch(reject);
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

/* ---------- snapshots (immutable: nikdy put na existujúci id) ---------- */

export async function saveSnapshot(s: StoredSnapshot): Promise<void> {
  await guarded(tx(['snapshots'], 'readwrite', t => rq(t.objectStore('snapshots').add(s))));
}

export async function loadSnapshots(projectId: string): Promise<StoredSnapshot[]> {
  return guarded(tx(['snapshots'], 'readonly', t =>
    rq(t.objectStore('snapshots').index('byProject').getAll(projectId) as IDBRequest<StoredSnapshot[]>)));
}

/* ---------- files (revízie chránia proti stale async prepisu) ---------- */

export async function saveFile(f: StoredFile): Promise<boolean> {
  return guarded(tx(['files'], 'readwrite', async t => {
    const store = t.objectStore('files');
    const existing = await rq(store.get([f.projectId, f.path]) as IDBRequest<StoredFile | undefined>);
    /* stale-write ochrana: novší revision nesmie prepísať starší zápis */
    if (existing && existing.revision > f.revision) return false;
    store.put(f);
    return true;
  }));
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
