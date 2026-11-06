import { WorkspaceSchema, type ServerWorkspace } from '../../../shared/projectSchema';
import { useStore, conversationContext, type AppState } from '../../stores/useAppStore';
import { filesFor } from '../../lib/vfs/filesFor';
import { importRemoteProject, loadProjects, persistenceScope, saveMeta } from '../persistence/db';
import { nextRevision } from '../persistence/projectStore';
import { remoteProjects, ProjectApiError } from './client';

export function workspacePayload(state:AppState):ServerWorkspace{
  const live=state.snapshots.find(snapshot=>snapshot.id===state.liveId);
  const remoteId=(id:string)=>state.remoteSnapshotIds[id]??id;
  return WorkspaceSchema.parse({title:state.projectTitle,isPublic:state.isPublic,conversation:conversationContext(state.messages),liveId:state.liveId?remoteId(state.liveId):null,snapshots:state.snapshots.map(({id,v,prompt,kind,time,html,pinned,msg,parentId,sourceFiles})=>({id:remoteId(id),v,prompt,kind,time,html,pinned,msg,parentId:parentId?remoteId(parentId):parentId,sourceFiles})),files:live?(state.vfs[live.id]??filesFor(live)).map(({name,content,modified})=>({name,content,modified})):[]});
}
function capture(){
  const state=useStore.getState(),epoch=persistenceScope().epoch;
  if(state.generating||state.sandboxBuilding||state.pendingReview||state.edEditing||state.codeDraftDirty)throw new ProjectApiError('busy');
  const fingerprint=JSON.stringify({id:state.projectId,title:state.projectTitle,snapshots:state.snapshots,vfs:state.vfs,liveId:state.liveId,isPublic:state.isPublic,messages:state.messages});
  return {state,epoch,unchanged:()=>{
    const now=useStore.getState();return persistenceScope().epoch===epoch&&!now.codeDraftDirty&&!now.edEditing&&JSON.stringify({id:now.projectId,title:now.projectTitle,snapshots:now.snapshots,vfs:now.vfs,liveId:now.liveId,isPublic:now.isPublic,messages:now.messages})===fingerprint;
  }};
}
export async function saveRemoteWorkspace(signal:AbortSignal,asCopy=false){
  const captured=capture(),payload=workspacePayload(captured.state);
  if(!await captured.state.persistNow())throw new ProjectApiError('local_storage');
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  const id=asCopy?'project-'+crypto.randomUUID():captured.state.projectId;
  const result=await remoteProjects.save(id,asCopy?0:captured.state.remoteRevision,payload,signal);
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  // A copy is a separate server project; keep the current local project's original identity.
  if(!asCopy){useStore.setState({remoteRevision:result.revision});await useStore.getState().persistNow();}
  return result;
}
export async function openRemoteWorkspace(id:string,signal:AbortSignal){
  const captured=capture();
  if(!await captured.state.persistNow())throw new ProjectApiError('local_storage');
  const remote=await remoteProjects.read(id,signal);
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  const now=Date.now(),workspace=remote.workspace;
  const ids=new Map(workspace.snapshots.map(snapshot=>[snapshot.id,crypto.randomUUID()]));
  const backup=await importRemoteProject({project:{id:remote.id,title:workspace.title,conversation:workspace.conversation,createdAt:now,updatedAt:now,liveSnapshotId:workspace.liveId?ids.get(workspace.liveId)!:null,isPublic:workspace.isPublic,publishedUrl:null,remoteRevision:remote.revision,remoteSnapshotIds:Object.fromEntries([...ids].map(([remote,local])=>[local,remote]))},snapshots:workspace.snapshots.map(snapshot=>({...snapshot,id:ids.get(snapshot.id)!,parentId:snapshot.parentId?ids.get(snapshot.parentId)!:snapshot.parentId,projectId:remote.id,pinned:!!snapshot.pinned})),files:workspace.files.map(file=>({projectId:remote.id,path:file.name,content:file.content,updatedAt:now,revision:nextRevision()}))});
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  useStore.getState().newProject();await useStore.getState().restoreFromDb();
  if(persistenceScope().epoch!==captured.epoch||signal.aborted)throw new ProjectApiError('stale');
  useStore.getState().goEditor();useStore.getState().setEdTab('preview');
  return backup;
}
export async function openLocalWorkspace(id:string,signal:AbortSignal){
  const captured=capture(),scope=persistenceScope();
  if(!await captured.state.persistNow())throw new ProjectApiError('local_storage');
  const projects=await loadProjects(scope.databaseName);
  if(!projects.some(project=>project.id===id))throw new ProjectApiError('unavailable');
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  await saveMeta('lastProject',id,scope.databaseName);
  if(!captured.unchanged()||signal.aborted)throw new ProjectApiError('stale');
  useStore.getState().newProject();await useStore.getState().restoreFromDb();
  if(persistenceScope().epoch!==scope.epoch||signal.aborted)throw new ProjectApiError('stale');
  useStore.getState().goEditor();useStore.getState().setEdTab('preview');
}
