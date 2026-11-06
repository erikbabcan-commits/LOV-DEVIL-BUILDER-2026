import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, cleanup, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { loadProjects, openDb, persistenceScope, saveMeta, saveRun, loadMeta } from '../../src/services/persistence/db';
import { persistProjectState, restoreWorkspace, selectPersistenceScope, scheduleAutosave, type ProjectState } from '../../src/services/persistence/projectStore';
import { useStore } from '../../src/stores/useAppStore';
import { AppShell } from '../../src/app/AppShell';

let serial=0;
const originalScrollTo=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollTo');
const account=(userId:string)=>selectPersistenceScope({kind:'account',userId});
const state=(title:string):ProjectState=>({
  project:{id:'same-project-id',title,createdAt:1,updatedAt:1,liveSnapshotId:'same-snapshot-id',publishedUrl:null,isPublic:false},
  snapshots:[{id:'same-snapshot-id',projectId:'same-project-id',v:1,prompt:title,kind:'manual',time:'now',html:title,pinned:false}],
  files:[{projectId:'same-project-id',path:'src/main.tsx',content:title,updatedAt:1,revision:1}],
});
beforeEach(()=>{serial++;Object.defineProperty(HTMLElement.prototype,'scrollTo',{value:vi.fn(),configurable:true});useStore.getState().newProject();});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();selectPersistenceScope({kind:'pilot'});useStore.getState().newProject();if(originalScrollTo)Object.defineProperty(HTMLElement.prototype,'scrollTo',originalScrollTo);else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;});

