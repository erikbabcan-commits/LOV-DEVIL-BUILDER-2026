import type { DbLike } from '../db/pool';
import { validateCloudIssuer } from './cloud';

export type IdentityLinkResult = 'would_link' | 'created' | 'unchanged' | 'conflict' | 'user_not_found';

/** Operator-only helper, never mounted as an HTTP endpoint. The operator must
 * verify both account owners before passing IDs. No email matching or rebinding. */
export async function linkCloudIdentity(
  db: DbLike,
  input: { issuer: string; subject: string; userId: string },
  apply = false,
): Promise<IdentityLinkResult> {
  validateCloudIssuer(input.issuer);
  if (![input.subject, input.userId].every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('invalid_identity_id');
  const user = await db.query('SELECT id FROM users WHERE id = $1', [input.userId]);
  if (!user.rows.length) return 'user_not_found';
  const links = await db.query('SELECT subject, user_id FROM identity_links WHERE issuer = $1 AND (subject = $2 OR user_id = $3)', [input.issuer, input.subject, input.userId]);
  if (links.rows.some(row => row.subject !== input.subject || row.user_id !== input.userId)) return 'conflict';
  if (links.rows.length) return 'unchanged';
  if (!apply) return 'would_link';
  const created = await db.query(`INSERT INTO identity_links (issuer, subject, user_id)
    SELECT $1, $2, id FROM users WHERE id = $3 ON CONFLICT DO NOTHING RETURNING user_id`, [input.issuer, input.subject, input.userId]);
  if (created.rows.length) return 'created';
  // A competing operator can only win once; never update the winning binding.
  const current = await db.query('SELECT user_id FROM identity_links WHERE issuer = $1 AND subject = $2', [input.issuer, input.subject]);
  return current.rows[0]?.user_id === input.userId ? 'unchanged' : 'conflict';
}
