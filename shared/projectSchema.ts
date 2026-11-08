import {ConversationSchema} from './conversation';
import { z } from 'zod';
import { containsPotentialSecret } from '../server/security/secrets';
import { isSafePath, withinSizeLimits } from '../server/security/pathGuard';

export const ProjectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const File = z.object({ name: z.string().max(200), content: z.string().max(200_000), modified: z.boolean().optional() }).strict();
const filesValid = (files: z.infer<typeof File>[]) => new Set(files.map(file => file.name)).size === files.length &&
  files.every(file => isSafePath(file.name) || ['styles.css', 'app.js'].includes(file.name)) &&
  withinSizeLimits(files.map(file => ({ path: file.name, content: file.content }))).ok;
export const Files = File.array().max(40).refine(filesValid, 'invalid_files');
export const SnapshotSchema = z.object({
  id: ProjectId, v: z.number().int().positive(), prompt: z.string().max(20_000), kind: z.string().max(50),
  time: z.string().max(100), html: z.string().max(2_000_000), pinned: z.boolean().optional(), msg: z.string().max(2000).optional(),
  parentId: ProjectId.nullable().optional(), sourceFiles: z.string().max(3_000_000).optional(),
}).strict().refine(snapshot => {
  if (snapshot.sourceFiles === undefined) return true;
  try { return Files.safeParse(JSON.parse(snapshot.sourceFiles)).success; } catch { return false; }
}, 'invalid_snapshot_sources');
export const WorkspaceSchema = z.object({
  title: z.string().trim().min(1).max(120), isPublic: z.boolean(), liveId: ProjectId.nullable(),
  snapshots: SnapshotSchema.array().max(100), files: Files,
  conversation: ConversationSchema.optional(),
}).strict().refine(workspace => {
  const ids = new Set<string>(), versions = new Set<number>();
  let lastVersion=0;
  for (const snapshot of workspace.snapshots) {
    if (snapshot.v<=lastVersion || ids.has(snapshot.id) || versions.has(snapshot.v) || (snapshot.parentId && !ids.has(snapshot.parentId))) return false;
    lastVersion=snapshot.v;
    ids.add(snapshot.id); versions.add(snapshot.v);
  }
  return workspace.liveId === null ? workspace.files.length === 0 : ids.has(workspace.liveId);
}, 'invalid_history');
export type ServerWorkspace = z.infer<typeof WorkspaceSchema>;
export const SaveSchema = z.object({ expectedRevision: z.number().int().min(0).max(2_147_483_646), workspace: WorkspaceSchema }).strict()
  .refine(body => !containsPotentialSecret(JSON.stringify(body.workspace)), 'potential_secret');
export const RevisionSchema = z.object({ expectedRevision: z.number().int().min(1).max(2_147_483_646) }).strict();

export function preservesHistory(previous: ServerWorkspace, next: ServerWorkspace): boolean {
  return previous.snapshots.every((snapshot, index) => {
    const candidate = next.snapshots[index];
    if (!candidate || candidate.id !== snapshot.id) return false;
    const keys = new Set([...Object.keys(snapshot), ...Object.keys(candidate)]);
    return [...keys].every(key => key === 'pinned' || Reflect.get(snapshot, key) === Reflect.get(candidate, key));
  });
}
