// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import type {AIProvider,CompletionChunk} from '../../../server/providers/types';
import {ProviderError,retryAfter} from '../../../server/providers/errors';
import {resilientProvider,type ProviderUpdate} from '../../../server/providers/resilience';
import {makeMockProvider,createApp} from '../../../server/index';
import {ProviderRegistry} from '../../../server/providers/registry';
import {InMemoryAiUsageStore} from '../../../server/usage/store';
import {InMemoryQuotaStore} from '../../../server/security/quotaStore';
import {createProviderRun} from '../../../server/providers/run';
const result={text:'done',model:'actual',usage:{promptTokens:10,completionTokens:5}};
function stub(name='primary'):AIProvider{return{name,model:name+'-model',complete:vi.fn().mockResolvedValue(result),stream:async function*(){yield{delta:'ok'};yield{finishReason:'stop'};}};}
const options=()=>({sleep:vi.fn(async()=>{}),random:()=>0});
describe('bounded and fully metered provider retry',()=>{
  it('retries explicit transient rejection, honors delay and emits safe status',async()=>{
    const base=stub(),events:ProviderUpdate[]=[],opts=options();vi.mocked(base.complete).mockRejectedValueOnce(new ProviderError('unavailable',1500));
    const provider=resilientProvider([base],{...opts,onUpdate:e=>events.push(e)});
    expect(await provider.complete([])).toEqual(result);expect(base.complete).toHaveBeenCalledTimes(2);expect(opts.sleep).toHaveBeenCalledWith(1500,undefined);
    expect(events).toMatchObject([{type:'provider_update',reason:'retry',attempt:2,maxAttempts:2}]);
  });
  it.each(['authentication','request','quota','timeout','network','protocol','refusal','attempt_limit'] as const)('never repeats or changes provider after %s',async kind=>{
    const primary=stub(),fallback=stub('backup');vi.mocked(primary.complete).mockRejectedValue(new ProviderError(kind));
    await expect(resilientProvider([primary,fallback],options()).complete([])).rejects.toThrow();expect(primary.complete).toHaveBeenCalledOnce();expect(fallback.complete).not.toHaveBeenCalled();
  });
  it('does not treat an opaque rate limit or untyped exception as transient',async()=>{
    for(const error of [new ProviderError('rate_limited'),new Error('HTTP 503 private upstream details')]){
      const base=stub();vi.mocked(base.complete).mockRejectedValue(error);await expect(resilientProvider([base],options()).complete([])).rejects.toThrow();expect(base.complete).toHaveBeenCalledOnce();
    }
  });
  it('moves to an opted-in backup and keeps the successful provider for later batches',async()=>{
    const primary=stub(),fallback=stub('backup'),events:ProviderUpdate[]=[];vi.mocked(primary.complete).mockRejectedValue(new ProviderError('unavailable'));
    const provider=resilientProvider([primary,fallback],{...options(),onUpdate:e=>events.push(e)});await provider.complete([]);await provider.complete([]);
    expect(primary.complete).toHaveBeenCalledTimes(2);expect(fallback.complete).toHaveBeenCalledTimes(2);expect(events.map(e=>e.reason)).toEqual(['retry','fallback']);
  });
  it('does not retry earlier than a long Retry-After; it can only use a separately permitted backup',async()=>{
    const base=stub(),fallback=stub('backup'),opts=options();vi.mocked(base.complete).mockRejectedValue(new ProviderError('rate_limited',60000));
    await expect(resilientProvider([base],opts).complete([])).rejects.toThrow();expect(base.complete).toHaveBeenCalledOnce();expect(opts.sleep).not.toHaveBeenCalled();
    await resilientProvider([base,fallback],opts).complete([]);expect(fallback.complete).toHaveBeenCalledOnce();
  });
  it('bounds additional attempts across all completions in the same run',async()=>{
    const base=stub();let calls=0;vi.mocked(base.complete).mockImplementation(async()=>{if(++calls%2)throw new ProviderError('unavailable');return result;});
    const provider=resilientProvider([base],options());for(let i=0;i<6;i++)await provider.complete([]);
    await expect(provider.complete([])).rejects.toThrow();expect(base.complete).toHaveBeenCalledTimes(13);
  });
  it('never replays a partially exposed stream',async()=>{
    const primary=stub(),fallback=stub('backup'),called=vi.spyOn(fallback,'stream');let starts=0;
    primary.stream=async function*(){starts++;yield{delta:'partial'};throw new ProviderError('unavailable');};
    const received:CompletionChunk[]=[];await expect((async()=>{for await(const chunk of resilientProvider([primary,fallback],options()).stream([]))received.push(chunk);})()).rejects.toThrow();
    expect(starts).toBe(1);expect(called).not.toHaveBeenCalled();expect(received).toEqual([{delta:'partial'}]);
  });
  it('stops before another inference when cancellation arrives in backoff',async()=>{
    const base=stub(),abort=new AbortController();vi.mocked(base.complete).mockRejectedValue(new ProviderError('unavailable'));
    const sleep=vi.fn(async()=>{abort.abort();abort.signal.throwIfAborted();});
    await expect(resilientProvider([base],{sleep}).complete([],{signal:abort.signal})).rejects.toThrow();expect(base.complete).toHaveBeenCalledOnce();
  });
  it('meters each physical call with its own provider and stops all providers after ledger failure',async()=>{
    const store=new InMemoryAiUsageStore(),quota=new InMemoryQuotaStore(),run={userId:'alice',id:crypto.randomUUID(),kind:'generation' as const};await store.admit(run,quota);
    const primary=stub(),fallback=stub('backup');vi.mocked(primary.complete).mockRejectedValue(new ProviderError('unavailable'));
    const start=vi.spyOn(store,'startCall'),meter=createProviderRun([{id:'a',label:'A',provider:primary},{id:'b',label:'B',provider:fallback}],store,run,options());
    await meter.provider.complete([]);await meter.finish('succeeded');expect(start.mock.calls.map(call=>call[1])).toEqual(['primary','primary','backup']);
    expect(await store.report('alice')).toMatchObject({calls:3,reportedCalls:1,unknownCalls:2});expect(await quota.usage('alice')).toMatchObject({used:1});
    const next={...run,id:crypto.randomUUID()};await store.admit(next,quota);vi.spyOn(store,'finishCall').mockRejectedValue(new Error('private-ledger-error'));
    const failed=createProviderRun([{id:'a',label:'A',provider:primary},{id:'b',label:'B',provider:fallback}],store,next,options());
    const before=vi.mocked(fallback.complete).mock.calls.length;await expect(failed.provider.complete([])).rejects.toThrow('Záznam spotreby');await expect(failed.finish('failed')).rejects.toThrow();expect(fallback.complete).toHaveBeenCalledTimes(before);
  });
  it('validates model selection and exact fallback recipients before admission',async()=>{
    const a=makeMockProvider(),b=stub('backup'),ids=['b'];const registry=new ProviderRegistry([{id:'a',label:'AI A',provider:a},{id:'b',label:'AI B',provider:b}],ids);ids.push('a');
    expect(registry.route('a')).toHaveLength(1);expect(()=>registry.route('a',true)).toThrow();expect(()=>registry.route('a',true,['other'])).toThrow();expect(registry.route('a',true,['b'])).toHaveLength(2);
    const app=createApp({},a,{providers:registry,rateLimit:()=>true});const response=await app.request('/api/agent/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:'p',prompt:'hello',modelId:'a',allowFallback:true,fallbackIds:['other']})});expect(response.status).toBe(400);
    const catalog=await app.request('/api/ai-models');expect(catalog.headers.get('cache-control')).toBe('no-store');expect(await catalog.json()).toMatchObject({defaultId:'a',models:[{id:'a',fallbackIds:['b']},{id:'b',fallbackIds:[]}]});
    expect((await app.request('/api/ai-models?owner=other')).status).toBe(400);
  });
  it('parses Retry-After seconds and HTTP dates without negative or non-finite delays',()=>{
    expect(retryAfter('1.25')).toBe(1250);expect(retryAfter('Thu, 01 Jan 1970 00:00:05 GMT',1000)).toBe(4000);expect(retryAfter('invalid')).toBeNull();expect(retryAfter('-5')).toBeNull();
  });
});
