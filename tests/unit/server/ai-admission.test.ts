// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
import { InMemoryQuotaStore, type QuotaStore } from '../../../server/security/quotaStore';
import { LocalBudgetGuard } from '../../../server/security/budget';
import { SandboxError } from '../../../server/sandbox/errors';
import type { SandboxExecutor } from '../../../server/sandbox/executor';

const secret='ai-admission-test-secret-01234567890123456789';
const input={projectId:'project',prompt:'Build a small dashboard',mode:'create'};
const goodBuild={ok:true,html:'<main>Built</main>',errors:[],durationMs:1,moduleCount:1};
const badBuild={...goodBuild,ok:false,errors:[{file:'src/main.tsx',message:'Syntax error'}]};
const sandbox=(execute:SandboxExecutor['execute']):SandboxExecutor=>({execute,ready:async()=>({ready:true,mode:'host'})});
const db={query:async(sql:string,params?:unknown[])=>{
  // Authentication revalidates these fixture identities in the DB on every request.
  const owner=params?.[0];
  if(sql==='SELECT id, email, plan, plan_expires_at FROM users WHERE id=$1'&&(owner==='alice'||owner==='bob'))
    return {rows:[{id:owner,email:owner+'@example.test',plan:'free',plan_expires_at:null}],rowCount:1};
  return {rows:[],rowCount:0};
}};

