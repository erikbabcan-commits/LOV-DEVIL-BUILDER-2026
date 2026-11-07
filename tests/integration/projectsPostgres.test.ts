// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { projectContract } from '../helpers/projectContract';
import { dbFromPool } from '../../server/db/pool';
import { listMigrations, prepareAuthSchema, readSchemaFingerprint } from '../../server/db/migrate';
import { providerResilienceContract } from '../helpers/providerResilienceContract';
import { aiCostContract } from '../helpers/aiCostContract';
import { aiUsageContract } from '../helpers/aiUsageContract';
import { generationQuotaContract } from '../helpers/generationQuotaContract';
import { projectStorageContract } from '../helpers/projectStorageContract';

const enabled=process.env.PROJECTS_PG_E2E==='1';
describe.skipIf(!enabled)('dedicated PostgreSQL project storage',()=>{
  const connect=async()=>{
    const connectionString=process.env.PROJECTS_TEST_DATABASE_URL;
    if(!connectionString || !['127.0.0.1','localhost'].includes(new URL(connectionString).hostname))
      throw new Error('Use a dedicated loopback test database only');
    const schema='lov_test_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString,max:1,connectionTimeoutMillis:5000});
    await admin.query('CREATE SCHEMA '+schema);
    const pool=new Pool({connectionString,options:'-c search_path='+schema+' -c default_transaction_isolation=repeatable\\ read',max:4,connectionTimeoutMillis:5000,statement_timeout:5000});
    return {db:dbFromPool(pool),close:async()=>{
      await pool.end();try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}finally{await admin.end();}
    }};
  };
  it('verifies a pinned schema without replaying DDL and rejects structural drift', async () => {
    const { db, close } = await connect();
    try {
      await expect(readSchemaFingerprint(db)).rejects.toThrow('empty application schema');
      expect(await prepareAuthSchema(db)).toEqual(listMigrations().map(migration => migration.name));
      const fingerprint = await readSchemaFingerprint(db);
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

      await db.query("INSERT INTO users(id,email,password_hash) VALUES ('fixture','fixture@example.test','synthetic')");
      expect(await readSchemaFingerprint(db)).toBe(fingerprint);
      await db.transaction!(async tx => {
        await tx.query('LOCK TABLE github_exports IN ACCESS SHARE MODE');
        expect(await prepareAuthSchema(db, fingerprint)).toBeNull();
      });
      await expect(prepareAuthSchema(db, '')).rejects.toThrow('lowercase SHA-256');

      await db.query('ALTER TABLE github_exports ADD COLUMN structural_drift TEXT');
      await expect(prepareAuthSchema(db, fingerprint)).rejects.toThrow('fingerprint mismatch');
      expect(await readSchemaFingerprint(db)).not.toBe(fingerprint);
    } finally {
      await close();
    }
  }, 15000);
  projectContract('real PostgreSQL owner isolation, CAS, history and recovery',connect,true);
  projectStorageContract('real PostgreSQL storage quotas and pinned transaction races',connect,true);
  generationQuotaContract(connect);
  aiUsageContract(connect);
  aiCostContract(connect);
  providerResilienceContract(connect);
});
