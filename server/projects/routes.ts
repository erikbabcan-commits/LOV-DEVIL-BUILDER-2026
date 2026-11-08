import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DbLike } from '../db/pool';
import { getUserFromContext } from '../auth/middleware';
import { ProjectId, SaveSchema, RevisionSchema, WorkspaceSchema, preservesHistory } from './schema';
import { DEFAULT_PROJECT_STORAGE, fitsProjectStorage, projectStorageUsage, validateProjectStoragePolicy, type ProjectStoragePolicy } from './storage';
import { initialBlueprint } from './blueprints';

export const PROJECT_BODY_BYTES = 8_000_000;
interface ProjectRow { project_id: string; title: string; revision: number; workspace: unknown; updated_at: Date; deleted_at: Date | null }
/** Mounted after session + CSRF middleware, and only with durable auth wiring. */
export function projectRouter(db: DbLike, allow: (key: string) => boolean, policy: ProjectStoragePolicy = DEFAULT_PROJECT_STORAGE) {
  validateProjectStoragePolicy(policy);
  const router = new Hono();
  router.onError((_error, c) => c.json({ error: 'project_storage_unavailable' }, 503));
  router.use('/api/projects/*', bodyLimit({ maxSize: PROJECT_BODY_BYTES, onError: c => c.json({ error: 'project_too_large' }, 413) }));
  router.use('/api/projects', bodyLimit({ maxSize: PROJECT_BODY_BYTES, onError: c => c.json({ error: 'project_too_large' }, 413) }));
  const guard: MiddlewareHandler = async (c, next) => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (!allow('projects:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    c.header('Cache-Control', 'no-store');
    try { return await next(); } catch { return c.json({ error: 'project_storage_unavailable' }, 503); }
  };
  router.use('/api/projects', guard);
  router.use('/api/projects/:id', guard);
  router.use('/api/projects/:id/:action', guard);
  router.get('/api/project-storage', async c => {
    c.header('Cache-Control', 'no-store');
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_storage_query' }, 400);
    if (!allow('project-storage:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    return c.json(await projectStorageUsage(db, user.id, policy));
  });
  router.get('/api/projects', async c => {
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    const cursor = c.req.query('cursor') ?? '';
    if (cursor && !ProjectId.safeParse(cursor).success) return c.json({ error: 'invalid_project_cursor' }, 400);
    const deleted = c.req.query('deleted') === '1';
    c.header('Cache-Control', 'no-store');
    try {
      const result = await db.query(`SELECT project_id, title, revision, updated_at, deleted_at FROM builder_projects
        WHERE owner_id = $1 AND project_id > $2 AND deleted_at IS ${deleted ? 'NOT NULL' : 'NULL'} ORDER BY project_id ASC LIMIT 51`, [user.id, cursor]);
      const rows = result.rows as ProjectRow[];
      return c.json({ projects: rows.slice(0, 50).map(row => ({ id: row.project_id, title: row.title, revision: row.revision, updatedAt: row.updated_at, deletedAt: row.deleted_at })), nextCursor: rows.length > 50 ? rows[49].project_id : null });
    } catch { return c.json({ error: 'project_storage_unavailable' }, 503); }
  });
  router.get('/api/projects/:id', async c => {
    if (!ProjectId.safeParse(c.req.param('id')).success) return c.json({ error: 'invalid_project_id' }, 400);
    const result = await db.query('SELECT project_id, revision, workspace, deleted_at FROM builder_projects WHERE owner_id = $1 AND project_id = $2', [getUserFromContext(c)!.id, c.req.param('id')]);
    const row = result.rows[0] as ProjectRow | undefined;
    if (!row) return c.json({ error: 'project_not_found' }, 404);
    if (row.deleted_at) return c.json({ error: 'project_deleted' }, 410);
    const workspace = WorkspaceSchema.safeParse(row.workspace);
    if (!workspace.success) return c.json({ error: 'project_storage_unavailable' }, 503);
    return c.json({ id: row.project_id, revision: row.revision, workspace: workspace.data });
  });
  router.post('/api/projects/:id', async c => {
    if (!ProjectId.safeParse(c.req.param('id')).success) return c.json({ error: 'invalid_project_id' }, 400);
    const parsed = SaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_project' }, 400);
    const { expectedRevision, workspace } = parsed.data;
    const owner = getUserFromContext(c)!.id, id = c.req.param('id');
    if (!db.transaction) return c.json({ error: 'project_storage_unavailable' }, 503);
    const serialized = JSON.stringify(workspace);
    const result = await db.transaction(async tx => {
      if (!(await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner])).rows.length) return { body: { error: 'unauthenticated' }, status: 401 as const };
      const existing = await tx.query('SELECT revision, workspace, deleted_at, octet_length(workspace::text) AS bytes FROM builder_projects WHERE owner_id = $1 AND project_id = $2', [owner, id]);
      const row = existing.rows[0] as ProjectRow | undefined;
      if (expectedRevision === 0) {
        if (row) return { body: { error: 'project_conflict' }, status: 409 as const };
      } else {
        if (!row) return { body: { error: 'project_not_found' }, status: 404 as const };
        if (row.deleted_at) return { body: { error: 'project_deleted' }, status: 410 as const };
        if (row.revision !== expectedRevision) return { body: { error: 'project_conflict' }, status: 409 as const };
        const previous = WorkspaceSchema.safeParse(row.workspace);
        if (!previous.success) return { body: { error: 'project_storage_unavailable' }, status: 503 as const };
        if (!preservesHistory(previous.data, workspace)) return { body: { error: 'immutable_history' }, status: 409 as const };
      }
      const usage = await projectStorageUsage(tx, owner, policy);
      const bytes = Number((await tx.query('SELECT octet_length($1::jsonb::text) AS bytes', [serialized])).rows[0].bytes);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid_storage_measurement');
      const oldBytes = existing.rows[0] ? Number(existing.rows[0].bytes) : 0;
      if (!fitsProjectStorage(usage, usage.usedBytes - oldBytes + bytes, usage.usedProjects + (row ? 0 : 1)))
        return { body: { error: 'project_storage_quota', usage }, status: 413 as const };
      const saved = expectedRevision === 0
        ? await tx.query(`INSERT INTO builder_projects (owner_id, project_id, title, revision, workspace)
          VALUES ($1, $2, $3, 1, $4::jsonb) ON CONFLICT (owner_id, project_id) DO NOTHING RETURNING revision`, [owner, id, workspace.title, serialized])
        : await tx.query(`UPDATE builder_projects SET title = $3, workspace = $4::jsonb, revision = revision + 1, updated_at = now()
          WHERE owner_id = $1 AND project_id = $2 AND revision = $5 AND deleted_at IS NULL RETURNING revision`, [owner, id, workspace.title, serialized, expectedRevision]);
      if (!saved.rows.length) return { body: { error: 'project_conflict' }, status: 409 as const };
      const starter = expectedRevision === 0 ? initialBlueprint(workspace) : null;
      if (starter) await tx.query(
        'INSERT INTO blueprint_uses (owner_id, snapshot_id, blueprint_id) VALUES ($1,$2,$3) ON CONFLICT (owner_id,snapshot_id) DO NOTHING',
        [owner, starter.snapshotId, starter.blueprintId],
      );
      if (workspace.liveId && workspace.files.length > 0)
        await tx.query('UPDATE users SET first_observed_app_save_at = now() WHERE id = $1 AND first_observed_app_save_at IS NULL', [owner]);
      return { body: { id, revision: saved.rows[0].revision }, status: expectedRevision === 0 ? 201 as const : 200 as const };
    });
    return c.json(result.body, result.status);
  });
  for (const action of ['delete', 'restore'] as const) router.post('/api/projects/:id/' + action, async c => {
    if (!ProjectId.safeParse(c.req.param('id')).success) return c.json({ error: 'invalid_project_id' }, 400);
    const parsed = RevisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_project_revision' }, 400);
    const owner = getUserFromContext(c)!.id, id = c.req.param('id');
    const existing = await db.query('SELECT revision, deleted_at FROM builder_projects WHERE owner_id = $1 AND project_id = $2', [owner, id]);
    if (!existing.rows.length) return c.json({ error: 'project_not_found' }, 404);
    const result = await db.query(`UPDATE builder_projects SET deleted_at = ${action === 'delete' ? 'now()' : 'NULL'}, revision = revision + 1, updated_at = now()
      WHERE owner_id = $1 AND project_id = $2 AND revision = $3 AND ${action === 'delete' ? 'deleted_at IS NULL' : 'deleted_at IS NOT NULL AND deleted_at >= $4'} RETURNING revision`,
    action === 'delete' ? [owner, id, parsed.data.expectedRevision] : [owner, id, parsed.data.expectedRevision, new Date(Date.now() - 30 * 86400_000)]);
    return result.rows.length ? c.json({ id, revision: result.rows[0].revision }) : c.json({ error: 'project_conflict' }, 409);
  });
  return router;
}
