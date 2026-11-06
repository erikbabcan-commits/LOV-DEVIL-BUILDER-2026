import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublishDialog } from '../../src/features/publish/PublishDialog';
import { useStore } from '../../src/stores/useAppStore';
import { selectDatabaseScope } from '../../src/services/persistence/db';
const mocks=vi.hoisted(()=>({save:vi.fn()}));
vi.mock('../../src/services/projects/workspace',async original=>({...await original<typeof import('../../src/services/projects/workspace')>(),saveRemoteWorkspace:mocks.save}));
const originalPersist=useStore.getState().persistNow;
const ready={enabled:true,ready:true,reason:null,publicOrigin:'https://published.example.test'};
let posts: Array<{requestId:string;projectId:string;expectedRevision:number;snapshotId:string;publicConsent:true}>;
let responseUrl:string;
function mockFetch() {
  return vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/publish'&&init?.method==='GET')return Response.json(ready);
    const selection=init?.body?JSON.parse(String(init.body)):posts[0];
    if(init?.method==='POST')posts.push(selection);
    return Response.json({requestId:selection.requestId,projectId:selection.projectId,revision:selection.expectedRevision,snapshotId:selection.snapshotId,state:'published',url:responseUrl,error:null,errors:[],artifactBytes:100,createdAt:new Date().toISOString()});
  });
}
beforeEach(()=>{
  selectDatabaseScope({kind:'account',userId:'alice'});sessionStorage.clear();posts=[];responseUrl='https://published.example.test/p/11111111-1111-4111-8111-111111111111/';
  useStore.getState().newProject();
  useStore.setState({projectId:'project-publish',projectTitle:'Publish fixture',remoteRevision:0,remoteSnapshotIds:{},liveId:'version-1',snapshots:[{id:'version-1',v:1,prompt:'Fixture',kind:'manual',time:'now',html:'<p>Fixture</p>',sourceFiles:JSON.stringify([{name:'src/main.tsx',content:'export {};',modified:false}])}],vfs:{},persistNow:vi.fn(async()=>true)});
  mocks.save.mockReset();mocks.save.mockResolvedValue({id:'project-publish',revision:1});
  vi.stubGlobal('fetch',mockFetch());document.cookie='lov_csrf=publish-fixture; Path=/';
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();useStore.setState({persistNow:originalPersist});selectDatabaseScope({kind:'pilot'});});
async function approve(){await screen.findByText(/Súhlasím so zverejnením/);await waitFor(()=>expect(screen.queryByText('Overujem hosting…')).not.toBeInTheDocument());fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Publikovať zvolenú verziu'}));}
describe('publish dialog with exact server selection',()=>{
  it('restarts an abandoned building job using the same durable selection',async()=>{
    const fetch=mockFetch();let lost=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      const response=await fetch(path,init);
      if(init?.method==='POST'&&lost){lost=false;throw new TypeError('lost response');}
      if(path.startsWith('/api/publish/'))return Response.json({...await response.json(),state:'building',url:null});
      return response;
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));
    await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});
    expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('does not save or publish before an explicit public consent',async()=>{
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.queryByText('Overujem hosting…')).not.toBeInTheDocument());
    expect(screen.getByRole('button',{name:'Publikovať zvolenú verziu'})).toBeDisabled();expect(mocks.save).not.toHaveBeenCalled();expect(posts).toEqual([]);
  });
  it('saves the approved snapshot, sends exact revision and exposes only the actual public result',async()=>{
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();
    const link=await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});
    expect(link).toHaveAttribute('href',responseUrl);expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({projectId:'project-publish',expectedRevision:1,snapshotId:'version-1',publicConsent:true});expect(posts[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(useStore.getState().publishedUrl).toBe(responseUrl);
  });
  it('rejects a result URL on an unconfigured origin without a published state',async()=>{
    responseUrl='https://attacker.example/p/11111111-1111-4111-8111-111111111111/';
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();
    await screen.findByRole('alert');expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(useStore.getState().publishedUrl).toBeNull();
  });
  it('recovers a lost POST response through the saved UUID without a second save or publish',async()=>{
    const fetch=mockFetch();let fail=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{const result=await fetch(path,init);if(init?.method==='POST'&&fail){fail=false;throw new TypeError('lost response');}return result;}));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));
    await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});expect(posts).toHaveLength(1);expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
