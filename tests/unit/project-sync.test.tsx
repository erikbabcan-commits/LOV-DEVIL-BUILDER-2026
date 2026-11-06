import { newDb } from 'pg-mem';
import { projectSyncContract } from '../helpers/projectSyncContract';
import { dbFromPool } from '../../server/db/pool';
import { registerProjectByteLength } from '../helpers/projectMemoryDb';
projectSyncContract('project UI → Hono → pg-mem → local cache',async()=>{
 const mem=newDb();registerProjectByteLength(mem);const pool=new (mem.adapters.createPg().Pool)();
 return {db:dbFromPool(pool),close:async()=>{await pool.end();}};
});
