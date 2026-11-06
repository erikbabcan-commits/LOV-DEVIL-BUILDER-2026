import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DbLike } from '../db/pool';
import { ProjectId, WorkspaceSchema } from '../../shared/projectSchema';
import { isSafePath, withinSizeLimits } from '../security/pathGuard';
import { containsPotentialSecret } from '../security/secrets';
import { GitHubSnapshotSelection } from '../../shared/githubExportProtocol';
export { GitHubSnapshotSelection } from '../../shared/githubExportProtocol';

type Selection = z.infer<typeof GitHubSnapshotSelection>;
type Failure = 'invalid_selection' | 'project_not_found' | 'project_deleted' | 'project_conflict' | 'snapshot_not_found' | 'invalid_sources';
type Result = { ok: false; error: Failure } | { ok: true; projectId: string; snapshotId: string; revision: number;
  title: string; version: number; fingerprint: string; files: Array<{ path: string; content: string }> };

/** Server-authoritative export input. Never accept uploaded source files from
 * the export browser. Owner is supplied only from verified auth middleware.
 * One DB read pins the selected workspace revision, including historical files.
 * Does not call GitHub or grant publication permission.
 */
export async function loadGitHubSnapshot(db: DbLike, ownerId: string, selection: Selection): Promise<Result> {
  if (!ProjectId.safeParse(ownerId).success || !GitHubSnapshotSelection.safeParse(selection).success) return { ok: false, error: 'invalid_selection' };
  const result = await db.query('SELECT revision, workspace, deleted_at FROM builder_projects WHERE owner_id = $1 AND project_id = $2', [ownerId, selection.projectId]);
  const row = result.rows[0];
  if (!row) return { ok: false, error: 'project_not_found' };
  if (row.deleted_at) return { ok: false, error: 'project_deleted' };
  if (row.revision !== selection.expectedRevision) return { ok: false, error: 'project_conflict' };
  const parsed = WorkspaceSchema.safeParse(row.workspace);
  if (!parsed.success) return { ok: false, error: 'invalid_sources' };
  const snapshot = parsed.data.snapshots.find(s => s.id === selection.snapshotId);
  if (!snapshot) return { ok: false, error: 'snapshot_not_found' };
  const sources: Array<{ name: string; content: string }> = snapshot.sourceFiles === undefined
    ? (snapshot.html ? [{ name: 'index.html', content: snapshot.html }] : [])
    : JSON.parse(snapshot.sourceFiles);
  const files = sources.map(file => ({ path: file.name, content: file.content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.length || !withinSizeLimits(files).ok || files.some(file =>
    (!isSafePath(file.path) && !['styles.css', 'app.js'].includes(file.path)) ||
    file.path.split('/').some(part => ['.git', '.github', 'node_modules', '.vscode'].includes(part)) ||
    containsPotentialSecret(file.path + '\n' + file.content))) return { ok: false, error: 'invalid_sources' };
  const fingerprint = createHash('sha256').update(JSON.stringify({ ownerId, ...selection, files })).digest('hex');
  return { ok: true, projectId: selection.projectId, snapshotId: selection.snapshotId,
    revision: row.revision, title: parsed.data.title, version: snapshot.v, fingerprint, files };
}
