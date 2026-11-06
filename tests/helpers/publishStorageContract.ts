import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbLike } from "../../server/db/pool";
import { applyMigrations } from "../../server/db/migrate";
import { PublishService } from "../../server/publish/service";
import { ArtifactStore } from "../../server/publish/artifacts";
import { FilesystemGate } from "../../server/publish/storageGate";
import type { PublishConfig } from "../../server/publish/config";
import type { BuildResult } from "../../server/sandbox/policy";
import type { SandboxExecutor } from "../../server/sandbox/executor";
import { authRouter } from "../../server/auth/routes";
import { PostgresQuotaStore } from "../../server/security/quotaStore";
import { signToken } from "../../server/auth/tokens";
import type { PublishSelection } from "../../shared/publish";

const compiled: BuildResult = { ok: true, html: "<main>durable phase fixture</main>", errors: [], durationMs: 1, moduleCount: 1 };
const secret = "publish-phase-local-jwt-secret-01234567890123456789";
export function publishStorageContract(name: string, connect: () => Promise<{
  db: DbLike; close: () => Promise<void>;
  poolState?: () => { total: number; idle: number; waiting: number };
}>, native = false) {
  describe(name, () => {
    let db: DbLike, close: () => Promise<void>, poolState: (() => {total: number; idle: number; waiting: number}) | undefined;
    let directory: string, config: PublishConfig, selection: PublishSelection, bobToken: string;
    let gate: FilesystemGate, store: ArtifactStore, service: PublishService, auth: Hono;
    let physicalPut!: (this: ArtifactStore, id: string, html: string) => Promise<{sha256:string;bytes:number}>;
    let releases: Array<() => void>, compiler: ReturnType<typeof vi.fn<SandboxExecutor["execute"]>>;
    const insideTransaction = new AsyncLocalStorage<boolean>();
    beforeEach(async () => {
      releases = [];
      const raw = await connect(); close = raw.close; poolState = raw.poolState;
      db = { query: raw.db.query, transaction: work => raw.db.transaction!(tx => insideTransaction.run(true, () => work(tx))) };
      await applyMigrations(db);
      for (const id of ["alice", "bob"]) await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [id,id+"@publish-phase.example.test","unused"]);
      const files = [{ name: "src/main.tsx", content: "export const phase = true;" }];
      const workspace = { title: "Durable phase", isPublic: false, liveId: "snapshot-one", files, snapshots: [{ id: "snapshot-one", v: 1, prompt: "", kind: "manual", time: "", html: "<main/>", sourceFiles: JSON.stringify(files) }] };
      await db.query("INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)", ["alice","project-one",workspace.title,JSON.stringify(workspace)]);
      directory = await mkdtemp(path.join(tmpdir(), "lov-publish-phase-"));
      config = { baseUrl: "http://127.0.0.1:8791/", appUrl: "http://localhost:5176/", artifactDir: directory, bind: "127.0.0.1", port: 8791, maxArtifacts: 20, maxArtifactBytes: 1000, maxOwnerBytes: 10000, minFreeBytes: 0, allowHostTest: true };
      selection = { requestId: randomUUID(), projectId: "project-one", expectedRevision: 1, snapshotId: "snapshot-one", publicConsent: true };
      gate = new FilesystemGate(2,8,200); store = new ArtifactStore(directory,1000,0,gate);
      compiler = vi.fn(async () => compiled);
      service = new PublishService(db,config,{ ready: async () => ({ready:true,mode:"isolated"}), execute: compiler },{artifacts:store});
      const prototype = Object.getPrototypeOf(store);
      for (const method of ["physicalReady","physicalPut","physicalRead","physicalRetainedBytes"]) {
        const original = prototype[method];
        if (method === "physicalPut") physicalPut = original;
        vi.spyOn(prototype,method).mockImplementation(function(this: ArtifactStore, ...args: unknown[]) {
          expect(insideTransaction.getStore(), method+" must not run with a pinned transaction").not.toBe(true);
          return original.apply(this,args);
        });
      }
      bobToken = await signToken({sub:"bob",email:"bob@publish-phase.example.test",plan:"free"},secret);
      auth = new Hono(); auth.route("/",authRouter({db,jwtSecret:secret,quota:new PostgresQuotaStore(db)}));
      vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("External HTTP forbidden");}));
    }, native ? 60000 : 10000);
    afterEach(async () => {
      for (const release of releases) release();
      await gate?.idle(); await service?.settled();
      // Let already-settled outcome callbacks finish short metadata transactions.
      if (db) await db.query("SELECT 1");
      expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
      await close?.(); if (directory) await rm(directory,{recursive:true,force:true});
    });
    const next = () => ({...selection,requestId:randomUUID()});
    const row = async (id = selection.requestId) => (await db.query("SELECT state,storage_phase,artifact_bytes,error_code FROM publish_jobs WHERE owner_id='alice' AND request_id=$1",[id])).rows[0];
    const releaseCompile = () => {
      let release!: () => void;
      const promise = new Promise<BuildResult>(resolve => {release=()=>resolve(compiled);});
      releases.push(release); return {promise,release};
    };
    async function assertDatabaseResponsive() {
      const started = Date.now();
      expect((await auth.request("/api/auth/me",{headers:{Cookie:"lov_token="+bobToken}})).status).toBe(200);
      expect((await db.query("SELECT id FROM users WHERE id='bob'")).rows).toEqual([{id:"bob"}]);
      expect(Date.now()-started).toBeLessThan(1500);
      if (poolState) await vi.waitFor(() => { const state=poolState!(); expect(state.waiting).toBe(0); expect(state.idle).toBe(state.total); });
    }
    it("expires an unknown-receipt compilation on new admission and fences its surviving compiler", async () => {
      config.maxOwnerBytes=1000;
      service = new PublishService(db,config,{ready:async()=>({ready:true,mode:"isolated"}),execute:compiler},{artifacts:store});
      const paused=releaseCompile(); compiler.mockImplementationOnce(()=>paused.promise);
      const physical=vi.spyOn(Object.getPrototypeOf(store),"physicalPut");
      await service.start("alice",selection);
      await db.query("UPDATE publish_jobs SET updated_at=$2 WHERE request_id=$1",[selection.requestId,new Date(Date.now()-180000).toISOString()]);
      const fresh=next(); await service.start("alice",fresh);
      expect(await row()).toMatchObject({state:"failed",storage_phase:"empty",artifact_bytes:0,error_code:"publish_build_expired"});
      paused.release(); await service.settled();
      expect((await service.status("alice",fresh.requestId)).state).toBe("published");
      expect(physical).toHaveBeenCalledTimes(1);
    });
    it("also sweeps expired compilation from status without requiring storage readiness", async () => {
      const paused=releaseCompile();compiler.mockImplementationOnce(()=>paused.promise);
      await service.start("alice",selection);
      await db.query("UPDATE publish_jobs SET updated_at=$2 WHERE request_id=$1",[selection.requestId,new Date(Date.now()-180000).toISOString()]);
      vi.spyOn(store,"ready").mockImplementation(()=>{throw new Error("Status must not inspect disk");});
      expect(await service.status("alice",selection.requestId)).toMatchObject({state:"failed",error:"publish_build_expired",url:null});
      expect(await row()).toMatchObject({storage_phase:"empty",artifact_bytes:0});
      paused.release();await service.settled();
    });
    it("never frees or retries an expired writing phase", async () => {
      config.maxOwnerBytes=1000; service=new PublishService(db,config,{ready:async()=>({ready:true,mode:"isolated"}),execute:compiler},{artifacts:store});
      const paused=releaseCompile();compiler.mockImplementationOnce(()=>paused.promise);
      await service.start("alice",selection);
      await db.query("UPDATE publish_jobs SET storage_phase='writing',artifact_sha256=$2,updated_at=$3 WHERE request_id=$1",[selection.requestId,"a".repeat(64),new Date(Date.now()-180000).toISOString()]);
      await expect(service.start("alice",next())).rejects.toMatchObject({code:"publish_capacity"});
      expect(await row()).toMatchObject({state:"building",storage_phase:"writing",artifact_bytes:1000});
      paused.release();await service.settled();
    });
    it("refuses unknown legacy storage rather than freeing a possible orphan", async () => {
      await service.start("alice",selection);await service.settled();
      await db.query("UPDATE publish_jobs SET storage_phase='legacy_unknown' WHERE request_id=$1",[selection.requestId]);
      await expect(service.start("alice",next())).rejects.toMatchObject({code:"publish_storage_recovery_required"});
    });
    it("keeps two physical writers occupied after deadlines, cancels queued writes and leaves the real DB pool available", async () => {
      const pause=releaseCompile();compiler.mockImplementation(()=>pause.promise);
      const jobs=Array.from({length:5},(_,index)=>index?next():selection);
      await Promise.all(jobs.map(job=>service.start("alice",job)));
      const prototype=Object.getPrototypeOf(store), real=physicalPut;
      let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});releases.push(release);
      let writes=0;
      vi.spyOn(prototype,"physicalPut").mockImplementation(async function(this:ArtifactStore,...args:unknown[]){const [id,html]=args;if(typeof id!=="string"||typeof html!=="string")throw new Error("Invalid synthetic physical put arguments");writes++;expect(insideTransaction.getStore()).not.toBe(true);await blocked;return real.call(this,id,html);});
      pause.release();await service.settled();
      expect(writes).toBe(2);expect(gate.stats).toEqual({active:2,queued:0});
      const phases=(await db.query("SELECT storage_phase,artifact_bytes,state FROM publish_jobs WHERE owner_id='alice'")).rows;
      expect(phases.filter(value=>value.storage_phase==="writing"&&value.artifact_bytes===1000&&value.state==="failed")).toHaveLength(2);
      expect(phases.filter(value=>value.storage_phase==="empty"&&value.artifact_bytes===0)).toHaveLength(3);
      await assertDatabaseResponsive();
      release();await gate.idle();
      await vi.waitFor(async()=>expect((await db.query("SELECT COUNT(*)::int AS n FROM publish_jobs WHERE storage_phase='retained' AND state='failed'")).rows[0].n).toBe(2));
      expect(writes).toBe(2);expect((await service.status("alice",selection.requestId)).url).toBeNull();
    });
    it("bounds five stalled inventories outside transactions and keeps authentication responsive", async () => {
      await service.start("alice",selection);await service.settled();
      const id=(await db.query("SELECT artifact_id FROM publish_jobs WHERE request_id=$1",[selection.requestId])).rows[0].artifact_id;
      let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});releases.push(release);
      let inventories=0;
      vi.spyOn(Object.getPrototypeOf(store),"physicalRetainedBytes").mockImplementation(async()=>{inventories++;expect(insideTransaction.getStore()).not.toBe(true);await blocked;return new Map([[id,Buffer.byteLength(compiled.html!)]]);});
      const results=await Promise.allSettled(Array.from({length:5},()=>store.retainedBytes([id])));
      expect(results.every(value=>value.status==="rejected")).toBe(true);
      expect(inventories).toBe(2);expect(gate.stats).toEqual({active:2,queued:0});
      await assertDatabaseResponsive();
      expect((await service.status("alice",selection.requestId)).state).toBe("published");
      release();await gate.idle();
    });
  });
}
