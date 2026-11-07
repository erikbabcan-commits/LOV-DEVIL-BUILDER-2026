import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DbLike } from '../db/pool';
import { getUserFromContext } from './middleware';

const endpoint = '/api/account/closure';
const requestSchema = z.strictObject({ requestId: z.uuid(), confirmed: z.literal(true) });
const cancelSchema = z.strictObject({ requestId: z.uuid() });
const fields = 'request_id, requested_at, eligible_at';

interface PendingRequest {
  request_id: string;
  requested_at: Date;
  eligible_at: Date;
}

/** Read the one active request for the authenticated owner. */
async function pending(db: DbLike, owner: string): Promise<PendingRequest | undefined> {
  return (await db.query(
    `SELECT ${fields} FROM account_closure_requests WHERE user_id=$1 AND cancelled_at IS NULL`,
    [owner],
  )).rows[0];
}

/** Expose the active request without internal queue or provider state. */
function status(accountId: string, row: PendingRequest | undefined) {
  return row
    ? { accountId, state: 'pending', requestId: row.request_id, requestedAt: row.requested_at, eligibleAt: row.eligible_at }
    : { accountId, state: 'none' };
}

/** Owner-scoped request and cancellation routes mounted behind auth and CSRF. */
export function accountClosureRouter(db: DbLike, allow: (key: string) => boolean) {
  const router = new Hono();
  router.onError((_error, c) => c.json({ error: 'account_closure_unavailable' }, 503));
  const maxBody = bodyLimit({ maxSize: 512, onError: c => c.json({ error: 'account_closure_input_limit' }, 413) });
  for (const path of [endpoint, endpoint + '/cancel']) {
    router.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      const owner = getUserFromContext(c)?.id;
      if (!owner) return c.json({ error: 'unauthenticated' }, 401);
      if (new URL(c.req.url).search) return c.json({ error: 'invalid_closure_query' }, 400);
      if (!allow('account-closure:' + owner)) return c.json({ error: 'rate_limit' }, 429);
      if (c.req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? ''))
        return c.json({ error: 'json_required' }, 415);
      return next();
    });
    router.use(path, maxBody);
  }
  router.get(endpoint, async c => {
    const owner = getUserFromContext(c)!.id;
    return c.json(status(owner, await pending(db, owner)));
  });
  router.post(endpoint, async c => {
    const owner = getUserFromContext(c)!.id;
    const input = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'invalid_closure_confirmation' }, 400);
    if (!db.transaction) return c.json({ error: 'account_closure_unavailable' }, 503);
    const { requestId } = input.data;
    const result = await db.transaction(async tx => {
      // Both transitions serialize on the existing owner row. A retried
      // request cannot reopen a cancelled record or extend the grace period.
      if (!(await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner])).rows.length)
        return null;
      const current = await pending(tx, owner);
      if (current) return status(owner, current);
      const inserted = await tx.query(`INSERT INTO account_closure_requests (user_id, request_id, eligible_at)
        VALUES ($1, $2, now() + interval '720 hours')
        ON CONFLICT (user_id, request_id) DO NOTHING RETURNING ${fields}`, [owner, requestId]);
      return status(owner, inserted.rows[0]);
    });
    return result ? c.json(result) : c.json({ error: 'unauthenticated' }, 401);
  });
  router.post(endpoint + '/cancel', async c => {
    const owner = getUserFromContext(c)!.id;
    const input = cancelSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'invalid_closure_request' }, 400);
    if (!db.transaction) return c.json({ error: 'account_closure_unavailable' }, 503);
    const result = await db.transaction(async tx => {
      if (!(await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner])).rows.length)
        return null;
      await tx.query(`UPDATE account_closure_requests SET cancelled_at=GREATEST(requested_at, clock_timestamp())
        WHERE user_id=$1 AND request_id=$2 AND cancelled_at IS NULL`, [owner, input.data.requestId]);
      return status(owner, await pending(tx, owner));
    });
    return result ? c.json(result) : c.json({ error: 'unauthenticated' }, 401);
  });
  return router;
}
