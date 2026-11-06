// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryAiUsageStore } from '../../../server/usage/store';
import { InMemoryQuotaStore } from '../../../server/security/quotaStore';
import { meteredProvider } from '../../../server/usage/meter';
import { MistralProvider } from '../../../server/providers/mistral';
import { createApp, makeMockProvider } from '../../../server/index';
import { signToken } from '../../../server/auth/tokens';
const run = () => ({userId:'alice',id:randomUUID(),kind:'generation' as const});
const setup = async () => {
  const store = new InMemoryAiUsageStore(), item = run(), quota = new InMemoryQuotaStore();
  await store.admit(item,quota); return {store,item,quota};
};

describe('provider usage accounting',()=>{
  it('counts each physical completion once and records actual reported zero as known',async()=>{
    const {store,item}=await setup(),base=makeMockProvider();
    vi.spyOn(base,'complete').mockResolvedValue({text:'ok',model:'mistral-test',usage:{promptTokens:0,completionTokens:0}});
    const meter=meteredProvider(base,store,item);await meter.provider.complete([]);await meter.provider.complete([]);await meter.finish('succeeded');
    expect(await store.report('alice')).toMatchObject({calls:2,reportedCalls:2,unknownCalls:0,promptTokens:0});
    expect(await store.report('bob')).toMatchObject({calls:0});
  });
  it.each([undefined,{prompt_tokens:5},{prompt_tokens:-1,completion_tokens:4},{prompt_tokens:1.5,completion_tokens:4}])('does not substitute zero for missing or malformed Mistral usage %j',async usage=>{
    const {store,item}=await setup();
    const base=new MistralProvider({apiKey:'not-used',model:'alias'},{postChat:async()=>Response.json({model:'actual',choices:[{message:{content:'ok'}}],usage})});
    const result=await meteredProvider(base,store,item).provider.complete([]);
    expect(result.usageReported).toBe(false);expect(await store.report('alice')).toMatchObject({calls:1,reportedCalls:0,unknownCalls:1});
  });
  it('records failed provider calls without persisting its error, prompt or source',async()=>{
    const {store,item}=await setup(),base=makeMockProvider();vi.spyOn(base,'complete').mockRejectedValue(new Error('private-provider-secret'));
    await expect(meteredProvider(base,store,item).provider.complete([{role:'user',content:'private-project-source'}])).rejects.toThrow('private-provider-secret');
    const report=await store.report('alice');expect(report).toMatchObject({calls:1,unknownCalls:1,pendingCalls:0});expect(JSON.stringify(report)).not.toMatch(/private-/);
  });
  it('makes no provider call when reservation fails',async()=>{
    const {store,item}=await setup(),base=makeMockProvider(),complete=vi.spyOn(base,'complete');vi.spyOn(store,'startCall').mockRejectedValue(new Error('db-password'));
    await expect(meteredProvider(base,store,item).provider.complete([])).rejects.toThrow('Záznam spotreby');expect(complete).not.toHaveBeenCalled();
  });
  it('poisons a run after a post-response write failure and retains the prepared call',async()=>{
    const {store,item}=await setup(),base=makeMockProvider(),complete=vi.spyOn(base,'complete');vi.spyOn(store,'finishCall').mockRejectedValue(new Error('db-secret'));
    const meter=meteredProvider(base,store,item);await expect(meter.provider.complete([])).rejects.toThrow('Záznam spotreby');
    await expect(meter.provider.complete([])).rejects.toThrow('Záznam spotreby');await expect(meter.finish('succeeded')).rejects.toThrow('Záznam spotreby');
    expect(complete).toHaveBeenCalledOnce();expect(await store.report('alice')).toMatchObject({calls:1,pendingCalls:1,unknownCalls:1});
  });
  it('keeps completed token usage even when the consumer cancelled an uncooperative provider',async()=>{
    const {store,item}=await setup(),base=makeMockProvider(),abort=new AbortController();
    vi.spyOn(base,'complete').mockImplementation(async()=>{abort.abort();return {text:'ok',usage:{promptTokens:20,completionTokens:5}};});
    const meter=meteredProvider(base,store,item);await meter.provider.complete([],{signal:abort.signal});await meter.finish('cancelled');
    expect(await store.report('alice')).toMatchObject({reportedCalls:1,promptTokens:20,completionTokens:5});
  });
  it('does not invoke the provider when abort arrives while reserving',async()=>{
    const {store,item}=await setup(),base=makeMockProvider(),complete=vi.spyOn(base,'complete'),abort=new AbortController();
    const start=store.startCall.bind(store);vi.spyOn(store,'startCall').mockImplementation(async(...args)=>{const call=await start(...args);abort.abort();return call;});
    await expect(meteredProvider(base,store,item).provider.complete([],{signal:abort.signal})).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();expect(await store.report('alice')).toMatchObject({calls:0,unknownCalls:0});
  });
  it('collects usage-only final stream chunks and cancels the HTTP reader',async()=>{
    const {store,item}=await setup();let cancelled=false;
    const chunks=['data: '+JSON.stringify({model:'actual',choices:[{delta:{content:'ok'}}]})+'\r\n',
      'data: '+JSON.stringify({model:'actual',choices:[{finish_reason:'stop'}]})+'\r\n',
      'data: '+JSON.stringify({model:'actual',choices:[],usage:{prompt_tokens:15,completion_tokens:7}})+'\r\n','data: [DONE]\r\n'];
    const body=new ReadableStream({start(c){for(const text of chunks)c.enqueue(new TextEncoder().encode(text));},cancel(){cancelled=true;}});
    const base=new MistralProvider({apiKey:'unused',model:'alias'},{postChat:async()=>new Response(body)});
    const meter=meteredProvider(base,store,item),received=[];for await(const chunk of meter.provider.stream([]))received.push(chunk);
    await meter.finish('succeeded');expect(received.some(c=>c.delta==='ok')).toBe(true);expect(cancelled).toBe(true);
    expect(await store.report('alice')).toMatchObject({calls:1,reportedCalls:1,promptTokens:15,completionTokens:7});
  });
  it('retains unknown usage after an early stream consumer break',async()=>{
    const {store,item}=await setup();let closed=false;
    const base=makeMockProvider();base.stream=async function*(){try{yield {delta:'first'};yield {finishReason:'stop'};}finally{closed=true;}};
    const meter=meteredProvider(base,store,item);for await(const chunk of meter.provider.stream([])){expect(chunk.delta).toBe('first');break;}
    expect(closed).toBe(true);expect(await store.report('alice')).toMatchObject({calls:1,unknownCalls:1,pendingCalls:0});
  });
  it('bounds volatile admission before charging quota',async()=>{
    const store=new InMemoryAiUsageStore(undefined,1),quota=new InMemoryQuotaStore();await store.admit(run(),quota);
    await expect(store.admit(run(),quota)).rejects.toThrow();expect(await quota.usage('alice')).toMatchObject({used:1});
  });
});

