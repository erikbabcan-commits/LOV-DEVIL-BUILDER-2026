export interface DiffSnapshot {
  id: string; v: number; html: string; sourceFiles?: string; parentId?: string | null;
}
export interface SourceFile { name: string; content: string }
export interface FileChange { path: string; before?: string; after?: string; status: 'added' | 'deleted' | 'modified' }
export interface DiffLine { kind: 'context' | 'add' | 'delete'; text: string; oldLine?: number; newLine?: number }

/** Older HTML snapshots have no source payload; never invent generated helper files. */
export function snapshotSources(snapshot: DiffSnapshot, vfs: Record<string, SourceFile[]>): SourceFile[] | null {
  if (vfs[snapshot.id]) return vfs[snapshot.id];
  if (snapshot.sourceFiles !== undefined) {
    try {
      const files: unknown = JSON.parse(snapshot.sourceFiles);
      if (Array.isArray(files) && files.every(file => file && typeof file.name === 'string' && typeof file.content === 'string') &&
          new Set(files.map(file => file.name)).size === files.length) return files;
    } catch { /* damaged source payload must not look like an empty project */ }
    return null;
  }
  return [{ name: 'index.html', content: snapshot.html }];
}

export function parentOf(snapshots: DiffSnapshot[], target: DiffSnapshot): DiffSnapshot | undefined {
  if (target.parentId !== undefined) return snapshots.find(snapshot => snapshot.id === target.parentId);
  return snapshots[snapshots.findIndex(snapshot => snapshot.id === target.id) - 1];
}

export function changedFiles(before: SourceFile[], after: SourceFile[]): FileChange[] {
  const a = new Map(before.map(file => [file.name, file.content]));
  const b = new Map(after.map(file => [file.name, file.content]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(path => {
    if (a.has(path) && b.has(path) && a.get(path) === b.get(path)) return [];
    return [{ path, before: a.get(path), after: b.get(path), status: !a.has(path) ? 'added' as const : !b.has(path) ? 'deleted' as const : 'modified' as const }];
  });
}

/** Ordered line comparison. Bound the quadratic table; large edits still show every changed line. */
export function lineDiff(before: string | undefined, after: string | undefined): { lines: DiffLine[]; coarse: boolean } {
  const a = before === undefined ? [] : before.split('\n');
  const b = after === undefined ? [] : after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  const lines: DiffLine[] = [];
  let oldLine = 1, newLine = 1;
  const emit = (kind: DiffLine['kind'], text: string) => {
    lines.push({ kind, text, oldLine: kind === 'add' ? undefined : oldLine++, newLine: kind === 'delete' ? undefined : newLine++ });
  };
  for (let i = 0; i < prefix; i++) emit('context', a[i]);
  const coarse = (n + 1) * (m + 1) > 250_000;
  if (coarse) {
    for (let i = 0; i < n; i++) emit('delete', a[prefix + i]);
    for (let j = 0; j < m; j++) emit('add', b[prefix + j]);
  } else {
    const width = m + 1, table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = a[prefix + i] === b[prefix + j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { emit('context', a[prefix + i]); i++; j++; }
      else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) emit('delete', a[prefix + i++]);
      else emit('add', b[prefix + j++]);
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) emit('context', a[i]);
  return { lines, coarse };
}
