import type { DbLike } from '../db/pool';
import { effectivePlan } from './plans';

/** Effective plan of a user from the DB row (never from a token claim). Missing row = free.
 *  Used by the durable worker (router clamp, GBBB-3 premium model block). */
export function planLookup(db: DbLike): (ownerId: string) => Promise<'free' | 'pro'> {
  return async ownerId => {
    const row = (await db.query('SELECT plan, plan_expires_at FROM users WHERE id=$1', [ownerId])).rows[0] as { plan?: unknown; plan_expires_at?: unknown } | undefined;
    return row ? effectivePlan(row) : 'free';
  };
}
