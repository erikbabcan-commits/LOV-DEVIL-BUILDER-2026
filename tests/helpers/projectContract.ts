import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/index';
import { applyMigrations } from '../../server/db/migrate';
import type { DbLike } from '../../server/db/pool';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import { signToken } from '../../server/auth/tokens';
import { PROJECT_BODY_BYTES } from '../../server/projects/routes';

export function projectContract(name:string, connect:()=>Promise<{db:DbLike;close:()=>Promise<void>}>, verifyMigrationReplay=false) {
  describe(name,()=>{
    let db:DbLike, close:()=>Promise<void>, app:ReturnType<typeof createApp>, alice:string,bob:string;
    const secret='project-contract-test-signing-secret-0123456789';
    const workspace=(title='Project')=>({title,isPublic:false,liveId:'s1',snapshots:[{id:'s1',v:1,prompt:'Build',kind:'manual',time:'now',html:'<h1>Safe</h1>',sourceFiles:JSON.stringify([{name:'src/main.tsx',content:'export {};',modified:false}])}],files:[{name:'src/main.tsx',content:'export {};',modified:false}]});
    beforeEach(async()=>{
      ({db,close}=await connect());await applyMigrations(db);
      if(verifyMigrationReplay)await applyMigrations(db);
      for(const id of ['alice','bob'])await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',[id,id+'@example.com','unused-test-hash']);
      alice=await signToken({sub:'alice',email:'alice@example.com',plan:'free'},secret);
      bob=await signToken({sub:'bob',email:'bob@example.com',plan:'free'},secret);
      app=createApp({},null,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota:new InMemoryQuotaStore()}});
    });
    afterEach(async()=>{if(close)await close();});
    const request=async(path:string,body?:unknown,token=alice,csrf=true)=>app.request('/api/projects'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:`lov_token=${token}; lov_csrf=test-csrf`,...(csrf?{'X-CSRF-Token':'test-csrf'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const save=(title='Project',expectedRevision=0)=>request('/shared-id',{expectedRevision,workspace:workspace(title)});
    it('creates, lists and reads only the authenticated owner, including colliding IDs',async()=>{
      expect((await save('Alice private')).status).toBe(201);
      const list=await request('');expect(list.headers.get('cache-control')).toBe('no-store');expect((await list.json()).projects[0].title).toBe('Alice private');
      expect((await request('',undefined,bob).then(r=>r.json())).projects).toEqual([]);
      expect((await request('/shared-id',undefined,bob)).status).toBe(404);
      expect((await request('/shared-id/delete',{expectedRevision:1},bob)).status).toBe(404);
      expect((await request('/shared-id/restore',{expectedRevision:1},bob)).status).toBe(404);
      expect((await request('/shared-id',{expectedRevision:0,workspace:workspace('Bob private')},bob)).status).toBe(201);
      expect((await request('/shared-id').then(r=>r.json())).workspace.title).toBe('Alice private');
      expect((await request('/shared-id',undefined,bob).then(r=>r.json())).workspace.title).toBe('Bob private');
    });
    it('retains a 26-message transcript only for its owner and refuses transcript credentials',async()=>{
      const conversation=Array.from({length:26},(_,i)=>({role:i%2?'assistant':'user',content:'Private conversation '+i}));
      expect((await request('/dialogue',{expectedRevision:0,workspace:{...workspace(),conversation}})).status).toBe(201);
      expect((await request('/dialogue').then(r=>r.json())).workspace.conversation).toEqual(conversation);
      expect((await request('/dialogue',undefined,bob)).status).toBe(404);
      expect((await request('/credential',{expectedRevision:0,workspace:{...workspace(),conversation:[{role:'user',content:'sk-'+'A'.repeat(24)}]}})).status).toBe(400);
      expect((await request('/credential')).status).toBe(404);
    });
    it('requires auth and CSRF and is absent in the anonymous pilot',async()=>{
      expect((await request('/x',undefined,'invalid')).status).toBe(401);
      expect((await request('/x',{expectedRevision:0,workspace:workspace()},alice,false)).status).toBe(403);
      expect((await createApp({},null).request('/api/projects')).status).toBe(404);
    });
    it('permits exactly one concurrent writer and reports stale revision conflict',async()=>{
      await save();
      const results=await Promise.all([save('First',1),save('Second',1)]);
      expect(results.map(r=>r.status).sort()).toEqual([200,409]);
      const stored=await request('/shared-id').then(r=>r.json());expect(stored.revision).toBe(2);
      expect(['First','Second']).toContain(stored.workspace.title);
      expect((await save('Stale',1)).status).toBe(409);
      expect((await save('Duplicate create')).status).toBe(409);
    });
    if(verifyMigrationReplay)it('resolves a concurrent initial creation with the database unique constraint',async()=>{
      const results=await Promise.all([save('Create A'),save('Create B')]);
      expect(results.map(result=>result.status).sort()).toEqual([201,409]);
      expect((await request('').then(result=>result.json())).projects).toHaveLength(1);
    });
    it('preserves immutable snapshots while allowing pins and appending a version',async()=>{
      await save();const changed=workspace();changed.snapshots[0].html='changed history';
      expect((await request('/shared-id',{expectedRevision:1,workspace:changed})).status).toBe(409);
      const next={...workspace(),snapshots:[{...workspace().snapshots[0],pinned:true},{...workspace().snapshots[0],id:'s2',v:2,parentId:'s1',html:'new'}],liveId:'s2'};
      expect((await request('/shared-id',{expectedRevision:1,workspace:next})).status).toBe(200);
      const dropped={...next,snapshots:[next.snapshots[1]]};
      expect((await request('/shared-id',{expectedRevision:2,workspace:dropped})).status).toBe(400);
      expect((await request('/shared-id',{expectedRevision:2,workspace:{...next,snapshots:[{...next.snapshots[1],parentId:null}]}})).status).toBe(409);
    });
    it('soft-deletes with revision protection and restores within the grace period',async()=>{
      await save();expect((await request('/shared-id/delete',{expectedRevision:1})).status).toBe(200);
      expect((await request('/shared-id')).status).toBe(410);
      expect((await request('').then(r=>r.json())).projects).toEqual([]);
      expect((await request('?deleted=1').then(r=>r.json())).projects).toHaveLength(1);
      expect((await save('cannot overwrite deleted',2)).status).toBe(410);
      expect((await request('/shared-id/restore',{expectedRevision:1})).status).toBe(409);
      expect((await request('/shared-id/restore',{expectedRevision:2})).status).toBe(200);
      expect((await request('/shared-id').then(r=>r.json())).revision).toBe(3);
      expect((await request('/shared-id/delete',{expectedRevision:3})).status).toBe(200);
      await db.query('UPDATE builder_projects SET deleted_at=$1 WHERE owner_id=$2 AND project_id=$3',[new Date(Date.now()-31*86400_000),'alice','shared-id']);
      expect((await request('/shared-id/restore',{expectedRevision:4})).status).toBe(409);
    });
    it('rejects malformed data, unsafe paths, secrets, duplicate history and large bodies',async()=>{
      expect((await request('/bad.id',{expectedRevision:0,workspace:workspace()})).status).toBe(400);
      const unsafe=workspace();unsafe.files[0].name='../private';
      expect((await request('/x',{expectedRevision:0,workspace:unsafe})).status).toBe(400);
      const secretPayload=workspace();secretPayload.files[0].content='ghp_'+'A'.repeat(30);
      expect((await request('/x',{expectedRevision:0,workspace:secretPayload})).status).toBe(400);
      const duplicate=workspace();duplicate.snapshots.push({...duplicate.snapshots[0]});
      expect((await request('/x',{expectedRevision:0,workspace:duplicate})).status).toBe(400);
      expect((await request('/x',{expectedRevision:0,workspace:workspace(),owner_id:'bob'})).status).toBe(400);
      expect((await request('/x',{oversized:'a'.repeat(PROJECT_BODY_BYTES)})).status).toBe(413);
    });
    it('paginates metadata without exposing workspace bodies',async()=>{
      // Pagination is the subject here; create/CAS/quota writes have separate contracts.
      // Seed fixtures directly rather than repeating 51 full authentication/save flows.
      for(let i=0;i<51;i++)await db.query(`INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace)
        VALUES($1,$2,$3,1,$4::jsonb)`,['alice','p'+String(i).padStart(3,'0'),'P'+i,JSON.stringify(workspace('P'+i))]);
      const first=await request('').then(r=>r.json());expect(first.projects).toHaveLength(50);expect(first.projects[0].workspace).toBeUndefined();
      const second=await request('?cursor='+first.nextCursor).then(r=>r.json());expect(second.projects).toHaveLength(1);expect(second.nextCursor).toBeNull();
    });
    it('redacts storage failures and enforces the owner rate limit',async()=>{
      const broken=createApp({},null,{auth:{db:{query:async()=>{throw new Error('private-db-credential');}},jwtSecret:secret,quota:new InMemoryQuotaStore()}});
      const result=await broken.request('/api/projects/x',{headers:{Cookie:'lov_token='+alice}});
      expect(result.status).toBe(503);expect(await result.text()).not.toContain('private-db-credential');
      const limited=createApp({},null,{rateLimit:()=>false,auth:{db,jwtSecret:secret,quota:new InMemoryQuotaStore()}});
      expect((await limited.request('/api/projects',{headers:{Cookie:'lov_token='+alice}})).status).toBe(429);
    });
  });
}
