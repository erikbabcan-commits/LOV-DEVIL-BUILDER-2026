import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../../server/db/migrate';
import type { DbLike } from '../../server/db/pool';
import { PostgresQuotaStore } from '../../server/security/quotaStore';
import { PostgresAiUsageStore, type RunInput } from '../../server/usage/store';

export function aiUsageContract(connect: () => Promise<{ db: DbLike; close: () => Promise<void> }>) {
  describe('durable provider-call usage ledger', () => {
    let db: DbLike, close: () => Promise<void>, store: PostgresAiUsageStore, quota: PostgresQuotaStore;
    const november = () => new Date('2026-11-15T12:00:00Z');
    const run = (userId = 'alice'): RunInput => ({ userId, id: randomUUID(), kind: 'generation' });
    beforeEach(async () => {
      ({ db, close } = await connect()); await applyMigrations(db); await applyMigrations(db);
      for (const id of ['alice','bob']) await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[id,id+'@example.test','unused']);
      store = new PostgresAiUsageStore(db, november); quota = new PostgresQuotaStore(db, november);
    });
    afterEach(async () => { await close?.(); });
    it('atomically rolls quota back when a run cannot be recorded and denies missing transaction capability', async () => {
      const first = run(); await store.admit(first, quota);
      await expect(store.admit(first, quota)).rejects.toThrow();
      expect(await quota.usage('alice')).toMatchObject({used:1});
      const broken: DbLike = { query: db.query, transaction: work => db.transaction!(tx => work({query: async (sql,params) => {
        if (sql.includes('INSERT INTO ai_runs')) throw new Error('synthetic-ledger-failure');
        return tx.query(sql,params);
      }})) };
      await expect(new PostgresAiUsageStore(broken,november).admit(run('bob'),new PostgresQuotaStore(broken,november))).rejects.toThrow();
      expect(await quota.usage('bob')).toMatchObject({used:0});
      await expect(new PostgresAiUsageStore({query:db.query},november).admit(run(),quota)).rejects.toThrow();
    });
    it('admits exactly ten parallel tasks and records exactly ten runs', async () => {
      const results = await Promise.all(Array.from({length:32},() => store.admit(run(),quota)));
      expect(results.filter(r=>r.ok)).toHaveLength(10);
      expect(Number((await db.query('SELECT COUNT(*) AS n FROM ai_runs')).rows[0].n)).toBe(10);
    });
    it('serializes 140 call reservations across stores with a hard 128 bound', async () => {
      const item = run(); await store.admit(item,quota);
      const reservations = await Promise.allSettled(Array.from({length:140},()=>new PostgresAiUsageStore(db,november).startCall(item,'mistral','alias')));
      expect(reservations.filter(r=>r.status==='fulfilled')).toHaveLength(128);
      expect(new Set(reservations.filter(r=>r.status==='fulfilled').map(r=>r.value)).size).toBe(128);
      expect(await store.report('alice')).toMatchObject({calls:128,unknownCalls:128,pendingCalls:128,promptTokens:0});
    });
    it('retains reported, failed and interrupted usage after reopening, excluding calls known not sent', async () => {
      const item = run(); await store.admit(item,quota);
      const calls = await Promise.all(Array.from({length:4},()=>store.startCall(item,'mistral','alias')));
      await store.finishCall(item,calls[0],{status:'completed',actualModel:'model-2026',usage:{promptTokens:120,completionTokens:30}});
      await store.finishCall(item,calls[1],{status:'failed',actualModel:null,usage:null});
      await store.finishCall(item,calls[2],{status:'not_sent',actualModel:null,usage:null});
      await expect(store.finishRun(item,'succeeded')).rejects.toThrow();
      await store.finishRun(item,'incomplete');
      const reopened = new PostgresAiUsageStore(db,november);
      expect(await reopened.report('alice')).toMatchObject({calls:3,reportedCalls:1,unknownCalls:2,pendingCalls:1,promptTokens:120,completionTokens:30});
      await expect(reopened.startCall(item,'mistral','alias')).rejects.toThrow();
      await expect(reopened.finishCall(item,calls[0],{status:'completed',actualModel:'model',usage:{promptTokens:1,completionTokens:1}})).rejects.toThrow();
    });
    it('keeps owners and UTC call months separate and cascades account deletion', async () => {
      const item = run(); await store.admit(item,quota);
      const lastMonth = new PostgresAiUsageStore(db,()=>new Date('2026-10-31T23:59:59Z'));
      const before = await lastMonth.startCall(item,'mistral','alias');
      await lastMonth.finishCall(item,before,{status:'completed',actualModel:'model',usage:{promptTokens:7,completionTokens:3}});
      await store.startCall(item,'mistral','alias');
      expect(await store.report('alice')).toMatchObject({calls:1,reportedCalls:0,unknownCalls:1});
      expect(await lastMonth.report('alice')).toMatchObject({calls:1,promptTokens:7});
      expect(await store.report('bob')).toMatchObject({calls:0,promptTokens:0});
      await expect(store.startCall({...item,userId:'bob'},'mistral','alias')).rejects.toThrow();
      await db.query('DELETE FROM users WHERE id=$1',['alice']);
      expect((await db.query('SELECT * FROM ai_calls')).rows).toEqual([]);
      expect((await db.query('SELECT * FROM ai_runs')).rows).toEqual([]);
    });
    it('rolls back a partial call reservation and refuses another quota database', async () => {
      const item = run(); await store.admit(item,quota);
      const broken: DbLike = {query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
        if(sql.includes('INSERT INTO ai_calls'))throw new Error('synthetic-insert-failure');return tx.query(sql,params);
      }}))};
      await expect(new PostgresAiUsageStore(broken,november).startCall(item,'mistral','alias')).rejects.toThrow();
      expect((await db.query('SELECT call_count FROM ai_runs')).rows[0].call_count).toBe(0);
      expect(await store.startCall(item,'mistral','alias')).toBe(1);
      await expect(store.admit(run(),new PostgresQuotaStore({query:db.query,transaction:db.transaction},november))).rejects.toThrow();
    });
    it('cannot race a terminal run into a new provider call', async () => {
      const item = run(); await store.admit(item,quota);
      await store.finishRun(item,'cancelled');
      await expect(store.startCall(item,'mistral','alias')).rejects.toThrow();
      expect(await store.report('alice')).toMatchObject({calls:0});
    });
  });
}
