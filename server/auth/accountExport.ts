import { Hono } from 'hono';
import type { DbLike } from '../db/pool';
import { getUserFromContext } from './middleware';

// Only these projections leave Hono. Credential tables and internal result
// payloads are intentionally absent. Workspace and publish source belong to the owner.
const pages = {
  projects: {
    table: 'builder_projects', owner: 'owner_id', key: 'project_id', type: 'text', limit: 1,
    fields: 'project_id, title, revision, workspace, updated_at, deleted_at',
  },
  auth: {
    table: 'auth_log', owner: 'user_id', key: 'id', type: 'text', limit: 100,
    fields: 'id, action, created_at',
  },
  ai: {
    table: 'ai_runs', owner: 'user_id', key: 'id', type: 'uuid', limit: 25,
    fields: `id, kind, period_start, plan, status, started_at, finished_at, call_count,
      (SELECT COALESCE(json_agg(row_to_json(call) ORDER BY call.call_no), '[]'::json)
       FROM (SELECT call_no, provider, requested_model, actual_model, status, started_at,
                    finished_at, prompt_tokens, completion_tokens FROM ai_calls
             WHERE user_id = ai_runs.user_id AND run_id = ai_runs.id) AS call) AS calls`,
  },
  publish: {
    table: 'publish_jobs', owner: 'owner_id', key: 'request_id', type: 'uuid', limit: 1,
    fields: `request_id, project_id, project_revision, snapshot_id, source_files, artifact_id,
             artifact_bytes, state, error_code, created_at, updated_at, withdrawn_at`,
  },
  github: {
    table: 'github_exports', owner: 'owner_id', key: 'request_id', type: 'text', limit: 100,
    fields: 'request_id, repo_name, github_username, selection, status, created_at, reconciled_at',
  },
  billing: {
    table: 'billing_events', owner: 'user_id', key: 'event_id', type: 'text', limit: 100,
    fields: 'event_id, event_type, processed_at, positive_pro_invoice_paid_at',
  },
  closure: {
    table: 'account_closure_requests', owner: 'user_id', key: 'request_id', type: 'uuid', limit: 100,
    fields: 'request_id, requested_at, eligible_at, cancelled_at',
  },
} as const;

type Page = keyof typeof pages;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function readCursor(token: string | undefined) {
  if (!token) return null;
  if (!cursorPattern.test(token)) return undefined;
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  if (!decoded || decoded.includes('\0') || Buffer.from(decoded).toString('base64url') !== token) return undefined;
  return decoded;
}

async function profile(db: DbLike, owner: string) {
  const result = await db.query(`SELECT id, email, plan, plan_expires_at, created_at, first_observed_app_save_at,
    (SELECT COALESCE(json_agg(row_to_json(link) ORDER BY link.issuer), '[]'::json)
     FROM (SELECT issuer, subject, created_at FROM identity_links WHERE user_id = $1) AS link) AS identities,
    (SELECT row_to_json(quota) FROM (SELECT period_start, generations FROM user_quotas WHERE user_id = $1) AS quota) AS quota,
    (SELECT row_to_json(subscription)
     FROM (SELECT customer_id, subscription_id, subscription_status, subscription_interval,
                  period_end, cancel_at_period_end, trial_attempted FROM billing_accounts WHERE user_id = $1) AS subscription) AS billing
    FROM users WHERE id = $1`, [owner]);
  return result.rows;
}

export function accountExportRouter(db: DbLike, allow: (key: string) => boolean) {
  const router = new Hono();
  router.get('/api/account/export/:section/:cursor?', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const owner = getUserFromContext(c)?.id;
    if (!owner) return c.json({ error: 'unauthenticated' }, 401);
    const section = c.req.param('section');
    const token = c.req.param('cursor');
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_export_query' }, 400);
    if (section !== 'profile' && !Object.hasOwn(pages, section)) return c.json({ error: 'export_section_not_found' }, 404);
    const page = section === 'profile' ? null : pages[section as Page];
    const after = readCursor(token);
    if (after === undefined || (!page && token) || (after && page?.type === 'uuid' && !uuidPattern.test(after)))
      return c.json({ error: 'invalid_export_cursor' }, 400);
    if (!allow('account-export:' + owner)) {
      c.header('Retry-After', '60');
      return c.json({ error: 'rate_limit' }, 429);
    }
    try {
      // The extra row contains only its key. Project/source payloads can be large.
      const rows = page
        ? (await db.query(`SELECT ${page.fields},
            EXISTS (SELECT 1 FROM ${page.table} AS later
                    WHERE later.${page.owner} = $1 AND later.${page.key} > ${page.table}.${page.key}) AS has_more
            FROM ${page.table} WHERE ${page.owner} = $1 AND ($2::${page.type} IS NULL OR ${page.key} > $2)
            ORDER BY ${page.key} LIMIT $3`, [owner, after, page.limit])).rows
        : await profile(db, owner);
      if (!page && !rows.length) return c.json({ error: 'unauthenticated' }, 401);
      const last = rows.at(-1);
      const nextCursor = page && last?.has_more ? Buffer.from(String(last[page.key])).toString('base64url') : null;
      if (nextCursor !== null && !cursorPattern.test(nextCursor)) throw new Error('invalid_export_key');
      const body = JSON.stringify({
        version: 1, accountId: owner, section, nextCursor,
        records: rows.map(({ has_more: _hasMore, ...record }) => record),
      });
      if (Buffer.byteLength(body) > 12 * 1024 * 1024) return c.json({ error: 'export_page_too_large' }, 413);
      return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch {
      return c.json({ error: 'account_export_unavailable' }, 503);
    }
  });
  return router;
}
