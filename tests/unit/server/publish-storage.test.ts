// @vitest-environment node
import { newDb } from "pg-mem";
import { dbFromPool } from "../../../server/db/pool";
import { registerProjectByteLength } from "../../helpers/projectMemoryDb";
import { publishStorageContract } from "../../helpers/publishStorageContract";
publishStorageContract("durable publish phase and bounded storage",async()=>{
 const mem=newDb();registerProjectByteLength(mem);const pool=new (mem.adapters.createPg().Pool)();
 return {db:dbFromPool(pool),close:()=>pool.end()};
});
