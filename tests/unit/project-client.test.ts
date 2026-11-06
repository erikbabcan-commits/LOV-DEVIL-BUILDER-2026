import { afterEach, expect, it, vi } from 'vitest';
import { remoteProjects } from '../../src/services/projects/client';
afterEach(()=>vi.unstubAllGlobals());
it('rejects a valid-looking response for a different project ID',async()=>{
 const workspace={title:'Other project',isPublic:false,liveId:null,snapshots:[],files:[]};
 vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(Response.json({id:'wrong',revision:1,workspace}))));
 const signal=new AbortController().signal;
 await expect(remoteProjects.read('expected',signal)).rejects.toMatchObject({code:'protocol'});
 await expect(remoteProjects.save('expected',0,workspace,signal)).rejects.toMatchObject({code:'protocol'});
 await expect(remoteProjects.change('expected',1,'delete',signal)).rejects.toMatchObject({code:'protocol'});
});
it('loads only validated account storage metadata from its fixed endpoint',async()=>{
 const api=vi.fn().mockResolvedValue(Response.json({usedBytes:800,limitBytes:1000,usedProjects:2,limitProjects:3,trashedProjects:1,warning:true,workspace:'must-not-surface'}));vi.stubGlobal('fetch',api);
 expect(await remoteProjects.usage(new AbortController().signal)).toEqual({usedBytes:800,limitBytes:1000,usedProjects:2,limitProjects:3,trashedProjects:1,warning:true});
 expect(api.mock.calls[0]).toEqual(['/api/project-storage',expect.objectContaining({method:'GET',credentials:'include',cache:'no-store'})]);
});
it('distinguishes exhausted account capacity from a malformed or oversized project',async()=>{
 const api=vi.fn().mockResolvedValueOnce(Response.json({error:'project_storage_quota'},{status:413})).mockResolvedValueOnce(Response.json({error:'project_too_large'},{status:413}));vi.stubGlobal('fetch',api);
 const workspace={title:'Own',isPublic:false,liveId:null,snapshots:[],files:[]};const signal=new AbortController().signal;
 await expect(remoteProjects.save('p1',0,workspace,signal)).rejects.toMatchObject({code:'storage_quota'});
 await expect(remoteProjects.save('p1',0,workspace,signal)).rejects.toMatchObject({code:'project_limits'});
});
