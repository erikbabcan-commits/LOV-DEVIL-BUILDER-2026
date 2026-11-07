import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { dbFromPool } from '../server/db/pool';

const cursorSchema = z.tuple([
  z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  z.string().min(1).max(128).refine(value => !value.includes('\0')),
]);

/** Keep PostgreSQL's microsecond precision when resuming a queue page. */
function parseCursor(token: string | undefined) {
  if (token === undefined) return [null, null] as const;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw new Error('invalid_cursor');
  const text = Buffer.from(token, 'base64url').toString('utf8');
  if (Buffer.from(text).toString('base64url') !== token) throw new Error('invalid_cursor');
  return cursorSchema.parse(JSON.parse(text));
}

const queuePage = `SELECT r.user_id, r.request_id, r.requested_at, r.eligible_at,
      to_char(r.eligible_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS eligible_cursor,
      EXISTS (SELECT 1 FROM identity_links WHERE user_id = r.user_id) AS cloud_identity,
      EXISTS (SELECT 1 FROM billing_accounts WHERE user_id = r.user_id AND
        (has_open_subscription OR subscription_status IN ('active','trialing','past_due','unpaid','paused','incomplete'))) AS open_subscription,
      EXISTS (SELECT 1 FROM billing_checkout_attempts WHERE user_id = r.user_id AND state IN ('pending','ready')) AS pending_checkout,
      EXISTS (SELECT 1 FROM publish_jobs WHERE owner_id = r.user_id AND state = 'published' AND withdrawn_at IS NULL) AS published_artifacts,
      EXISTS (SELECT 1 FROM publish_jobs WHERE owner_id = r.user_id AND storage_phase IN ('retained','writing','legacy_unknown')) AS retained_artifacts,
      EXISTS (SELECT 1 FROM publish_jobs WHERE owner_id = r.user_id AND state = 'building') AS running_publish,
      EXISTS (SELECT 1 FROM github_pending WHERE owner_id = r.user_id AND connection_cipher IS NOT NULL) AS github_connection,
      EXISTS (SELECT 1 FROM github_exports WHERE owner_id = r.user_id AND status = 'running') AS running_github_export,
      EXISTS (SELECT 1 FROM ai_runs WHERE user_id = r.user_id AND status = 'running') AS running_ai
      FROM account_closure_requests r WHERE r.cancelled_at IS NULL AND r.eligible_at <= now()
        AND ($2::timestamptz IS NULL OR (r.eligible_at, r.user_id) > ($2::timestamptz, $3::text))
      ORDER BY r.eligible_at, r.user_id LIMIT $1`;

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: { limit: { type: 'string' }, cursor: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: account:closure-queue [--limit <1–500>] [--cursor <nextCursor>]\nReads eligible requests from DATABASE_URL. Performs no writes.');
  } else {
    const limit = values.limit ?? '100';
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 500)
      throw new Error('invalid_limit');
    const [after, afterOwner] = parseCursor(values.cursor);
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw new Error('database_unavailable');
    pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      application_name: 'lov-account-closure-queue',
      options: '-c default_transaction_read_only=on',
    });
    const { rows } = await dbFromPool(pool).transaction!(async db => {
      await db.query('SET TRANSACTION READ ONLY');
      return db.query(queuePage, [Number(limit) + 1, after, afterOwner]);
    });
    const page = rows.slice(0, Number(limit));
    const last = page.at(-1);
    const hasMore = rows.length > page.length;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify(cursorSchema.parse([last.eligible_cursor, last.user_id]))).toString('base64url')
      : null;
    console.log(JSON.stringify({
      ok: true, hasMore, nextCursor,
      requests: page.map(({ eligible_cursor: _cursor, ...request }) => request),
    }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, error: 'account_closure_queue_unavailable' }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
