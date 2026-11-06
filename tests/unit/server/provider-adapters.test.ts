import type { ProviderTransport } from '../../../server/providers/types';
// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {OpenAIProvider} from '../../../server/providers/openai';
import {AnthropicProvider} from '../../../server/providers/anthropic';
import {configuredProviders} from '../../../server/providers/runtime';
import {assertProviderResponse,makeProviderTransport,providerEvents} from '../../../server/providers/http';
import {ProviderError} from '../../../server/providers/errors';
const messages=[{role:'system' as const,content:'system instructions'},{role:'user' as const,content:'Build a page'}];
const openai=(over:Record<string,unknown>={})=>({status:'completed',model:'openai-actual',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'first'},{type:'output_text',text:'second'}]}],usage:{input_tokens:11,output_tokens:7},...over});
const claude=(over:Record<string,unknown>={})=>({model:'claude-actual',stop_reason:'end_turn',content:[{type:'text',text:'hello'}],usage:{input_tokens:10,output_tokens:4,cache_creation_input_tokens:3,cache_read_input_tokens:2},...over});
const sse=(events:unknown[])=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
describe('direct stateless text provider adapters',()=>{
  it('uses Responses with storage disabled, separates instructions and captures all text outputs and usage',async()=>{
    const postChat=vi.fn<ProviderTransport['postChat']>(async()=>Response.json(openai())),provider=new OpenAIProvider('configured', {postChat});
    expect(await provider.complete(messages,{maxTokens:4096,temperature:0.1})).toMatchObject({text:'firstsecond',model:'openai-actual',usageReported:true,usage:{promptTokens:11,completionTokens:7}});
    expect(postChat.mock.calls[0][0]).toMatchObject({model:'configured',store:false,stream:false,input:[{role:'developer',content:'system instructions'},{role:'user',content:'Build a page'}],max_output_tokens:4096});
    expect(postChat.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
  it('accepts Responses max-output truncation and never retries a refusal or failed response as an outage',async()=>{
    const truncated=new OpenAIProvider('configured',{postChat:async()=>Response.json(openai({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}))});
    expect(await truncated.complete(messages)).toMatchObject({finishReason:'length'});
    for(const data of [openai({output:[{type:'message',content:[{type:'refusal',refusal:'private refusal'}]}]}),openai({status:'failed',error:{code:'private-provider-code'}})]){
      try{await new OpenAIProvider('configured',{postChat:async()=>Response.json(data)}).complete(messages);throw new Error('expected refusal');}
      catch(error){expect(error).toBeInstanceOf(ProviderError);expect((error as ProviderError).retryable).toBe(false);expect(String(error)).not.toContain('private');}
    }
  });
  it('keeps absent and malformed usage unknown for both adapters',async()=>{
    const a=await new OpenAIProvider('configured',{postChat:async()=>Response.json(openai({usage:{input_tokens:-1}}))}).complete(messages);
    const b=await new AnthropicProvider('configured',{postChat:async()=>Response.json(claude({usage:{output_tokens:2}}))}).complete(messages);
    expect(a.usageReported).toBe(false);expect(b.usageReported).toBe(false);
  });
  it('maps Claude messages, cache-inclusive reported input, output and truncation without echoing provider errors',async()=>{
    const postChat=vi.fn<ProviderTransport['postChat']>(async()=>Response.json(claude({stop_reason:'max_tokens'}))),provider=new AnthropicProvider('configured',{postChat});
    expect(await provider.complete(messages)).toMatchObject({text:'hello',finishReason:'length',model:'claude-actual',usage:{promptTokens:15,completionTokens:4}});
    expect(postChat.mock.calls[0][0]).toMatchObject({system:'system instructions',messages:[{role:'user',content:'Build a page'}],stream:false});
    await expect(new AnthropicProvider('configured',{postChat:async()=>Response.json(claude({stop_details:{type:'refusal'}}))}).complete(messages)).rejects.toMatchObject({kind:'refusal'});
  });
  it('parses OpenAI text deltas and the final cumulative usage, not reasoning text',async()=>{
    const provider=new OpenAIProvider('configured',{postChat:async()=>sse([{type:'response.created'},{type:'response.reasoning_text.delta',delta:'private reasoning'},{type:'response.output_text.delta',delta:'firstsecond'},{type:'response.completed',response:openai()}])});
    const chunks=[];for await(const chunk of provider.stream(messages))chunks.push(chunk);
    expect(chunks).toEqual([{delta:'firstsecond'},{model:'openai-actual',usage:{promptTokens:11,completionTokens:7},finishReason:'stop'}]);
  });
  it('accumulates Claude message start and cumulative delta usage once',async()=>{
    const provider=new AnthropicProvider('configured',{postChat:async()=>sse([
      {type:'message_start',message:{model:'claude-actual',usage:{input_tokens:10,output_tokens:1}}},
      {type:'content_block_delta',delta:{type:'thinking_delta',thinking:'not user output'}},
      {type:'content_block_delta',delta:{type:'text_delta',text:'hello'}},
      {type:'message_delta',usage:{output_tokens:4},delta:{stop_reason:'end_turn'}},{type:'message_stop'},
    ])});
    const chunks=[];for await(const chunk of provider.stream(messages))chunks.push(chunk);
    expect(chunks).toEqual([{delta:'hello',model:'claude-actual'},{model:'claude-actual',usage:{promptTokens:10,completionTokens:4},finishReason:'stop'}]);
  });
  it.each(['openai','anthropic'])('refuses truncated %s streams and never invents a terminal success',async kind=>{
    const transport={postChat:async()=>sse(kind==='openai'?[{type:'response.output_text.delta',delta:'partial'}]:[{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}])};
    const provider=kind==='openai'?new OpenAIProvider('configured',transport):new AnthropicProvider('configured',transport);
    await expect((async()=>{for await(const _chunk of provider.stream(messages)){/* consume */}})()).rejects.toMatchObject({kind:'protocol'});
  });
});
describe('single-attempt bounded HTTP transport and error classification',()=>{
  it.each([[401,'authentication'],[402,'quota'],[403,'authentication'],[422,'request'],[500,'unavailable'],[503,'unavailable'],[504,'timeout'],[529,'unavailable']] as const)('maps HTTP %i to %s without private response content',async(status,kind)=>{
    await expect(assertProviderResponse(Response.json({error:{message:'private-api-key'}},{status}))).rejects.toMatchObject({kind});
  });
  it('separates retryable 429 from quota caps and headerless 429',async()=>{
    await expect(assertProviderResponse(Response.json({error:{type:'rate_limit_error'}},{status:429,headers:{'retry-after':'2'}}))).rejects.toMatchObject({kind:'rate_limited',retryAfterMs:2000});
    try{await assertProviderResponse(Response.json({error:{code:'insufficient_quota'}},{status:429,headers:{'retry-after':'2'}}));}catch(error){expect((error as ProviderError).retryable).toBe(false);}
    try{await assertProviderResponse(Response.json({},{status:429}));}catch(error){expect((error as ProviderError).retryable).toBe(false);}
  });
  it('blocks redirects and invalid endpoints, performs one request and preserves cancellation',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({})),provider=makeProviderTransport({apiKey:'synthetic-key',url:'https://api.example.test/v1/responses',timeoutMs:1000},fetcher);
    const abort=new AbortController();await provider.postChat({model:'configured'},abort.signal);
    expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',method:'POST',headers:{Authorization:'Bearer synthetic-key'}});
    abort.abort();await expect(provider.postChat({},abort.signal)).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
    for(const url of ['http://localhost/path','https://user:password@example.test/path','https://example.test/path?key=secret'])expect(()=>makeProviderTransport({apiKey:'synthetic-key',url,timeoutMs:1000},fetcher)).toThrow();
  });
  it('cleans up the SSE reader on an early consumer break, handling split UTF-8 and CRLF',async()=>{
    const bytes=new TextEncoder().encode('data: {"delta":"žltý 🌍"}\r\n\r\n'),cancel=vi.fn();
    const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));},cancel}));
    for await(const event of providerEvents(response)){expect((event as {delta:string}).delta).toBe('žltý 🌍');break;}expect(cancel).toHaveBeenCalledOnce();
  });
  it('requires explicit enablement for new providers and never uses keys from unrelated environment by accident',()=>{
    const fetcher=vi.fn<typeof fetch>();expect(configuredProviders({OPENAI_API_KEY:'synthetic-key',ANTHROPIC_API_KEY:'synthetic-key'},fetcher).catalog().models).toEqual([]);
    const registry=configuredProviders({AI_OPENAI_ENABLED:'1',OPENAI_API_KEY:'synthetic-key',OPENAI_MODEL:'configured-openai',AI_ANTHROPIC_ENABLED:'1',ANTHROPIC_API_KEY:'synthetic-key',ANTHROPIC_MODEL:'configured-claude',AI_DEFAULT_MODEL:'anthropic',AI_FALLBACK_MODELS:'openai'},fetcher);
    expect(registry.catalog()).toMatchObject({defaultId:'anthropic',models:[{id:'anthropic',fallbackIds:['openai']},{id:'openai',fallbackIds:[]}]});expect(fetcher).not.toHaveBeenCalled();
    for(const env of [{AI_OPENAI_ENABLED:'1'},{AI_OPENAI_ENABLED:'1',OPENAI_API_KEY:'key'}, {AI_DEFAULT_MODEL:'unknown'},{AI_FALLBACK_MODELS:'openai'},{AI_OPENAI_ENABLED:'yes'}])expect(()=>configuredProviders(env)).toThrow('invalid_provider_configuration');
  });
  it('uses the current Claude version header and Bearer auth only on the server',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json(claude()));const registry=configuredProviders({AI_ANTHROPIC_ENABLED:'1',ANTHROPIC_API_KEY:'synthetic-key',ANTHROPIC_MODEL:'configured-claude'},fetcher);
    await registry.defaultProvider!.complete(messages);expect(fetcher.mock.calls[0][1]).toMatchObject({headers:{'anthropic-version':'2026-10-21',Authorization:'Bearer synthetic-key'}});
    expect(JSON.stringify(registry.catalog())).not.toContain('synthetic-key');
  });
});
