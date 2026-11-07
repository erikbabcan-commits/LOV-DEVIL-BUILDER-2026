import type { DbLike } from '../db/pool';

const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;
const MAX_BATCH = 10_000;

export function authLogRetentionWindow(days: string, limit: string, now = new Date()) {
  if (!/^[1-9][0-9]{0,4}$/.test(days) || Number(days) > MAX_DAYS ||
      !/^[1-9][0-9]{0,4}$/.test(limit) || Number(limit) > MAX_BATCH)
    throw new Error('invalid_auth_log_retention_window');
  return { before: new Date(now.getTime() - Number(days) * DAY_MS), limit: Number(limit) };
}

export async function retainAuthLog(
  db: DbLike,
  { before, limit }: ReturnType<typeof authLogRetentionWindow>,
  apply: boolean,
) {
  const expired = 'SELECT id FROM auth_log WHERE created_at < $1 ORDER BY created_at, id LIMIT $2';
  const result = apply
    ? await db.query(`DELETE FROM auth_log WHERE id IN (${expired} FOR UPDATE SKIP LOCKED)`, [before, limit])
    : await db.query(expired, [before, limit]);
  const count = result.rowCount;
  if (count === null || !Number.isInteger(count) || count < 0 || count > limit)
    throw new Error('invalid_auth_log_retention_result');
  return { mode: apply ? 'apply' : 'dry-run', before: before.toISOString(), limit, count };
}
