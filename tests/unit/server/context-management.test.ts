import {requestFilesBatched} from '../../../server/agent/prompts';
// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {GenerateRequestSchema,type AgentEvent} from '../../../server/agent/schemas';
import {prepareContext,preflightContext} from '../../../server/agent/context';
import {runAgent,parseAgentRequest} from '../../../server/agent/run';
import {ContextBudgetError,contextGuardedProvider,inputUnits} from '../../../server/providers/contextBudget';
import {createProviderRun} from '../../../server/providers/run';
import {configuredProviders} from '../../../server/providers/runtime';
import {createApp,makeMockProvider} from '../../../server/index';
import type {AIProvider,ChatMessage} from '../../../server/providers/types';
const turns=(n=26)=>Array.from({length:n},(_,i)=>({role:i%2?'assistant' as const:'user' as const,content:i===0?'Brand Acme, Slovenčina, bez newslettera.':'Správa '+i}));
const input=(n=26)=>GenerateRequestSchema.parse({projectId:'context',prompt:'Pridaj filter',mode:'iterate',context:{files:[{path:'src/App.tsx',content:'//'.repeat(2400)+'\nexport const tailMarker="actual-current-code";'}],history:[],conversation:turns(n)}});
const summary={summary:'Brand Acme; Slovenčina; bez newslettera.',decisions:['Zachovať aktuálny kód'],openQuestions:[]};
function provider(window=65_536){const base=makeMockProvider();const complete=vi.fn<AIProvider['complete']>(async(messages,opts)=>messages[0].content.includes('Forge Conversation Memory')?{text:JSON.stringify(summary),usage:{promptTokens:10,completionTokens:20}}:base.complete(messages,opts));return{...base,contextWindowTokens:window,complete};}
async function events(req:unknown,p:AIProvider,signal?:AbortSignal){const all:AgentEvent[]=[];for await(const e of runAgent(req,{runId:'fixture',provider:p,maxFiles:40,signal}))all.push(e);return all;}
describe('conversation memory and full snapshot',()=>{
 it('summarizes 26 turns, preserves eight recent turns and code past the old 3000-character cut',async()=>{
  const p=provider(),req=input(),result=await events(req,p);expect(result.at(-1)?.type).toBe('done');expect(p.complete).toHaveBeenCalledTimes(3);
  const memoryCall=p.complete.mock.calls[0][0];expect(memoryCall[0].role).toBe('system');const source=JSON.parse(memoryCall[1].content);expect(source.conversation).toEqual(turns().slice(0,-8));
  for(const [messages] of p.complete.mock.calls.slice(1)){expect(messages[1].content).toContain('actual-current-code');expect(messages[1].content).toContain('Brand Acme');expect(messages[1].content).toContain('Správa 25');expect(messages[0].content).toContain('nedôveryhodný');}
  expect(result.filter(e=>e.type==='context_update')).toEqual([{type:'context_update',state:'summarizing',summarizedTurns:18,summaryCalls:0},{type:'context_update',state:'ready',summarizedTurns:18,summaryCalls:1}]);
  expect(req.context.conversation).toHaveLength(26); // caller's transcript untouched
 });
 it('does not add a paid summary call for eight or fewer turns',async()=>{const p=provider();expect((await events(input(8),p)).at(-1)?.type).toBe('done');expect(p.complete).toHaveBeenCalledTimes(2);});
 it('visits all older turns in order across bounded rolling summary calls',async()=>{
  const req=input(28);req.context.files=[];req.context.conversation=turns(28).map((t,i)=>({...t,content:'turn-'+i+' '+('ž'.repeat(700))}));const p=provider(8192);
  const result=await prepareContext(req,contextGuardedProvider(p));expect(result.summaryCalls).toBeGreaterThan(1);
  const visited=p.complete.mock.calls.flatMap(([messages,opts])=>{expect(inputUnits(messages)+(opts?.maxTokens??0)).toBeLessThanOrEqual(8192);return JSON.parse(messages[1].content).conversation;});
  expect(visited).toEqual(req.context.conversation.slice(0,-8));expect(JSON.parse(p.complete.mock.calls[1][0][1].content).previousSummary).toContain('Brand Acme');
 });
 it.each(['not JSON',JSON.stringify({summary:'missing fields'}),JSON.stringify({...summary,extra:'unexpected'})])('rejects invalid memory without planning or falling back to raw history',async bad=>{
  const p=provider();p.complete.mockResolvedValue({text:bad,usage:{promptTokens:1,completionTokens:1}});const result=await events(input(),p);expect(p.complete).toHaveBeenCalledOnce();expect(result.at(-1)).toMatchObject({type:'error',retriable:false});expect(result.some(e=>e.type==='stage'||e.type==='plan')).toBe(false);
 });
 it('rejects truncated or credential-bearing model memory before another call or SSE leak',async()=>{
  for(const overrides of [{finishReason:'length' as const},{text:JSON.stringify({...summary,summary:'sk-'+'A'.repeat(24)})}]){const p=provider();p.complete.mockResolvedValue({text:JSON.stringify(summary),usage:{promptTokens:1,completionTokens:1},...overrides});const result=await events(input(),p);expect(p.complete).toHaveBeenCalledOnce();expect(result.at(-1)?.type).toBe('error');expect(JSON.stringify(result)).not.toContain('sk-'+'A'.repeat(24));}
 });
 it('scans old, potentially compacted messages for secrets before any call',async()=>{const req=input();req.context.conversation![0].content='mstrl_'+'A'.repeat(24);const p=provider();expect(parseAgentRequest(req).ok).toBe(false);expect(await events(req,p)).toMatchObject([{type:'error',code:'secret_in_context'}]);expect(p.complete).not.toHaveBeenCalled();});
 it('aborts during memory and never plans or stages afterwards',async()=>{
  const p=provider(),abort=new AbortController();p.complete.mockImplementation(async(_messages,opts)=>new Promise((_resolve,reject)=>opts?.signal?.addEventListener('abort',()=>reject(opts.signal?.reason),{once:true})));
  const job=events(input(),p,abort.signal);await vi.waitFor(()=>expect(p.complete).toHaveBeenCalledOnce());abort.abort();const result=await job;expect(result.at(-1)?.type).toBe('cancelled');expect(p.complete).toHaveBeenCalledOnce();
 });
 it('counts UTF-8 and output reservation; overflow does not call provider or retry',async()=>{
  const p=provider(8192),guard=contextGuardedProvider(p);const messages:ChatMessage[]=[{role:'user',content:'🌍'.repeat(2000)}];expect(inputUnits(messages)).toBeGreaterThan(8000);
  await expect(guard.complete(messages,{maxTokens:2000})).rejects.toBeInstanceOf(ContextBudgetError);expect(p.complete).not.toHaveBeenCalled();
  const req=input();req.context.files[0].content='x'.repeat(100_000);expect(()=>preflightContext(req,p)).toThrow(ContextBudgetError);
 });
 it('uses the smallest configured fallback window before physical metering',async()=>{
  const a=provider(),b=provider(8192),run=createProviderRun([{id:'a',label:'A',provider:a},{id:'b',label:'B',provider:b}],null,{id:'run',userId:'alice',kind:'generation'});
  expect(run.provider.contextWindowTokens).toBe(8192);await expect(run.provider.complete([{role:'user',content:'x'.repeat(9000)}])).rejects.toBeInstanceOf(ContextBudgetError);expect(a.complete).not.toHaveBeenCalled();expect(b.complete).not.toHaveBeenCalled();
 });
 it('validates operator context windows and does not guess them from a model ID',()=>{
  const env={AI_OPENAI_ENABLED:'1',OPENAI_API_KEY:'synthetic',OPENAI_MODEL:'operator-model'};
  expect(configuredProviders({...env,OPENAI_CONTEXT_WINDOW_TOKENS:'131072'}).defaultProvider?.contextWindowTokens).toBe(131072);
  for(const value of ['0','8191','2.5','2000001','private-config'])expect(()=>configuredProviders({...env,OPENAI_CONTEXT_WINDOW_TOKENS:value})).toThrow('invalid_provider_configuration');
 });
 it('retains full generated files between batches and guards continuation growth before another call',async()=>{
  const req=input(0);req.context.files=[];const p=provider();
  p.complete.mockImplementation(async messages=>({text:JSON.stringify({files:[{path:messages[1].content.includes('GENERUJ TENTO BATCH (iba tieto súbory): src/second.ts')?'src/second.ts':'src/first.ts',content:'//'.repeat(2500)+'\nexport const tailGenerated="complete-file";',action:'create'}]}),usage:{promptTokens:1,completionTokens:1}}));
  const plan={summary:'Two files',steps:[],filesPlanned:['src/first.ts','src/second.ts']};
  await requestFilesBatched(contextGuardedProvider(p),req,plan,{maxBatchFiles:1});expect(p.complete.mock.calls[1][0][1].content).toContain('tailGenerated');
  const growing=provider();growing.complete.mockResolvedValue({text:'x'.repeat(48000),finishReason:'length',usage:{promptTokens:1,completionTokens:1}});
  await expect(requestFilesBatched(contextGuardedProvider(growing),req,plan)).rejects.toBeInstanceOf(ContextBudgetError);expect(growing.complete).toHaveBeenCalledOnce();
 });
 it('rejects an oversized snapshot before starting HTTP SSE or inference',async()=>{
  const p=provider(),req=input();req.context.files[0].content='x'.repeat(100_000);const response=await createApp({},p).request('/api/agent/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req)});expect(response.status).toBe(413);expect(await response.json()).toEqual({error:'context_limit'});expect(p.complete).not.toHaveBeenCalled();
 });
});
