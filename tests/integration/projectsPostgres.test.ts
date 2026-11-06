// @vitest-environment node
import { describe } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { projectContract } from '../helpers/projectContract';
import { dbFromPool } from '../../server/db/pool';
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
  projectContract('real PostgreSQL owner isolation, CAS, history and recovery',connect,true);
  projectStorageContract('real PostgreSQL storage quotas and pinned transaction races',connect,true);
  generationQuotaContract(connect);
  aiUsageContract(connect);
  aiCostContract(connect);
  providerResilienceContract(connect);
});
