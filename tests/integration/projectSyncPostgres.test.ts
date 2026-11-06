// @vitest-environment jsdom
import { afterAll, beforeAll, describe } from 'vitest';
import { configure, getConfig } from '@testing-library/react';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { projectSyncContract } from '../helpers/projectSyncContract';
import { dbFromPool } from '../../server/db/pool';
describe.skipIf(process.env.PROJECTS_PG_E2E!=='1')('project UI with dedicated PostgreSQL',()=>{
 const previousWait=getConfig().asyncUtilTimeout;
 // Real SCRAM/database IO can exceed jsdom's 1 s default on a busy development machine.
 beforeAll(()=>configure({asyncUtilTimeout:5000}));
 afterAll(()=>configure({asyncUtilTimeout:previousWait}));
 projectSyncContract('UI → Hono → real PostgreSQL → local cache',async()=>{
  const connectionString=process.env.PROJECTS_TEST_DATABASE_URL;
  if(!connectionString||!['127.0.0.1','localhost'].includes(new URL(connectionString).hostname))throw new Error('Dedicated loopback test database required');
  const schema='lov_sync_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString,max:1,connectionTimeoutMillis:5000});
  await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString,options:'-c search_path='+schema,max:4,statement_timeout:5000,connectionTimeoutMillis:5000});
  return {db:dbFromPool(pool),close:async()=>{await pool.end();try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}finally{await admin.end();}}};
 },true);
});
