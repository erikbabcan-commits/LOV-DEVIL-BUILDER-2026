import { parseArgs } from 'node:util';
import { Pool } from 'pg';

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: { limit: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: account:closure-queue [--limit <1–500>]\nReads eligible requests from DATABASE_URL. Performs no writes.');
  } else {
    const limit = values.limit ?? '100';
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 500)
      throw new Error('invalid_limit');
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
    const { rows } = await pool.query(`SELECT r.user_id, r.request_id, r.requested_at, r.eligible_at,
      EXISTS (SELECT 1 FROM identity_links WHERE user_id = r.user_id) AS cloud_identity,
      EXISTS (SELECT 1 FROM billing_accounts WHERE user_id = r.user_id AND
        (has_open_subscription OR subscription_status IN ('active','trialing','past_due','unpaid','paused','incomplete'))) AS open_subscription,
      EXISTS (SELECT 1 FROM publish_jobs WHERE owner_id = r.user_id AND state = 'published') AS published_artifacts,
      EXISTS (SELECT 1 FROM publish_jobs WHERE owner_id = r.user_id AND state = 'building') AS running_publish,
      EXISTS (SELECT 1 FROM github_pending WHERE owner_id = r.user_id AND connection_cipher IS NOT NULL) AS github_connection,
      EXISTS (SELECT 1 FROM github_exports WHERE owner_id = r.user_id AND status = 'running') AS running_github_export,
      EXISTS (SELECT 1 FROM ai_runs WHERE user_id = r.user_id AND status = 'running') AS running_ai
      FROM account_closure_requests r WHERE r.cancelled_at IS NULL AND r.eligible_at <= now()
      ORDER BY r.eligible_at, r.user_id LIMIT $1`, [Number(limit) + 1]);
    console.log(JSON.stringify({ ok: true, hasMore: rows.length > Number(limit), requests: rows.slice(0, Number(limit)) }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, error: 'account_closure_queue_unavailable' }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
