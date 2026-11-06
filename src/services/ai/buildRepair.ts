import {z} from 'zod';
import {apiHeaders} from '../../lib/csrf';
import {AI_API_BASE,AiRequestError,NetworkError} from './client';
import {notifyAiQuotaChanged} from './usage';
import type {GeneratedFile} from './types';
const Source=z.object({path:z.string().min(1).max(200),content:z.string().max(200_000)});
const Result=z.object({ok:z.boolean(),attempts:z.number().int().min(0).max(2),patchesApplied:z.number().int().min(0).max(64),summary:z.string().max(600).optional(),finalFiles:Source.array().max(40),buildErrors:z.array(z.object({file:z.string(),message:z.string(),attempt:z.number()})).max(200)});
export async function requestBuildRepair(files:Array<{path:string;content:string}>,selection:{modelId?:string;allowFallback?:boolean;fallbackIds?:string[]},signal:AbortSignal){
 let response:Response;
 try{response=await fetch(AI_API_BASE+'/api/sandbox/autofix',{method:'POST',headers:apiHeaders(),body:JSON.stringify({files,...selection}),signal});}catch{signal.throwIfAborted();throw new NetworkError(true);}
 notifyAiQuotaChanged();signal.throwIfAborted();
 const value:unknown=await response.json().catch(()=>null);
 if(!response.ok){
  const code=value&&typeof value==='object'&&'error'in value?value.error:null;
  if(response.status===401)throw new AiRequestError('login_required',false);
  if(response.status===403)throw new AiRequestError('access_denied',false);
  if(code==='context_limit')throw new AiRequestError('context_limit',false);
  if(code==='quota_exceeded'||code==='quota_unavailable'||code==='invalid_model'||code==='ai_disabled')throw new AiRequestError(code,false);
  if(code==='secret_in_context')throw new AiRequestError('secret_in_context',false);
  if(response.status===429)throw new AiRequestError(code==='BUDGET_EXCEEDED'?'run_budget':'rate_limit',true);
  throw new AiRequestError('service_unavailable',true);
 }
 const parsed=Result.safeParse(value);if(!parsed.success)throw new AiRequestError('stream_interrupted',false);
 const result=parsed.data;
 if(new Set(result.finalFiles.map(file=>file.path)).size!==result.finalFiles.length||result.finalFiles.reduce((total,file)=>total+new TextEncoder().encode(file.content).byteLength,0)>2_000_000)throw new AiRequestError('stream_interrupted',false);
 const before=new Map(files.map(file=>[file.path,file.content])),after=new Map(result.finalFiles.map(file=>[file.path,file.content]));
 const changes:GeneratedFile[]=result.finalFiles.filter(file=>before.get(file.path)!==file.content).map(file=>({...file,action:before.has(file.path)?'modify':'create'}));
 for(const file of files)if(!after.has(file.path))changes.push({path:file.path,content:'',action:'delete'});
 if(result.ok&&(!result.finalFiles.length||(result.attempts>0&&!changes.length)||changes.length>40))throw new AiRequestError('stream_interrupted',false);
 return{...result,changes};
}
