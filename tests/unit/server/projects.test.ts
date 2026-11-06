// @vitest-environment node
import { newDb } from 'pg-mem';
import { projectContract } from '../../helpers/projectContract';
import { dbFromPool } from '../../../server/db/pool';
import { registerProjectByteLength } from '../../helpers/projectMemoryDb';
import { projectStorageContract } from '../../helpers/projectStorageContract';
const connect=async()=>{
  const mem=newDb();registerProjectByteLength(mem);const pool=new (mem.adapters.createPg().Pool)();
  return {db:dbFromPool(pool),close:async()=>{await pool.end();}};
};
projectContract('owner-scoped project API (pg-mem)',connect);
projectStorageContract('account storage policy (pg-mem, no concurrency proof)',connect);
