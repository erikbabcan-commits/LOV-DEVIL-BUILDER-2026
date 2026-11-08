import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { effectivePlan } from '../auth/plans';
import { getUserFromContext } from '../auth/middleware';
import type { DbLike } from '../db/pool';
import { validateFiles } from '../sandbox/policy';
import { Files, ProjectId, RevisionSchema, WorkspaceSchema } from './schema';

const root = '/api/private-blueprints';
const limit = 10;
const maxSourceBytes = 512 * 1024;
const creation = RevisionSchema.extend({ projectId: ProjectId, snapshotId: ProjectId });
const uuid = z.uuid();
const emptyBody = z.strictObject({});

export function privateBlueprintRouter(db: DbLike, allow: (key: string) => boolean) {
  const router = new Hono();
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_query' }, 400);
    if (!allow('private-blueprints:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    return next();
  };
  router.use(root + '/*', guard);
  const bounded = bodyLimit({ maxSize: 2048, onError: c => c.json({ error: 'invalid_private_blueprint' }, 413) });
  router.use(root + '/*', bounded);
  router.onError((_error, c) => c.json({ error: 'private_blueprints_unavailable' }, 503));

  router.get(root, async c => {
    const user = getUserFromContext(c)!;
    const { rows } = await db.query(`SELECT id, title, file_count AS "fileCount" FROM private_blueprints
      WHERE owner_id=$1 ORDER BY created_at DESC, id LIMIT $2`, [user.id, limit]);
    return c.json({ canUse: user.plan === 'pro', templates: rows });
  });
  router.get(root + '/:id', async c => {
    const user = getUserFromContext(c)!;
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'private_blueprint_not_found' }, 404);
    if (user.plan !== 'pro') return c.json({ error: 'private_blueprint_pro_required' }, 403);
    const { rows } = await db.query('SELECT id, title, files FROM private_blueprints WHERE owner_id=$1 AND id=$2', [user.id, id.data]);
    if (!rows.length) return c.json({ error: 'private_blueprint_not_found' }, 404);
    const row = rows[0];
    return c.json({ id: row.id, title: row.title, files: Files.parse(row.files) });
  });
  router.post(root, async c => {
    const owner = getUserFromContext(c)!.id;
    const selection = creation.safeParse(await c.req.json().catch(() => null));
    if (!selection.success) return c.json({ error: 'invalid_private_blueprint' }, 400);
    if (!db.transaction) return c.json({ error: 'private_blueprints_unavailable' }, 503);
    const { projectId, snapshotId, expectedRevision } = selection.data;
    return db.transaction(async tx => {
      const user = (await tx.query('SELECT plan, plan_expires_at FROM users WHERE id=$1 FOR UPDATE', [owner])).rows[0];
      if (!user) return c.json({ error: 'unauthenticated' }, 401);
      if (effectivePlan(user) !== 'pro') return c.json({ error: 'private_blueprint_pro_required' }, 403);
      // Retrying the same approved version returns the already saved template.
      const existing = (await tx.query(`SELECT id, title, file_count AS "fileCount" FROM private_blueprints
        WHERE owner_id=$1 AND source_project_id=$2 AND source_snapshot_id=$3`, [owner, projectId, snapshotId])).rows[0];
      if (existing) return c.json(existing, 200);
      const project = (await tx.query(`SELECT revision, workspace FROM builder_projects
        WHERE owner_id=$1 AND project_id=$2 AND deleted_at IS NULL`, [owner, projectId])).rows[0];
      if (!project) return c.json({ error: 'project_not_found' }, 404);
      if (project.revision !== expectedRevision) return c.json({ error: 'project_conflict' }, 409);
      const workspace = WorkspaceSchema.parse(project.workspace);
      const snapshot = workspace.snapshots.find(item => item.id === snapshotId);
      if (!snapshot?.sourceFiles) return c.json({ error: 'private_blueprint_sources_required' }, 409);
      const files = Files.parse(JSON.parse(snapshot.sourceFiles));
      if (!files.some(file => file.name === 'src/main.tsx') ||
          validateFiles(files.map(({ name, content }) => ({ path: name, content }))).length)
        return c.json({ error: 'private_blueprint_sources_unsupported' }, 400);
      const serialized = JSON.stringify(files);
      if (Buffer.byteLength(serialized) > maxSourceBytes) return c.json({ error: 'private_blueprint_too_large' }, 413);
      const usage = (await tx.query('SELECT COUNT(*) AS count FROM private_blueprints WHERE owner_id=$1', [owner])).rows[0];
      if (Number(usage.count) >= limit) return c.json({ error: 'private_blueprint_limit' }, 413);
      const id = randomUUID(), title = workspace.title;
      await tx.query(`INSERT INTO private_blueprints
        (owner_id, id, title, source_project_id, source_snapshot_id, files, file_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [owner, id, title, projectId, snapshotId, serialized, files.length]);
      return c.json({ id, title, fileCount: files.length }, 201);
    });
  });
  router.post(root + '/:id/delete', async c => {
    const owner = getUserFromContext(c)!.id;
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'private_blueprint_not_found' }, 404);
    if (!emptyBody.safeParse(await c.req.json().catch(() => null)).success)
      return c.json({ error: 'invalid_private_blueprint' }, 400);
    await db.query('DELETE FROM private_blueprints WHERE owner_id=$1 AND id=$2', [owner, id.data]);
    return c.json({ deleted: true });
  });
  return router;
}
