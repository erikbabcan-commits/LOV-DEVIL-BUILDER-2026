import { z } from 'zod';
import { WorkspaceSchema, ProjectId, type ServerWorkspace } from '../../../shared/projectSchema';
import { apiHeaders } from '../../lib/csrf';
import { ProjectStorageUsage } from '../../../shared/projectStorage';

const Metadata=z.object({id:ProjectId,title:z.string(),revision:z.number().int().positive(),updatedAt:z.string(),deletedAt:z.string().nullable()});
const Listing=z.object({projects:Metadata.array().max(50),nextCursor:ProjectId.nullable()});
const Document=z.object({id:ProjectId,revision:z.number().int().positive(),workspace:WorkspaceSchema});
const Ack=z.object({id:ProjectId,revision:z.number().int().positive()});
export type RemoteMetadata=z.infer<typeof Metadata>;
export type RemoteDocument=z.infer<typeof Document>;
export class ProjectApiError extends Error {
  constructor(public code:string){super(code);}
}
function matchingId<T extends {id:string}>(id:string,value:T):T {
  if(value.id!==id)throw new ProjectApiError('protocol');
  return value;
}
async function call(path:string,signal:AbortSignal,body?:unknown,root='/api/projects'):Promise<unknown>{
  try{
    const response=await fetch(root+path,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),...(body===undefined?{}:{headers:apiHeaders(),body:JSON.stringify(body)})});
    const json:unknown=await response.json().catch(()=>null);
    if(!response.ok)throw new ProjectApiError(response.status===413&&json&&typeof json==='object'&&'error' in json&&json.error==='project_storage_quota'?'storage_quota':response.status===409?(json&&typeof json==='object'&&'error' in json&&json.error==='immutable_history'?'history_conflict':'conflict'):response.status===401?'login_required':response.status===403?'access_denied':response.status===410?'deleted':response.status===413||response.status===400?'project_limits':response.status===429?'rate_limit':'unavailable');
    return json;
  }catch(error){if(error instanceof ProjectApiError)throw error;if(signal.aborted)throw new ProjectApiError('cancelled');throw new ProjectApiError('network');}
}
export const remoteProjects={
  usage:async(signal:AbortSignal)=>ProjectStorageUsage.parse(await call('',signal,undefined,'/api/project-storage')),
  list:async(deleted:boolean,cursor:string|null,signal:AbortSignal)=>Listing.parse(await call('?deleted='+(deleted?'1':'0')+(cursor?'&cursor='+encodeURIComponent(cursor):''),signal)),
  read:async(id:string,signal:AbortSignal)=>matchingId(id,Document.parse(await call('/'+encodeURIComponent(id),signal))),
  save:async(id:string,expectedRevision:number,workspace:ServerWorkspace,signal:AbortSignal)=>matchingId(id,Ack.parse(await call('/'+encodeURIComponent(id),signal,{expectedRevision,workspace}))),
  change:async(id:string,expectedRevision:number,action:'delete'|'restore',signal:AbortSignal)=>matchingId(id,Ack.parse(await call('/'+encodeURIComponent(id)+'/'+action,signal,{expectedRevision}))),
};
