import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function changedSources(version=2){
  const state=useStore.getState(),snapshot=state.snapshots[0];
  useStore.setState({liveId:'version-'+version,remoteRevision:version+5,snapshots:[...state.snapshots,{...snapshot,id:'version-'+version,v:version,sourceFiles:JSON.stringify([{name:'src/main.tsx',content:'export const version='+version+';',modified:false}])}]});
}
describe('publish dialog with exact server selection',()=>{
  it('recovers an older uncertain publication after source edits without saving a new selection, then requires fresh consent for the current sources',async()=>{
    const fetch=mockFetch();let first=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{const response=await fetch(path,init);if(init?.method==='POST'&&first){first=false;throw new TypeError('lost response');}return response;}));
    mocks.save.mockResolvedValueOnce({id:'project-publish',revision:1}).mockResolvedValueOnce({id:'project-publish',revision:8});
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    const original={...posts[0]},oldUrl=responseUrl,uuid=vi.spyOn(crypto,'randomUUID');
    act(()=>changedSources());
    fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));
    const oldLink=await screen.findByRole('link',{name:'Otvoriť publikáciu predchádzajúcej verzie'});
    expect(oldLink).toHaveAttribute('href',oldUrl);expect(screen.getByText(/Aktuálne zdroje tým nie sú publikované/)).toBeInTheDocument();
    expect(posts).toEqual([original]);expect(mocks.save).toHaveBeenCalledTimes(1);expect(uuid).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([path])=>path==='/api/publish/'+original.requestId)).toBe(true);
    expect(useStore.getState().publishedUrl).toBeNull();expect(useStore.getState().persistNow).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBeNull();
    expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'Publikovať zvolenú verziu'})).toBeDisabled();
    responseUrl='https://published.example.test/p/22222222-2222-4222-8222-222222222222/';
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Publikovať zvolenú verziu'}));
    const currentLink=await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});
    expect(currentLink).toHaveAttribute('href',responseUrl);expect(posts).toHaveLength(2);expect(posts[1]).toMatchObject({projectId:'project-publish',expectedRevision:8,snapshotId:'version-2'});
    expect(posts[1].requestId).not.toBe(original.requestId);expect(uuid).toHaveBeenCalledTimes(1);expect(mocks.save).toHaveBeenCalledTimes(2);expect(useStore.getState().publishedUrl).toBe(responseUrl);
  });
  it.each(['published','network','definitive-rejection'] as const)('retains the original edited-source receipt through GET404 and exact-UUID POST until %s',async(outcome)=>{
    const fetch=mockFetch();let first=true,observedReceipt:string|null=null;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/api/publish/'))return Response.json({error:'publish_not_found'},{status:404});
      const response=await fetch(path,init);
      if(init?.method==='POST'){
        if(first){first=false;throw new TypeError('lost response');}
        observedReceipt=sessionStorage.getItem('forge-publish:alice:project-publish');
        if(outcome==='network')throw new TypeError('lost retry');
        if(outcome==='definitive-rejection')return Response.json({error:'publish_project_conflict'},{status:409});
      }
      return response;
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    const receipt=sessionStorage.getItem('forge-publish:alice:project-publish'),original={...posts[0]},uuid=vi.spyOn(crypto,'randomUUID');
    act(()=>changedSources());fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));
    if(outcome==='published')await screen.findByRole('link',{name:'Otvoriť publikáciu predchádzajúcej verzie'});
    else await waitFor(()=>expect(posts).toHaveLength(2));
    if(outcome!=='published')await screen.findByRole('alert');
    expect(observedReceipt).toBe(receipt);expect(posts).toEqual([original,original]);expect(mocks.save).toHaveBeenCalledTimes(1);expect(uuid).not.toHaveBeenCalled();
    expect(useStore.getState().publishedUrl).toBeNull();
    if(outcome==='network')expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBe(receipt);
    else{expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBeNull();expect(screen.getByRole('checkbox')).not.toBeChecked();}
  });
  it.each(['account','project','source'] as const)('ignores delayed old-source recovery after a further %s change',async(change)=>{
    const fetch=mockFetch();let finish!:(response:Response)=>void,first=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/api/publish/'))return new Promise<Response>(resolve=>{finish=resolve;});
      const response=await fetch(path,init);if(init?.method==='POST'&&first){first=false;throw new TypeError('lost response');}return response;
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    const receipt=sessionStorage.getItem('forge-publish:alice:project-publish'),original={...posts[0]};
    act(()=>changedSources());fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));await waitFor(()=>expect(finish).toBeTypeOf('function'));
    act(()=>{if(change==='account')selectDatabaseScope({kind:'account',userId:'bob'});else if(change==='project')useStore.setState({projectId:'new-project'});else changedSources(3);});
    await act(async()=>finish(await fetch('/api/publish/'+original.requestId,{method:'GET'})));
    expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBe(receipt);expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(useStore.getState().publishedUrl).toBeNull();expect(posts).toHaveLength(1);expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it('reconciles a definitive revision conflict and creates a fresh saved selection on the next explicit retry',async()=>{
    const fetch=mockFetch();let first=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      const response=await fetch(path,init);
      if(init?.method==='POST'&&first){first=false;return Response.json({error:'publish_project_conflict'},{status:409});}
      return response;
    }));
    mocks.save.mockResolvedValueOnce({id:'project-publish',revision:1}).mockResolvedValueOnce({id:'project-publish',revision:3});
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();
    expect(await screen.findByRole('alert')).toHaveTextContent('Obnov projekt v Moje projekty');
    expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBeNull();
    expect(posts).toHaveLength(1);const oldRequest=posts[0].requestId;
    // The user reconciles only the server revision; the approved local source fingerprint stays identical.
    act(()=>useStore.setState({remoteRevision:2}));
    fireEvent.click(screen.getByRole('button',{name:'Publikovať zvolenú verziu'}));
    await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});
    expect(mocks.save).toHaveBeenCalledTimes(2);expect(posts).toHaveLength(2);
    expect(posts[1].expectedRevision).toBe(3);expect(posts[1].requestId).not.toBe(oldRequest);
    expect(fetch.mock.calls.some(([path])=>path==='/api/publish/'+oldRequest)).toBe(false);
  });
  it.each([
    ['publish_project_not_found',404],['publish_project_invalid',409],
    ['publish_snapshot_sources_required',409],['publish_sources_unsupported',400],
    ['publish_invalid_request',400],['publish_input_limit',413],
  ] as const)('releases only the rejected input receipt for %s',async(code,status)=>{
    const fetch=mockFetch();vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>init?.method==='POST'?Response.json({error:code},{status}):fetch(path,init)));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBeNull();
    expect(screen.getByRole('button',{name:'Publikovať zvolenú verziu'})).toBeEnabled();
  });
  it.each(['network','timeout','request-conflict','unknown-input','server-failure','invalid-response'] as const)('preserves the UUID after %s instead of starting a replacement',async(kind)=>{
    const fetch=mockFetch();let first=true;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      if(init?.method==='POST'&&first){
        first=false;posts.push(JSON.parse(String(init.body)));
        if(kind==='network')throw new TypeError('lost response');
        if(kind==='timeout')throw new DOMException('timed out','TimeoutError');
        if(kind==='invalid-response')return Response.json({requestId:posts[0].requestId});
        return Response.json({error:kind==='request-conflict'?'publish_request_conflict':kind==='unknown-input'?'unknown_input':'publish_unavailable'},{status:kind==='request-conflict'?409:kind==='unknown-input'?400:503});
      }
      return fetch(path,init);
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    const receipt=sessionStorage.getItem('forge-publish:alice:project-publish');expect(receipt).not.toBeNull();
    expect(JSON.parse(receipt!).selection.requestId).toBe(posts[0].requestId);
    fireEvent.click(screen.getByRole('button',{name:'Overiť rovnakú požiadavku'}));
    await screen.findByRole('link',{name:'Otvoriť verejnú aplikáciu'});
    expect(posts).toHaveLength(1);expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it.each(['account','project'] as const)('does not clear a previous receipt after the %s identity changes',async(change)=>{
    const fetch=mockFetch();let finish!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return new Promise<Response>(resolve=>{finish=resolve;});}
      return fetch(path,init);
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await waitFor(()=>expect(finish).toBeTypeOf('function'));
    const key='forge-publish:alice:project-publish',receipt=sessionStorage.getItem(key);
    act(()=>{if(change==='account')selectDatabaseScope({kind:'account',userId:'bob'});else useStore.setState({projectId:'new-project'});});
    const otherKey=change==='account'?'forge-publish:bob:project-publish':'forge-publish:alice:new-project';sessionStorage.setItem(otherKey,'new-owner-receipt');
    await act(async()=>finish(Response.json({error:'publish_project_conflict'},{status:409})));
    expect(sessionStorage.getItem(key)).toBe(receipt);expect(sessionStorage.getItem(otherKey)).toBe('new-owner-receipt');expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('does not remove a replacement receipt when an older rejection arrives',async()=>{
    const fetch=mockFetch();let finish!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
      if(init?.method==='POST')return new Promise<Response>(resolve=>{finish=resolve;});return fetch(path,init);
    }));
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await waitFor(()=>expect(finish).toBeTypeOf('function'));
    const key='forge-publish:alice:project-publish',receipt=JSON.parse(sessionStorage.getItem(key)!);receipt.selection.requestId=crypto.randomUUID();const replacement=JSON.stringify(receipt);sessionStorage.setItem(key,replacement);
    await act(async()=>finish(Response.json({error:'publish_project_conflict'},{status:409})));
    expect(sessionStorage.getItem(key)).toBe(replacement);
  });
  it('rejects a save response for another project before storing or posting a publication',async()=>{
    mocks.save.mockResolvedValue({id:'foreign-project',revision:1});
    render(<PublishDialog userId="alice" onClose={()=>{}}/>);await approve();await screen.findByRole('alert');
    expect(posts).toHaveLength(0);expect(sessionStorage.getItem('forge-publish:alice:project-publish')).toBeNull();
  });
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
