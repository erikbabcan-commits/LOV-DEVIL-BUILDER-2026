import { Hono } from 'hono';
import { BLUEPRINT_REGISTRY, getBlueprint } from '../../src/templates/registry';
import type { ServerWorkspace } from '../../shared/projectSchema';
import { getUserFromContext } from '../auth/middleware';

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

/** A client marker alone cannot count as a starter use; the first snapshot must match the catalog. */
export function initialBlueprint(workspace: ServerWorkspace) {
  const first = workspace.snapshots[0];
  if (!first) return null;
  const marker = first.kind.match(/^blueprint:([a-z0-9-]{1,40})$/);
  if (!marker || first.v !== 1 || first.parentId || !first.sourceFiles) return null;
  const blueprint = getBlueprint(marker[1]!);
  if (!blueprint) return null;
  // SaveSchema has already validated the source snapshot's JSON and unique paths.
  const files = JSON.parse(first.sourceFiles) as ServerWorkspace['files'];
  const contents = new Map(files.map(({ name, content }) => [name, content]));
  return contents.size === blueprint.files.length &&
    blueprint.files.every(({ path, content }) => contents.get(path) === content)
    ? { blueprintId: blueprint.id, snapshotId: first.id }
    : null;
}