describe('AI quota admission and cancellation through HTTP',()=>{
  let token:string,quota:InMemoryQuotaStore;
  beforeEach(async()=>{token=await signToken({sub:'alice',email:'alice@example.test',plan:'free'},secret);quota=new InMemoryQuotaStore();});
  const request=(app:ReturnType<typeof createApp>,path='/api/agent/generate',body:unknown=input,signal?:AbortSignal)=>app.request(new Request('http://localhost'+path,{method:'POST',signal,headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify(body)}));
  const wiring=(store:QuotaStore=quota)=>({db,jwtSecret:secret,quota:store,usage:new InMemoryAiUsageStore()});
  it('does not consume monthly or local budget for malformed, secret-bearing or unavailable requests',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete'),budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:1});
    const app=createApp({},provider,{auth:wiring(),rateLimit:()=>true,budget});
    expect((await request(app,undefined,{})).status).toBe(400);
    expect((await request(app,undefined,{...input,prompt:'mstrl_'+'A'.repeat(32)})).status).toBe(400);
    expect((await request(createApp({},null,{auth:wiring(),rateLimit:()=>true,budget}))).status).toBe(503);
    const abort=new AbortController();abort.abort();expect((await request(app,undefined,input,abort.signal)).status).toBe(400);
    expect(await quota.usage('alice')).toMatchObject({used:0});
    expect(budget.getStats()).toEqual({active:0,admittedToday:0});expect(complete).not.toHaveBeenCalled();
  });
  it('leaves monthly usage untouched when concurrency admission is full',async()=>{
    const budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:3}),held=budget.acquire();
    const response=await request(createApp({},makeMockProvider(),{auth:wiring(),rateLimit:()=>true,budget}));
    expect(response.status).toBe(429);expect(await quota.usage('alice')).toMatchObject({used:0});
    if(held.ok)held.release();
  });
  it('returns denied quota admissions to local budget and leaves another account available',async()=>{
    for(let i=0;i<10;i++)await quota.consume('alice');
    const budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:1}),provider=makeMockProvider(),complete=vi.spyOn(provider,'complete');
    const app=createApp({},provider,{auth:wiring(),rateLimit:()=>true,budget});
    for(let i=0;i<3;i++){const response=await request(app);expect(response.status).toBe(429);expect(await response.json()).toMatchObject({error:'quota_exceeded',quota:{used:10},userId:'alice'});}
    expect(budget.getStats()).toEqual({active:0,admittedToday:0});expect(complete).not.toHaveBeenCalled();
    token=await signToken({sub:'bob',email:'bob@example.test',plan:'free'},secret);
    const response=await request(app);expect(response.status).toBe(200);await response.text();
    expect(await quota.usage('bob')).toMatchObject({used:1});expect(await quota.usage('alice')).toMatchObject({used:10});
  });
  it('fails closed without inference or leaked DB detail when quota storage is unavailable',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete'),budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:1});
    const failed:QuotaStore={usage:quota.usage.bind(quota),consume:async()=>{throw new Error('private-db-password');}};
    const response=await request(createApp({},provider,{auth:wiring(failed),rateLimit:()=>true,budget}));
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-db-password');
    expect(complete).not.toHaveBeenCalled();expect(budget.getStats()).toEqual({active:0,admittedToday:0});
  });
  it('charges a successful multi-call generation only once',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete');
    const response=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true}));
    expect(response.status).toBe(200);expect(await response.text()).toContain('"type":"done"');expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(await quota.usage('alice')).toMatchObject({used:1});
  });
  it('keeps concurrency occupied after reader cancellation until an uncooperative provider stops',async()=>{
    const plan=await makeMockProvider().complete([{role:'system',content:'"filesPlanned"'}]);
    let finish!: (value:typeof plan)=>void;
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:3}),app=createApp({},provider,{auth:wiring(),rateLimit:()=>true,budget});
    const response=await request(app),reader=response.body!.getReader();await reader.read();await vi.waitFor(()=>expect(complete).toHaveBeenCalledOnce());await reader.cancel();
    expect(budget.getStats()).toMatchObject({active:1});expect((await request(app)).status).toBe(429);
    finish(plan);await vi.waitFor(()=>expect(budget.getStats().active).toBe(0));
    expect(complete).toHaveBeenCalledOnce();expect(await quota.usage('alice')).toMatchObject({used:1});
  });
  it('propagates request disconnection to provider abort without starting another batch',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete').mockImplementation((_messages,options)=>new Promise((_resolve,reject)=>{
      options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    }));
    const budget=new LocalBudgetGuard({maxConcurrent:1,maxRunsPerDay:3}),abort=new AbortController();
    const response=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true,budget}),undefined,input,abort.signal);
    await vi.waitFor(()=>expect(complete).toHaveBeenCalledOnce());abort.abort();expect(await response.text()).toContain('"type":"cancelled"');expect(complete).toHaveBeenCalledOnce();expect(budget.getStats().active).toBe(0);
  });
  it('does not charge a clean autofix build or infrastructure failure',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete'),body={files:[{path:'src/main.tsx',content:'export {};'}]};
    const clean=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true,sandbox:sandbox(async()=>goodBuild)}),'/api/sandbox/autofix',body);
    expect(clean.status).toBe(200);expect(await clean.json()).not.toHaveProperty('quotaUpdate');
    const failed=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true,sandbox:sandbox(async()=>{throw new SandboxError('sandbox_unavailable');})}),'/api/sandbox/autofix',body);
    expect(failed.status).toBe(503);expect(complete).not.toHaveBeenCalled();expect(await quota.usage('alice')).toMatchObject({used:0});
  });
  it('charges both autofix attempts once and rejects exhausted users before any model patch',async()=>{
    const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete').mockImplementation(async messages=>{const file=JSON.parse(messages[1].content).files[0];return{text:JSON.stringify({version:1,summary:'Fix',changes:[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:file.content,replace:file.content+'\n// fix'}]}]}),usage:{promptTokens:2,completionTokens:3}};});
    const execute=vi.fn< SandboxExecutor['execute'] >().mockResolvedValueOnce(badBuild).mockResolvedValueOnce(badBuild).mockResolvedValue(goodBuild);
    const body={files:[{path:'src/main.tsx',content:'export {};'}]};
    const response=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true,sandbox:sandbox(execute)}),'/api/sandbox/autofix',body);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,attempts:2,quotaUpdate:{userId:'alice',quota:{used:1}}});expect(complete).toHaveBeenCalledTimes(2);
    for(let i=1;i<10;i++)await quota.consume('alice');complete.mockClear();
    const denied=await request(createApp({},provider,{auth:wiring(),rateLimit:()=>true,sandbox:sandbox(async()=>badBuild)}),'/api/sandbox/autofix',body);
    expect(denied.status).toBe(429);expect(await denied.json()).toMatchObject({error:'quota_exceeded'});expect(complete).not.toHaveBeenCalled();expect(await quota.usage('alice')).toMatchObject({used:10});
  });
});
