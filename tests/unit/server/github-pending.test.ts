// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../../../server/db/migrate';
import { githubPending } from '../../../server/integrations/githubPending';
import type { DbLike } from '../../../server/db/pool';

describe('durable GitHub OAuth pending state', () => {
  let db: DbLike;
  const nonce = 'ab'.repeat(32);
  beforeEach(async () => {
    const pool = new (newDb().adapters.createPg().Pool)();
    db = { query: async (sql, params) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } };
    await applyMigrations(db);
    for (const id of ['alice', 'bob']) await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, id + '@example.com', 'unused']);
  });
  it('persists only digests, survives helper recreation and permits one consume', async () => {
    const state = await githubPending(db).start('alice', nonce);
    const row = (await db.query('SELECT * FROM github_pending')).rows[0];
    expect(JSON.stringify(row)).not.toContain(state);
    expect(JSON.stringify(row)).not.toContain(nonce);
    expect(await githubPending(db).consume('alice', state, nonce)).toBe(true);
    expect(await githubPending(db).consume('alice', state, nonce)).toBe(false);
  });
  it('does not consume a valid flow for a wrong account, nonce or state', async () => {
    const pending = githubPending(db), state = await pending.start('alice', nonce);
    expect(await pending.consume('bob', state, nonce)).toBe(false);
    expect(await pending.consume('alice', state, 'cd'.repeat(32))).toBe(false);
    expect(await pending.consume('alice', 'ef'.repeat(32), nonce)).toBe(false);
    expect(await pending.consume('alice', state, nonce)).toBe(true);
  });
  it('replaces only the same owner’s flow and rejects expiry', async () => {
    const pending = githubPending(db), first = await pending.start('alice', nonce);
    const bob = await pending.start('bob', nonce);
    const latest = await pending.start('alice', nonce);
    expect((await db.query('SELECT owner_id FROM github_pending')).rows).toHaveLength(2);
    expect(await pending.consume('alice', first, nonce)).toBe(false);
    await db.query('UPDATE github_pending SET expires_at=$1 WHERE owner_id=$2', [new Date(0), 'alice']);
    expect(await pending.consume('alice', latest, nonce)).toBe(false);
    expect(await pending.consume('bob', bob, nonce)).toBe(true);
  });
  it('rejects malformed input and cascades on account deletion', async () => {
    const pending = githubPending(db);
    await expect(pending.start('alice', 'invalid')).rejects.toThrow('invalid_github_pending_input');
    expect(await pending.consume('alice', 'invalid', nonce)).toBe(false);
    const state = await pending.start('alice', nonce);
    await db.query('DELETE FROM users WHERE id=$1', ['alice']);
    expect(await pending.consume('alice', state, nonce)).toBe(false);
  });
});