describe('per-account local persistence',()=>{
  it('isolates identical project/snapshot IDs, last pointers, source and run records',async()=>{
    const a='alice-'+serial,b='bob-'+serial;
    account(a); expect(await persistProjectState(state('Alice private'))).toBeNull();
    await saveRun({id:'same-run',projectId:'same-project-id',prompt:'Alice prompt',mode:'create',status:'completed',model:'test',createdAt:1,planSummary:null,fileCount:1});
    account(b);expect((await restoreWorkspace()).project).toBeNull();
    expect(await loadMeta('lastProject')).toBeNull();
    expect(await persistProjectState(state('Bob private'))).toBeNull();
    const bob=await restoreWorkspace();expect(bob.project?.title).toBe('Bob private');expect(bob.runs).toEqual([]);
    account(a);const alice=await restoreWorkspace();
    expect(alice.project?.title).toBe('Alice private');expect(alice.snapshots[0].html).toBe('Alice private');expect(alice.files[0].content).toBe('Alice private');expect(alice.runs[0].prompt).toBe('Alice prompt');
  });
  it('keeps an already started write bound to its original account',async()=>{
    account('write-a-'+serial);const pending=persistProjectState(state('A pending'));
    account('write-b-'+serial);await pending;
    expect(await loadProjects()).toEqual([]);
    account('write-a-'+serial);expect((await loadProjects())[0].title).toBe('A pending');
  });
  it('keeps every stage of an in-flight restore bound to the original database',async()=>{
    account('read-a-'+serial);await persistProjectState(state('A'));
    const pending=restoreWorkspace();
    account('read-b-'+serial);await persistProjectState(state('B'));
    const a=await pending;expect(a.project?.title).toBe('A');expect(a.files[0].content).toBe('A');
    expect((await restoreWorkspace()).files[0].content).toBe('B');
  });
  it('discards an obsolete store restore even after switching A to B and back to A',async()=>{
    const a='stale-a-'+serial;
    account(a);await persistProjectState(state('old A'));
    const pending=useStore.getState().restoreFromDb();
    account('stale-b-'+serial);account(a);
    useStore.setState({projectTitle:'current A',snapshots:[]});
    await pending;expect(useStore.getState().projectTitle).toBe('current A');expect(useStore.getState().snapshots).toEqual([]);
  });
  it('does not let restore overwrite a project created while the read was pending',async()=>{
    account('new-project-'+serial);await persistProjectState(state('old project'));
    const pending=useStore.getState().restoreFromDb();useStore.getState().newProject();
    await pending;expect(useStore.getState().projectTitle).toBe('Nový projekt');expect(useStore.getState().snapshots).toEqual([]);
  });
  it('cancels pending autosave when the account boundary changes',async()=>{
    vi.useFakeTimers();account('timer-a-'+serial);const save=vi.fn().mockResolvedValue(undefined);
    scheduleAutosave(save);account('timer-b-'+serial);await vi.advanceTimersByTimeAsync(1000);expect(save).not.toHaveBeenCalled();
  });
  it('locks unverified access and preserves the original pilot database without assigning it to a new user',async()=>{
    selectPersistenceScope({kind:'pilot'});await saveMeta('pilot-test-'+serial,'legacy private');
    account('fresh-'+serial);expect(await loadMeta('pilot-test-'+serial)).toBeNull();
    selectPersistenceScope({kind:'locked'});expect(persistenceScope().databaseName).toBeNull();
    await expect(openDb()).rejects.toThrow('locked');await expect(loadProjects()).rejects.toThrow('locked');
    expect(await persistProjectState(state('denied'))).toMatchObject({kind:'io'});
    selectPersistenceScope({kind:'pilot'});expect(await loadMeta('pilot-test-'+serial)).toBe('legacy private');
  });
  it('switches the actual AppShell to the verified account after session revalidation',async()=>{
    const a='shell-a-'+serial,b='shell-b-'+serial;
    account(a);await persistProjectState(state('Alice workspace'));
    account(b);await persistProjectState(state('Bob workspace'));
    selectPersistenceScope({kind:'locked'});useStore.setState({mode:'home'});
    const me=(id:string)=>Response.json({user:{id,email:id+'@example.com',plan:'free'},quota:{used:0,limit:10,remaining:10,plan:'free'}});
    let user=a;
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(me(user))));
    render(<AppShell/>);
    await waitFor(()=>expect(useStore.getState().projectTitle).toBe('Alice workspace'));
    useStore.setState({console:[{t:'now',txt:'Alice private log',cls:'info'}],promptDraft:'Alice draft'});
    user=b;fireEvent.focus(window);
    await waitFor(()=>expect(useStore.getState().projectTitle).toBe('Bob workspace'));
    expect(useStore.getState().console).toEqual([]);expect(useStore.getState().promptDraft).toBe('');
    expect(useStore.getState().snapshots[0].html).toBe('Bob workspace');
    expect(persistenceScope().databaseName).toContain(encodeURIComponent(b));
    useStore.setState({isPublic:true});user='fresh-shell-'+serial;fireEvent.focus(window);
    await waitFor(()=>expect(useStore.getState().projectTitle).toBe('Nový projekt'));
    expect(useStore.getState().snapshots).toEqual([]);expect(useStore.getState().isPublic).toBe(false);
  });
  it('ignores an older authentication response that arrives after a newer session check',async()=>{
    const a='race-a-'+serial,b='race-b-'+serial;
    account(b);await persistProjectState(state('newer B session'));
    selectPersistenceScope({kind:'locked'});useStore.setState({mode:'home'});
    const me=(id:string)=>Response.json({user:{id,email:id+'@example.com',plan:'free'},quota:{used:0,limit:10,remaining:10,plan:'free'}});
    let release!: (value:Response)=>void;
    const pending=new Promise<Response>(resolve=>{release=resolve;});
    const fetch=vi.fn().mockReturnValueOnce(pending).mockImplementation(()=>Promise.resolve(me(b)));
    vi.stubGlobal('fetch',fetch);render(<AppShell/>);
    await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);
    await waitFor(()=>expect(useStore.getState().projectTitle).toBe('newer B session'));
    await act(async()=>{release(me(a));await pending;});
    expect(useStore.getState().projectTitle).toBe('newer B session');
    expect(persistenceScope().databaseName).toContain(encodeURIComponent(b));
  });
});
