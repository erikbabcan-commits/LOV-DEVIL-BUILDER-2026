import type {AIProvider,ChatMessage,CompletionChunk,CompletionResult,ProviderTransport} from './types';
import {ProviderError} from './errors';
import {assertProviderResponse,providerEvents,readJson,record} from './http';
import {safeModel,validUsage} from '../usage/validation';
export class AnthropicProvider implements AIProvider{
  readonly name='anthropic';
  constructor(readonly model:string,private readonly transport:ProviderTransport){}
  private body(messages:ChatMessage[],maxTokens:number|undefined,stream:boolean){return{model:this.model,
    system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n'),messages:messages.filter(m=>m.role!=='system'),max_tokens:maxTokens??4096,stream};}
  private finish(reason:unknown){if(reason==='max_tokens')return 'length' as const;if(reason==='end_turn'||reason==='stop_sequence')return 'stop' as const;if(reason==='refusal')throw new ProviderError('refusal');throw new ProviderError('protocol');}
  private usage(value:unknown){
    const data=record(value),input=[data.input_tokens,data.cache_creation_input_tokens??0,data.cache_read_input_tokens??0];
    const usage={promptTokens:input.reduce<number>((sum,n)=>sum+(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:NaN),0),completionTokens:data.output_tokens};
    return validUsage(usage)?usage:null;
  }
  async complete(messages:ChatMessage[],opts?:Parameters<AIProvider['complete']>[1]):Promise<CompletionResult>{
    const response=await this.transport.postChat(this.body(messages,opts?.maxTokens,false),opts?.signal);await assertProviderResponse(response);const data=record(await readJson(response));
    if(record(data.stop_details).type==='refusal')throw new ProviderError('refusal');
    const text=Array.isArray(data.content)?data.content.map(record).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join(''):'';
    if(!text)throw new ProviderError('protocol');const usage=this.usage(data.usage);
    return{text,model:safeModel(data.model)??undefined,finishReason:this.finish(data.stop_reason),usage:usage??{promptTokens:0,completionTokens:0},usageReported:usage!==null};
  }
  async *stream(messages:ChatMessage[],opts?:Parameters<AIProvider['complete']>[1]):AsyncIterable<CompletionChunk>{
    const response=await this.transport.postChat(this.body(messages,opts?.maxTokens,true),opts?.signal);
    let model:string|undefined,usage:Record<string,unknown>={},reason:unknown;
    for await(const value of providerEvents(response)){
      const event=record(value),delta=record(event.delta);
      if(event.type==='message_start'){const message=record(event.message);model=safeModel(message.model)??undefined;usage={...record(message.usage)};}
      if(event.type==='content_block_delta'&&delta.type==='text_delta'&&typeof delta.text==='string')yield{delta:delta.text,model};
      if(event.type==='message_delta'){usage={...usage,...record(event.usage)};reason=delta.stop_reason??reason;if(record(delta.stop_details).type==='refusal')throw new ProviderError('refusal');}
      if(event.type==='error')throw new ProviderError('protocol');
      if(event.type==='message_stop'){const valid=this.usage(usage);yield{model,...(valid?{usage:valid}:{}),finishReason:this.finish(reason)};return;}
    }
    throw new ProviderError('protocol');
  }
}
