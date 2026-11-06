import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getUserFromContext } from '../auth/middleware';
import { cloudBearer, CLOUD_AUTH_HEADER } from '../auth/cloud';
import type { githubCloud } from '../integrations/githubCloud';
import type { githubExporter } from '../integrations/githubExporter';
import { PrepareGitHubExport, ConfirmGitHubExport, CancelGitHubExport, ReadGitHubExport } from '../../shared/githubExportProtocol';

export const GITHUB_BRIDGE_HEADER = 'X-LOV-GitHub-Bridge';
export function isCloudGitHubRoute(method: string, path: string): boolean {
  return method === 'GET' ? path === '/api/cloud-github/status' : method === 'POST' &&
    ['/api/cloud-github/start', '/api/cloud-github/finish', '/api/cloud-github/disconnect', ...['prepare', 'confirm', 'status', 'review', 'cancel', 'reconcile'].map(action => '/api/cloud-github/export/' + action)].includes(path);
}
export interface CloudGitHubWiring { service: ReturnType<typeof githubCloud>; bridgeSecret: string; exporter?: ReturnType<typeof githubExporter> }
const nonce = z.string().regex(/^[a-f0-9]{64}$/);
const startSchema = z.object({ browserNonce: nonce }).strict();
const finishSchema = z.object({ browserNonce: nonce, state: nonce, code: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/) }).strict();

/** Mounted behind verified Cloud auth only. The extra key authenticates the
 * trusted BFF that reads/writes the browser nonce cookie; never expose it in UI.
 * No arbitrary owner ID, callback URL, scope or OAuth credentials in requests.
 */
export function githubCloudRouter(wiring: CloudGitHubWiring, allow: (key: string) => boolean) {
  if (!/^[a-f0-9]{64}$/i.test(wiring.bridgeSecret)) throw new Error('invalid_github_bridge_configuration');
  const router = new Hono();
  router.onError((_error, c) => c.json({ error: 'github_connection_unavailable' }, 503));
  router.use('/api/cloud-github/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const user = getUserFromContext(c);
    if (!user || !cloudBearer(c.req.header('Authorization'), c.req.header(CLOUD_AUTH_HEADER)).present)
      return c.json({ error: 'cloud_identity_required' }, 403);
    const supplied = Buffer.from(c.req.header(GITHUB_BRIDGE_HEADER) ?? '');
    const expected = Buffer.from(wiring.bridgeSecret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.json({ error: 'github_bridge_required' }, 403);
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_github_query' }, 400);
    if (!isCloudGitHubRoute(c.req.method, c.req.path)) return c.json({ error: 'github_route_unavailable' }, 404);
    if (!allow('cloud-github:' + user.id)) return c.json({ error: 'rate_limit' }, 429);
    if (c.req.method === 'POST' && c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      return c.json({ error: 'json_required' }, 415);
    return next();
  });
  router.use('/api/cloud-github/*', bodyLimit({ maxSize: 2048, onError: c => c.json({ error: 'github_request_too_large' }, 413) }));
  router.get('/api/cloud-github/status', async c => c.json(await wiring.service.status(getUserFromContext(c)!.id)));
  router.post('/api/cloud-github/start', async c => {
    const body = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_github_request' }, 400);
    return c.json(await wiring.service.start(getUserFromContext(c)!.id, body.data.browserNonce));
  });
  router.post('/api/cloud-github/finish', async c => {
    const body = finishSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_github_request' }, 400);
    const { state, code, browserNonce } = body.data;
    const result = await wiring.service.finish(getUserFromContext(c)!.id, state, browserNonce, code, c.req.raw.signal);
    return c.json(result, result.ok ? 200 : result.error === 'github_unavailable' ? 502 : result.error === 'github_permission_missing' ? 403 : 409);
  });
  router.post('/api/cloud-github/disconnect', async c => {
    const body = z.object({}).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_github_request' }, 400);
    await wiring.service.disconnect(getUserFromContext(c)!.id);
    return c.json({ ok: true });
  });
  for (const action of ['prepare', 'confirm', 'status', 'review', 'cancel', 'reconcile'] as const) router.post('/api/cloud-github/export/' + action, async c => {
    if (!wiring.exporter) return c.json({ error: 'github_export_not_configured' }, 503);
    const input = await c.req.json().catch(() => null);
    const schema = action === 'prepare' ? PrepareGitHubExport : action === 'confirm' ? ConfirmGitHubExport : action === 'cancel' ? CancelGitHubExport : ReadGitHubExport;
    if (!schema.safeParse(input).success) return c.json({ error: 'invalid_export_request' }, 400);
    const owner = getUserFromContext(c)!.id;
    const result = action === 'prepare' ? await wiring.exporter.prepare(owner, input) : action === 'confirm'
      ? await wiring.exporter.confirm(owner, input, c.req.raw.signal) : action === 'cancel' ? await wiring.exporter.cancel(owner, input)
      : action === 'reconcile' ? await wiring.exporter.reconcile(owner, ReadGitHubExport.parse(input).requestId, c.req.raw.signal)
      : await wiring.exporter[action](owner, ReadGitHubExport.parse(input).requestId);
    if ('error' in result) return c.json(result, result.error.endsWith('not_found') ? 404 : result.error === 'invalid_export_request' || result.error === 'public_confirmation_required' ? 400 : 409);
    return c.json(result);
  });
  return router;
}
