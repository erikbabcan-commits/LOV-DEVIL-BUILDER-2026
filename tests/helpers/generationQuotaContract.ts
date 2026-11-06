import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbLike } from '../../server/db/pool';
import { applyMigrations } from '../../server/db/migrate';
import { PostgresQuotaStore } from '../../server/security/quotaStore';

/** Real PostgreSQL is authoritative for atomic conditional UPDATE and month races. */
export function generationQuotaContract(connect: () => Promise<{ db: DbLike; close: () => Promise<void> }>) {
  describe('durable AI admission counters', () => {
    let db: DbLike, close: () => Promise<void>;
    const november = () => new Date('2026-11-15T12:00:00Z');
    const december = () => new Date('2026-12-01T00:00:00Z');
    const used = async () => Number((await db.query('SELECT generations FROM user_quotas WHERE user_id=$1', ['quota-user'])).rows[0]?.generations ?? 0);
    beforeEach(async () => {
      ({ db, close } = await connect()); await applyMigrations(db);
      await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', ['quota-user','quota@example.test','unused']);
    });
    afterEach(async () => { await close?.(); });
    it('keeps denied attempts out of stored usage, including after reopening and upgrading the plan', async () => {
      const quota = new PostgresQuotaStore(db, november);
      for (let i=0;i<10;i++) expect((await quota.consume('quota-user')).ok).toBe(true);
      const reopened = new PostgresQuotaStore(db, november);
      for (let i=0;i<8;i++) expect((await reopened.consume('quota-user')).ok).toBe(false);
      expect(await used()).toBe(10);
      await db.query("UPDATE users SET plan='pro' WHERE id=$1", ['quota-user']);
      expect(await reopened.consume('quota-user')).toMatchObject({ ok:true, snapshot:{ used:11, limit:200, remaining:189 } });
      expect(await used()).toBe(11);
    });
    it('rolls a month forwards and refuses a delayed previous-month request without resetting newer usage', async () => {
      const old = new PostgresQuotaStore(db, november); await old.consume('quota-user');
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter=resolve; }), gate = new Promise<void>(resolve => { release=resolve; });
      const delayed:DbLike={ query:db.query, transaction:async work=>{ enter(); await gate; return db.transaction!(work); } };
      const pending = new PostgresQuotaStore(delayed, november).consume('quota-user');
      // Attach rejection before releasing the old request.
      const rejected = expect(pending).rejects.toThrow('quota_period_unavailable');
      await entered;
      expect(await new PostgresQuotaStore(db, december).consume('quota-user')).toMatchObject({ ok:true, snapshot:{ used:1 } });
      release(); await rejected;
      expect(await new PostgresQuotaStore(db, december).usage('quota-user')).toMatchObject({ used:1, remaining:9 });
    });
    it('admits exactly ten of 64 concurrent requests across independent store objects', async () => {
      const results = await Promise.all(Array.from({length:64},()=>new PostgresQuotaStore(db,november).consume('quota-user')));
      expect(results.filter(result=>result.ok)).toHaveLength(10);
      expect(results.filter(result=>!result.ok)).toHaveLength(54);
      expect(await used()).toBe(10);
    });
    it('fails for an unknown owner without creating an orphan counter', async () => {
      await expect(new PostgresQuotaStore(db,november).consume('missing')).rejects.toThrow('quota_owner_unavailable');
      expect((await db.query('SELECT user_id FROM user_quotas')).rows).toEqual([]);
    });
    it('refuses an adapter without pinned transactions before changing usage', async () => {
      await expect(new PostgresQuotaStore({query:db.query},november).consume('quota-user')).rejects.toThrow('quota_transaction_unavailable');
      expect((await db.query('SELECT user_id FROM user_quotas')).rows).toEqual([]);
    });
    it('rolls back a counter mutation if transaction work fails, then permits a clean retry', async () => {
      const broken:DbLike={query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
        const result=await tx.query(sql,params);if(sql.startsWith('UPDATE user_quotas SET'))throw new Error('synthetic-db-failure');return result;
      }}))};
      await expect(new PostgresQuotaStore(broken,november).consume('quota-user')).rejects.toThrow('synthetic-db-failure');
      expect((await db.query('SELECT user_id FROM user_quotas')).rows).toEqual([]);
      expect(await new PostgresQuotaStore(db,november).consume('quota-user')).toMatchObject({ok:true,snapshot:{used:1}});
    });
    it('does not invent refunds for older inflated counters after a deployment', async () => {
      await db.query('INSERT INTO user_quotas(user_id,period_start,generations) VALUES($1,$2,20)', ['quota-user','2026-11-01']);
      const quota = new PostgresQuotaStore(db,november);
      expect(await quota.consume('quota-user')).toMatchObject({ok:false,snapshot:{used:20,remaining:0}});
      expect(await used()).toBe(20);
      await db.query("UPDATE users SET plan='pro' WHERE id=$1",['quota-user']);
      expect(await quota.consume('quota-user')).toMatchObject({ok:true,snapshot:{used:21}});
    });
  });
}
