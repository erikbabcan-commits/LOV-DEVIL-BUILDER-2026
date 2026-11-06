import type {AIProvider,ChatMessage,CompletionChunk,CompletionResult,ProviderTransport} from './types';
import {ProviderError} from './errors';
import {assertProviderResponse,providerEvents,readJson,record} from './http';
import {safeModel,validUsage} from '../usage/validation';
export class OpenAIProvider implements AIProvider{
  readonly name='openai';
  constructor(readonly model:string,private readonly transport:ProviderTransport){}
  private body(messages:ChatMessage[],maxTokens:number|undefined,stream:boolean){
    return{model:this.model,input:messages.map(message=>({...message,role:message.role==='system'?'developer':message.role})),max_output_tokens:maxTokens??4096,store:false,stream};
  }
  private result(value:unknown):CompletionResult{
    const data=record(value);
    if(data.error||data.status==='failed')throw new ProviderError('protocol');
    const blocks=Array.isArray(data.output)?data.output.flatMap(item=>{
      const message=record(item);return message.type==='message'&&Array.isArray(message.content)?message.content.map(record):[];
    }):[];
    if(blocks.some(block=>block.type==='refusal'))throw new ProviderError('refusal');
    const text=blocks.filter(block=>block.type==='output_text'&&typeof block.text==='string').map(block=>block.text).join('');
    const length=data.status==='incomplete'&&record(data.incomplete_details).reason==='max_output_tokens';
    if(!text||(!length&&data.status!=='completed'))throw new ProviderError('protocol');
    const tokens=record(data.usage),usage={promptTokens:tokens.input_tokens,completionTokens:tokens.output_tokens};
    return{text,finishReason:length?'length':'stop',model:safeModel(data.model)??undefined,usage:validUsage(usage)?usage:{promptTokens:0,completionTokens:0},usageReported:validUsage(usage)};
  }
  async complete(messages:ChatMessage[],opts?:Parameters<AIProvider['complete']>[1]){
    const response=await this.transport.postChat(this.body(messages,opts?.maxTokens,false),opts?.signal);await assertProviderResponse(response);return this.result(await readJson(response));
  }
  async *stream(messages:ChatMessage[],opts?:Parameters<AIProvider['complete']>[1]):AsyncIterable<CompletionChunk>{
    const response=await this.transport.postChat(this.body(messages,opts?.maxTokens,true),opts?.signal);
    for await(const value of providerEvents(response)){
      const event=record(value);
      if(event.type==='response.output_text.delta'&&typeof event.delta==='string')yield{delta:event.delta};
      if(event.type==='response.refusal.delta')throw new ProviderError('refusal');
      if(event.type==='response.completed'||event.type==='response.incomplete'){
        const result=this.result(event.response);yield{model:result.model,...(result.usageReported?{usage:result.usage}:{}),finishReason:result.finishReason};return;
      }
      if(event.type==='error'||event.type==='response.failed')throw new ProviderError('protocol');
    }
    throw new ProviderError('protocol');
  }
}
