import {z} from 'zod';
import {apiHeaders} from '../../lib/csrf';
import {AI_API_BASE,AiRequestError,NetworkError} from './client';
import {notifyAiQuotaChanged} from './usage';
import type {GeneratedFile} from './types';
const Source=z.object({path:z.string().min(1).max(200),content:z.string().max(200_000)});
/** Zhodné so server/agent/autofix.ts MAX_ATTEMPTS (Erik schválil 3 pokusy). */
export const REPAIR_MAX_ATTEMPTS=3;
const Step=z.object({attempt:z.number().int().min(1).max(REPAIR_MAX_ATTEMPTS),step:z.enum(['build','patch','rebuild']),status:z.enum(['ok','failed'])});
const RouteInfo=z.object({model:z.string().max(40),reason:z.string().max(40)});
const Result=z.object({ok:z.boolean(),attempts:z.number().int().min(0).max(REPAIR_MAX_ATTEMPTS),progress:Step.array().max(REPAIR_MAX_ATTEMPTS*3).optional(),blocked:z.literal('security').optional(),route:RouteInfo.optional(),patchesApplied:z.number().int().min(0).max(64),summary:z.string().max(600).optional(),finalFiles:Source.array().max(40),buildErrors:z.array(z.object({file:z.string(),message:z.string(),attempt:z.number()})).max(200)});
export type RepairStep=z.infer<typeof Step>;
export interface RepairProgress{state:'idle'|'running'|'succeeded'|'failed'|'blocked';attempts:number;steps:RepairStep[];route?:z.infer<typeof RouteInfo>;context?:unknown}
/* Agent 9: malý externý store priebehu opravy pre RepairStatus (mimo zustand, schvaľovací tok sa nemení).
   `context` viaže stav na konkrétny neúspešný build, aby sa starý výsledok neukázal pri inom builde. */
const IDLE:RepairProgress={state:'idle',attempts:0,steps:[]};
let progress:RepairProgress=IDLE;const listeners=new Set<()=>void>();
const publish=(next:RepairProgress)=>{progress=next;for(const listener of listeners)listener();};
export const repairProgress={get:()=>progress,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
/** Volá BuildRepairAction pri kliknutí: priebeh patrí k aktuálnym chybám buildu. */
export function markRepairContext(context:unknown){publish({...IDLE,context});}
export function resetRepairProgress(){publish({...IDLE,context:progress.context});}
export async function requestBuildRepair(files:Array<{path:string;content:string}>,selection:{modelId?:string;allowFallback?:boolean;fallbackIds?:string[]},signal:AbortSignal){
 publish({...IDLE,state:'running',context:progress.context});
 try{
  const result=await requestBuildRepairOnce(files,selection,signal);
  publish({state:result.blocked?'blocked':result.ok?'succeeded':'failed',attempts:result.attempts,steps:result.progress??[],...(result.route?{route:result.route}:{}),context:progress.context});
  return result;
 }catch(error){resetRepairProgress();throw error;}
}
async function requestBuildRepairOnce(files:Array<{path:string;content:string}>,selection:{modelId?:string;allowFallback?:boolean;fallbackIds?:string[]},signal:AbortSignal){
 let response:Response;
 try{response=await fetch(AI_API_BASE+'/api/sandbox/autofix',{method:'POST',headers:apiHeaders(),body:JSON.stringify({files,...selection}),signal,credentials:'include'});}catch{signal.throwIfAborted();throw new NetworkError(true);}
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
