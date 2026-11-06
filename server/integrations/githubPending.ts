import { createHash, randomBytes } from 'node:crypto';
import type { DbLike } from '../db/pool';

const opaque = /^[a-f0-9]{64}$/;
const owner = /^[A-Za-z0-9_-]{1,128}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Internal primitive, not an HTTP endpoint. Caller must verify Cloud identity
 * and get the browser nonce from a trusted same-origin BFF, never a browser field.
 * The server generates state, DB time controls its 10-minute lifetime.
 * One row per owner bounds storage and a new start invalidates their older flow.
 */
export function githubPending(db: DbLike) {
  async function claim(ownerId: string, state: string, browserNonce: string) {
    if (!owner.test(ownerId) || !opaque.test(state) || !opaque.test(browserNonce)) return null;
    const result = await db.query(`UPDATE github_pending SET consumed = true
      WHERE owner_id = $1 AND state_hash = $2 AND nonce_hash = $3 AND expires_at > now() AND consumed = false
      RETURNING verifier_cipher`, [ownerId, digest(state), digest(browserNonce)]);
    return result.rows[0] as { verifier_cipher: string | null } | undefined ?? null;
  }
  return {
    async start(ownerId: string, browserNonce: string, verifierCipher: string | null = null): Promise<string> {
      if (!owner.test(ownerId) || !opaque.test(browserNonce)) throw new Error('invalid_github_pending_input');
      const state = randomBytes(32).toString('hex');
      await db.query(`INSERT INTO github_pending (owner_id, state_hash, nonce_hash, expires_at, verifier_cipher)
        VALUES ($1, $2, $3, now() + interval '10 minutes', $4)
        ON CONFLICT (owner_id) DO UPDATE SET state_hash = EXCLUDED.state_hash,
        nonce_hash = EXCLUDED.nonce_hash, expires_at = EXCLUDED.expires_at,
        verifier_cipher = EXCLUDED.verifier_cipher, consumed = false`,
      [ownerId, digest(state), digest(browserNonce), verifierCipher]);
      return state;
    },
    async consume(ownerId: string, state: string, browserNonce: string): Promise<boolean> {
      return (await claim(ownerId, state, browserNonce)) !== null;
    },
    claim,
    async publish(ownerId: string, state: string, cipher: string, expiresAt: Date): Promise<boolean> {
      const result = await db.query(`UPDATE github_pending SET connection_cipher = $3,
        connection_expires_at = $4, verifier_cipher = NULL
        WHERE owner_id = $1 AND state_hash = $2 AND consumed = true AND expires_at > now()
        RETURNING owner_id`, [ownerId, digest(state), cipher, expiresAt]);
      return result.rows.length === 1;
    },
    async connection(ownerId: string): Promise<string | null> {
      const result = await db.query('SELECT connection_cipher FROM github_pending WHERE owner_id = $1 AND connection_expires_at > now()', [ownerId]);
      return result.rows[0]?.connection_cipher ?? null;
    },
    async disconnect(ownerId: string): Promise<void> {
      await db.query('DELETE FROM github_pending WHERE owner_id = $1', [ownerId]);
    },
  };
}
