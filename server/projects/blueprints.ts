import { Hono } from 'hono';
import { BLUEPRINT_REGISTRY, getBlueprint } from '../../src/templates/registry';
import type { ServerWorkspace } from '../../shared/projectSchema';
import { getUserFromContext } from '../auth/middleware';
import type { DbLike } from '../db/pool';

const catalog = BLUEPRINT_REGISTRY.map(({ id, title, description, category, files }) => ({
  id, title, description, category, fileCount: files.length,
}));

/** Serve only first-party starter metadata and sources to linked users. */
export function blueprintRouter(allow: (key: string) => boolean) {
  const router = new Hono();
  router.on('GET', ['/api/blueprints', '/api/blueprints/:id'], (c) => {
    c.header('Cache-Control', 'no-store');
    const user = getUserFromContext(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_query' }, 400);
    if (!allow('blueprints:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    const id = c.req.param('id');
    if (!id) return c.json({ blueprints: catalog });
    const blueprint = getBlueprint(id);
    if (!blueprint) return c.json({ error: 'blueprint_not_found' }, 404);
    return c.json({
      id, title: blueprint.title,
      files: blueprint.files.map(({ path, content }) => ({ name: path, content })),
    });
  });
  return router;
}

export function blueprintOrigin(workspace: ServerWorkspace) {
  const first = workspace.snapshots[0];
  if (!first) return null;
  const marker = first.kind.match(/^blueprint:([a-z0-9-]{1,40})$/);
  if (!marker || first.v !== 1 || first.parentId || !first.sourceFiles) return null;
  return { blueprintId: marker[1]!, snapshotId: first.id, sourceFiles: first.sourceFiles };
}

/** A client marker alone cannot count as a starter use; the first snapshot must match the catalog. */
export function initialBlueprint(workspace: ServerWorkspace) {
  const origin = blueprintOrigin(workspace);
  if (!origin) return null;
  const blueprint = getBlueprint(origin.blueprintId);
  if (!blueprint) return null;
  // SaveSchema has already validated the source snapshot's JSON and unique paths.
  const files = JSON.parse(origin.sourceFiles) as ServerWorkspace['files'];
  const contents = new Map(files.map(({ name, content }) => [name, content]));
  return contents.size === blueprint.files.length &&
    blueprint.files.every(({ path, content }) => contents.get(path) === content)
    ? { blueprintId: blueprint.id, snapshotId: origin.snapshotId }
    : null;
}

export async function blueprintConversion(db: DbLike, owner: string, start: Date, end: Date) {
  const { rows } = await db.query(`SELECT blueprint_id, COUNT(*) AS started,
      COUNT(CASE WHEN first_published_at < $3 THEN 1 END) AS published
    FROM blueprint_uses WHERE owner_id=$1 AND recorded_at >= $2 AND recorded_at < $3
    GROUP BY blueprint_id ORDER BY blueprint_id`, [owner, start, end]);
  return rows.map(row => {
    const id = row.blueprint_id, started = Number(row.started), published = Number(row.published);
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id) ||
        !Number.isSafeInteger(started) || started < 1 ||
        !Number.isSafeInteger(published) || published < 0 || published > started)
      throw new Error('invalid_blueprint_conversion');
    return { id, title: getBlueprint(id)?.title ?? id, started, published };
  });
}