describe('owner-only usage HTTP endpoint',()=>{
  const secret='usage-http-secret-01234567890123456789';
  const identityDb={query:async(sql:string,params?:unknown[])=>({rows:sql.includes('SELECT id, email, plan, plan_expires_at FROM users')&&['alice','bob'].includes(String(params?.[0]))?[{id:params![0],email:String(params![0])+'@example.test',plan:'free',plan_expires_at:null}]:[],rowCount:0})};
  const request=async(app:ReturnType<typeof createApp>,path='/api/ai-usage',user='alice')=>app.request(path,{headers:{Cookie:'lov_token='+await signToken({sub:user,email:user+'@example.test',plan:'free'},secret)}});
  it('returns no-store current-month totals, rejects queries, and never accepts owner parameters',async()=>{
    const {store,item,quota}=await setup();await meteredProvider(makeMockProvider(),store,item).provider.complete([]);
    const app=createApp({},null,{rateLimit:()=>true,auth:{db:identityDb,jwtSecret:secret,quota,usage:store}});
    const response=await request(app);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toMatchObject({calls:1,reportedCalls:1});
    expect(await(await request(app,undefined,'bob')).json()).toMatchObject({calls:0});expect((await request(app,'/api/ai-usage?owner=bob')).status).toBe(400);
    expect((await app.request('/api/ai-usage')).status).toBe(401);
  });
  it('returns generic unavailable rather than zero when storage fails',async()=>{
    const {store,quota}=await setup();vi.spyOn(store,'report').mockRejectedValue(new Error('db-private'));
    const app=createApp({},null,{auth:{db:identityDb,jwtSecret:secret,quota,usage:store}});
    const response=await request(app);expect(response.status).toBe(503);expect(await response.text()).not.toContain('db-private');
    expect((await createApp({},null).request('/api/ai-usage')).status).toBe(503);
  });
  it('fails authenticated inference closed by default if durable recording is unavailable',async()=>{
    const quota=new InMemoryQuotaStore(),base=makeMockProvider(),complete=vi.spyOn(base,'complete');
    const app=createApp({},base,{rateLimit:()=>true,auth:{db:identityDb,jwtSecret:secret,quota}});
    const token=await signToken({sub:'alice',email:'alice@example.test',plan:'free'},secret);
    const response=await app.request('/api/agent/generate',{method:'POST',headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify({projectId:'p',prompt:'Build a dashboard',mode:'create'})});
    expect(response.status).toBe(503);expect(complete).not.toHaveBeenCalled();expect(await quota.usage('alice')).toMatchObject({used:0});
  });
});
