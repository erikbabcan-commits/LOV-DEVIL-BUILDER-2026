import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiNotConfiguredError, AiRequestError, streamAgentEvents } from '../../src/services/ai/client';
import { AI_QUOTA_CHANGED } from '../../src/services/ai/usage';
const input={projectId:'test',prompt:'Small dashboard',mode:'create' as const,context:{files:[],history:[]}};
const collect=async(signal=new AbortController().signal)=>{const events=[];for await(const event of streamAgentEvents(input,signal))events.push(event);return events;};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('AI client limits and SSE lifecycle',()=>{
  it.each([
    [429,'quota_exceeded','quota_exceeded'],[429,'rate_limit','rate_limit'],[429,'BUDGET_EXCEEDED','run_budget'],
    [503,'quota_unavailable','quota_unavailable'],[503,'ai_disabled','ai_disabled'],[503,'unrecognized','service_unavailable'],
    [413,'context_limit','context_limit'],[400,'secret_in_context','secret_in_context'],[401,'unauthenticated','login_required'],[403,'csrf_required','access_denied'],[400,'bad_request','invalid_request'],[413,'agent_input_limit','input_limit'],
  ] as const)('maps HTTP %s/%s to a useful bounded error',async(status,error,code)=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error,message:'private-server-secret'}, {status})));
    const result=collect();await expect(result).rejects.toMatchObject({code});
    await expect(result).rejects.not.toThrow('private-server-secret');
  });
  it('treats only explicit missing-provider configuration as AiNotConfiguredError',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:'ai_not_configured'},{status:503})));
    await expect(collect()).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
  it('decodes UTF-8 and CRLF split across chunks and recognizes a completed response',async()=>{
    const bytes=new TextEncoder().encode('data: {"type":"run_started","runId":"one","model":"Žltý 🌍"}\r\n\r\ndata: {"type":"done","runId":"one","summary":"Ready"}\r\n\r\n');
    const response=new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}}));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
    expect(await collect()).toEqual([{type:'run_started',runId:'one',model:'Žltý 🌍'},{type:'done',runId:'one',summary:'Ready'}]);
  });
  it('does not silently accept a truncated response without a terminal event',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('data: {"type":"run_started","runId":"one","model":"test"}\n\n')));
    await expect(collect()).rejects.toMatchObject({code:'stream_interrupted',retriable:true});
  });
  it('cancels the underlying stream when the consumer stops early',async()=>{
    const cancel=vi.fn();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"type":"run_started","runId":"one","model":"test"}\n\n'));},cancel}))));
    for await(const event of streamAgentEvents(input,new AbortController().signal)){expect(event.type).toBe('run_started');break;}
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('announces quota change after accepted or quota-denied requests without exposing event data',async()=>{
    const listener=vi.fn();window.addEventListener(AI_QUOTA_CHANGED,listener);
    try{
      vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('data: {"type":"done","runId":"one","summary":"Ready"}\n\n')).mockResolvedValueOnce(Response.json({error:'quota_exceeded'},{status:429})));
      await collect();await expect(collect()).rejects.toBeInstanceOf(AiRequestError);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls.every(([event])=>!('detail' in event))).toBe(true);
    }finally{window.removeEventListener(AI_QUOTA_CHANGED,listener);}
  });
});
