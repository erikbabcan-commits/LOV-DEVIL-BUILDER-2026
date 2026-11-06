import {PATCH_PROJECT_FILES,patchFixtureProvider} from '../fixtures/patchProject';
import {PostgresQuotaStore} from '../../server/security/quotaStore';
import {InMemoryAiUsageStore} from '../../server/usage/store';
import {changedFiles} from '../../src/lib/projectDiff';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { createApp } from '../../server/index';
import { applyMigrations } from '../../server/db/migrate';
import type { DbLike } from '../../server/db/pool';
import { signToken } from '../../server/auth/tokens';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import { useStore } from '../../src/stores/useAppStore';
import {captureCodeEditBase} from '../../src/services/editor/codeDrafts';
import { BLUEPRINT_REGISTRY } from '../../src/templates/registry';
import { selectPersistenceScope } from '../../src/services/persistence/projectStore';
import { importRemoteProject, loadProjects, loadSnapshots } from '../../src/services/persistence/db';
import { saveRemoteWorkspace, openRemoteWorkspace, workspacePayload } from '../../src/services/projects/workspace';
import { remoteProjects } from '../../src/services/projects/client';
import { ProjectLibrary } from '../../src/features/projects/ProjectLibrary';
import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder } from 'node:util';

export function projectSyncContract(name:string,connect:()=>Promise<{db:DbLike;close:()=>Promise<void>}>,nativePostgres=false) {
 describe(name,()=>{
  let db:DbLike,close:()=>Promise<void>,app:ReturnType<typeof createApp>,token:string;
  const signal=()=>new AbortController().signal;
  let sequence=0;
  const secret='sync-contract-local-test-secret-0123456789';
  beforeEach(async()=>{
   // Hono/Jose run in Node while the UI runs in jsdom; align binary crypto realms for this harness.
   vi.stubGlobal('Uint8Array',new NodeTextEncoder().encode('').constructor);
   vi.stubGlobal('crypto',webcrypto);
   ({db,close}=await connect());await applyMigrations(db);
   await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',['alice','alice@example.com','test']);
   token=await signToken({sub:'alice',email:'alice@example.com',plan:'free'},secret);
   app=createApp({},null,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota:new InMemoryQuotaStore()}});
   document.cookie='lov_csrf=sync-csrf; path=/';
   vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url:string,init:RequestInit={})=>app.request(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),Cookie:`lov_token=${token}; lov_csrf=sync-csrf`}})));
   selectPersistenceScope({kind:'account',userId:'sync-browser-'+(++sequence)+'-'+crypto.randomUUID()});useStore.getState().newProject();
   useStore.getState().stageTemplate(BLUEPRINT_REGISTRY[1]);useStore.getState().approveStagedRun();await useStore.getState().persistNow();
  });
  afterEach(async()=>{cleanup();vi.unstubAllGlobals();selectPersistenceScope({kind:'pilot'});useStore.getState().newProject();await close();});
  it('saves, reopens with a local backup, then edits the same immutable server history',async()=>{
   const id=useStore.getState().projectId;
   await saveRemoteWorkspace(signal());expect(useStore.getState().remoteRevision).toBe(1);
   useStore.getState().setEdFile('src/brand.ts');useStore.getState().saveEdFile('export const brand={name:"Synced"};\n');
   await saveRemoteWorkspace(signal());const before=await remoteProjects.read(id,signal());expect(before.revision).toBe(2);
   const backup=await openRemoteWorkspace(id,signal());expect(backup).toBeTruthy();
   expect((await loadProjects()).find(project=>project.id===backup)?.remoteRevision).toBe(0);
   expect((await loadSnapshots(backup!))).toHaveLength(2);
   expect(useStore.getState().snapshots.map(snapshot=>snapshot.v)).toEqual([1,2]);
   const pins=(snapshots:typeof before.workspace.snapshots)=>snapshots.map(snapshot=>({...snapshot,pinned:!!snapshot.pinned}));
   expect(pins(workspacePayload(useStore.getState()).snapshots)).toEqual(pins(before.workspace.snapshots));
   expect(useStore.getState().vfs[useStore.getState().liveId!].find(file=>file.name==='src/brand.ts')?.content).toContain('Synced');
   await saveRemoteWorkspace(signal());expect((await remoteProjects.read(id,signal())).revision).toBe(3);
   const copy=await saveRemoteWorkspace(signal(),true);expect(copy.id).not.toBe(id);expect(useStore.getState().projectId).toBe(id);
   await openRemoteWorkspace(copy.id,signal());expect(useStore.getState().projectId).toBe(copy.id);
   await saveRemoteWorkspace(signal());expect((await remoteProjects.read(copy.id,signal())).revision).toBe(2);
  });
  it('saves a main code-editor child without rewriting immutable server history and reopens it',async()=>{
   const id=useStore.getState().projectId;await saveRemoteWorkspace(signal());const original=await remoteProjects.read(id,signal()),before=structuredClone(useStore.getState().snapshots);
   const source=useStore.getState().vfs[useStore.getState().liveId!].find(f=>f.name==='src/brand.ts')!.content+'\nexport const manualCodeVersion = true;\n';
   expect(await useStore.getState().applyStagedFiles([{path:'src/brand.ts',content:source,action:'modify'}],captureCodeEditBase(useStore.getState())!)).toBe(true);
   expect(useStore.getState().snapshots.slice(0,before.length)).toEqual(before);await saveRemoteWorkspace(signal());const saved=await remoteProjects.read(id,signal());expect(saved.revision).toBe(2);expect(saved.workspace.snapshots[0]).toEqual(original.workspace.snapshots[0]);expect(saved.workspace.snapshots[1]).toMatchObject({kind:'manual',parentId:original.workspace.liveId});
   await openRemoteWorkspace(id,signal());expect(useStore.getState().snapshots).toHaveLength(2);expect(useStore.getState().vfs[useStore.getState().liveId!].find(f=>f.name==='src/brand.ts')?.content).toContain('manualCodeVersion');
   if(nativePostgres)expect((await db.query('SELECT COUNT(*)::int AS n FROM ai_runs')).rows[0].n).toBe(0);
  });
  it('round-trips conversation through IndexedDB and the owner server document',async()=>{
   useStore.setState({messages:Array.from({length:26},(_,i)=>({id:'turn-'+i,role:i%2?'assistant':'user',text:'Brand Acme; dialogue '+i,done:true}))});
   const id=useStore.getState().projectId;
   await saveRemoteWorkspace(signal());expect((await remoteProjects.read(id,signal())).workspace.conversation).toHaveLength(26);
   useStore.setState({messages:[]});await useStore.getState().restoreFromDb();expect(useStore.getState().messages).toHaveLength(26);
   expect(useStore.getState().messages[0].text).toContain('Brand Acme');
   await openRemoteWorkspace(id,signal());expect(useStore.getState().messages.at(-1)?.text).toContain('dialogue 25');
   expect(useStore.getState().messages.every(turn=>turn.done&&!turn.pending)).toBe(true);
  });
  it('generates one colour patch through Hono, previews no source mutation, then preserves it through owner save/reopen',async()=>{
   useStore.getState().newProject();const files=PATCH_PROJECT_FILES.map(f=>({name:f.path,content:f.content,modified:false})),snapshot=useStore.getState().createSnapshot('ai','Colour fixture','<main>Colour fixture</main>');
   useStore.setState({liveId:snapshot.id,snapshots:[{...snapshot,sourceFiles:JSON.stringify(files)}],vfs:{[snapshot.id]:files},projectTitle:'Colour fixture'});
   app=createApp({},patchFixtureProvider(),{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota:nativePostgres?new PostgresQuotaStore(db):new InMemoryQuotaStore(),...(nativePostgres?{}:{usage:new InMemoryAiUsageStore()})}});
   const saved=await saveRemoteWorkspace(signal());const original=await remoteProjects.read(saved.id,signal());
   await useStore.getState().generateWithAi('Zmeň farbu hlavného tlačidla na červenú.','auto');
   expect(useStore.getState().pendingReview).toMatchObject({source:'patch',files:[{path:'src/index.css',action:'modify'}]});expect(useStore.getState().snapshots).toHaveLength(1);expect(useStore.getState().vfs[snapshot.id]).toEqual(files);
   expect(useStore.getState().approveStagedRun()).toBe(true);expect(changedFiles(files,useStore.getState().vfs[useStore.getState().liveId!]).map(f=>f.path)).toEqual(['src/index.css']);
   await saveRemoteWorkspace(signal());const after=await remoteProjects.read(saved.id,signal());expect(after.revision).toBe(2);expect(after.workspace.snapshots[0]).toEqual(original.workspace.snapshots[0]);expect(after.workspace.files.find(f=>f.name==='src/index.css')?.content).toBe(files[4].content.replace('#2563eb','#dc2626'));
   await openRemoteWorkspace(saved.id,signal());expect(useStore.getState().snapshots).toHaveLength(2);expect(useStore.getState().vfs[useStore.getState().liveId!].find(file=>file.name==='src/App.tsx')?.content).toBe(files[3].content);
   if(nativePostgres){expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'succeeded'}]);expect((await db.query('SELECT COUNT(*) AS n FROM ai_calls')).rows[0].n).toBe('3');}
  });
  it('keeps local changes on a conflict and saves a separate server copy',async()=>{
   await saveRemoteWorkspace(signal());const state=useStore.getState(),id=state.projectId;
   const original=await remoteProjects.read(id,signal());
   await remoteProjects.save(id,1,{...original.workspace,title:'Other tab'},signal());
   useStore.getState().setTitle('Local edits');
   await expect(saveRemoteWorkspace(signal())).rejects.toMatchObject({code:'conflict'});
   expect(useStore.getState().projectTitle).toBe('Local edits');
   const copy=await saveRemoteWorkspace(signal(),true);
   expect((await remoteProjects.read(copy.id,signal())).workspace.title).toBe('Local edits');
   expect((await remoteProjects.read(id,signal())).workspace.title).toBe('Other tab');
  });
  it('ignores an in-flight server response after the account changes',async()=>{
   const saved=await saveRemoteWorkspace(signal()),response=await remoteProjects.read(saved.id,signal());
   let release!: (value:Response)=>void;
   vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{release=resolve;})));
   const pending=openRemoteWorkspace(saved.id,signal());
   await waitFor(()=>expect(release).toBeTypeOf('function'));
   selectPersistenceScope({kind:'account',userId:'bob-'+crypto.randomUUID()});useStore.getState().newProject();useStore.getState().setTitle('Bob');
   release(Response.json(response));await expect(pending).rejects.toMatchObject({code:'stale'});
   expect(useStore.getState().projectTitle).toBe('Bob');expect(await loadProjects()).toEqual([]);
  });
  it('rolls back backup and replacement together if an import fails',async()=>{
   await useStore.getState().persistNow();const state=useStore.getState(),snapshot=state.snapshots[0];
   const project=(await loadProjects()).find(project=>project.id===state.projectId)!;
   await expect(importRemoteProject({project,snapshots:[{...snapshot,projectId:project.id,pinned:false},{...snapshot,projectId:project.id,pinned:false}],files:[]})).rejects.toThrow();
   expect(await loadProjects()).toHaveLength(1);expect(await loadSnapshots(project.id)).toHaveLength(1);
  });
  it('saves and moves a server project to trash while preserving its local copy',async()=>{
   render(<ProjectLibrary enabled onClose={()=>{}}/>);
   await waitFor(()=>expect(screen.getByRole('button',{name:'Uložiť na server'})).toBeEnabled());
   fireEvent.click(screen.getByRole('button',{name:'Uložiť na server'}));
   await screen.findByText('Zachytená verzia bola uložená na server.');
   fireEvent.click(screen.getByRole('button',{name:'Do koša'}));
   await screen.findByText('Serverový projekt je v koši. Lokálna kópia zostala zachovaná.');
   expect((await remoteProjects.list(false,null,signal())).projects).toHaveLength(0);
   expect((await remoteProjects.list(true,null,signal())).projects).toHaveLength(1);
   expect(await loadProjects()).toHaveLength(1);
  });
  it('restores a retained server project through the project library',async()=>{
   const saved=await saveRemoteWorkspace(signal());
   await remoteProjects.change(saved.id,saved.revision,'delete',signal());
   render(<ProjectLibrary enabled onClose={()=>{}}/>);
   await waitFor(()=>expect(screen.getByRole('button',{name:'Kôš'})).toBeEnabled());
   fireEvent.click(screen.getByRole('button',{name:'Kôš'}));
   await screen.findByRole('button',{name:'Obnoviť'});
   fireEvent.click(screen.getByRole('button',{name:'Obnoviť'}));
   await screen.findByText('Projekt bol obnovený.');
   expect((await remoteProjects.list(false,null,signal())).projects).toHaveLength(1);
  });
  it('shows capacity and preserves local edits when a full account refuses another server copy',async()=>{
   await saveRemoteWorkspace(signal());const id=useStore.getState().projectId;
   useStore.getState().setTitle('Lokálna práca '.repeat(5));
   app=createApp({projectStorage:{maxBytes:1,maxProjects:1}},null,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota:new InMemoryQuotaStore()}});
   render(<ProjectLibrary enabled quota={{used:10,limit:10,remaining:0,plan:'free'}} onClose={()=>{}}/>);
   expect(screen.getByRole('region',{name:'Mesačná spotreba AI'})).toHaveTextContent('Mesačný limit AI je vyčerpaný');
   await screen.findByRole('region',{name:'Kapacita serverového úložiska'});
   await waitFor(()=>expect(screen.getByRole('button',{name:'Uložiť ako serverovú kópiu'})).toBeEnabled());
   fireEvent.click(screen.getByRole('button',{name:'Uložiť ako serverovú kópiu'}));
   expect(await screen.findByRole('alert')).toHaveTextContent('Serverové úložisko je plné');
   expect(useStore.getState().projectId).toBe(id);expect(useStore.getState().projectTitle).toBe('Lokálna práca '.repeat(5));
   expect(useStore.getState().remoteRevision).toBe(1);expect((await remoteProjects.list(false,null,signal())).projects).toHaveLength(1);
   expect((await loadProjects()).find(project=>project.id===id)?.title).toBe('Lokálna práca '.repeat(5));
  });
 });
}
