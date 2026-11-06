import type {ProviderTransport} from './types';
import {ProviderError,retryAfter} from './errors';

export function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
export async function readJson(response:Response,maxBytes=16_000_000):Promise<unknown>{
  if(!response.body)throw new ProviderError('protocol');
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
  try{
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)throw new ProviderError('protocol');text+=decoder.decode(part.value,{stream:true});}
    text+=decoder.decode();return JSON.parse(text);
  }catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('protocol');}
  finally{try{await reader.cancel();}catch{/* preserve failure */}reader.releaseLock();}
}
export async function assertProviderResponse(response:Response):Promise<void>{
  if(response.ok)return;
  let code:unknown;
  try{const error=record(record(await readJson(response,8192)).error);code=error.code??error.type;}catch{/* status remains authoritative */}
  if(['insufficient_quota','billing_error','usage_limit_reached','spend_limit_exceeded'].includes(String(code))||response.status===402)throw new ProviderError('quota');
  if(code==='timeout_error'||[408,504].includes(response.status))throw new ProviderError('timeout');
  if([401,403].includes(response.status))throw new ProviderError('authentication');
  if(response.status===429)throw new ProviderError('rate_limited',retryAfter(response.headers.get('retry-after')));
  if([500,502,503,529].includes(response.status))throw new ProviderError('unavailable',retryAfter(response.headers.get('retry-after')));
  throw new ProviderError('request');
}
/** Single HTTP attempt, no hidden retries, redirects or browser-owned headers. */
export function makeProviderTransport(config:{apiKey:string;url:string;timeoutMs:number;headers?:Record<string,string>},fetcher:typeof fetch=fetch):ProviderTransport{
  const url=new URL(config.url);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new Error('invalid_provider_endpoint');
  if(!Number.isFinite(config.timeoutMs)||config.timeoutMs<100||config.timeoutMs>120_000)throw new Error('invalid_provider_timeout');
  return{async postChat(body,signal){
    signal?.throwIfAborted();const timeout=AbortSignal.timeout(config.timeoutMs),merged=signal?AbortSignal.any([signal,timeout]):timeout;
    try{return await fetcher(config.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.apiKey,...config.headers},body:JSON.stringify(body),signal:merged});}
    catch{if(signal?.aborted)signal.throwIfAborted();throw new ProviderError(timeout.aborted?'timeout':'network');}
  }};
}
/** Complete SSE records, bounded UTF-8 buffering, CRLF and reader cleanup. */
export async function* providerEvents(response:Response):AsyncGenerator<unknown>{
  await assertProviderResponse(response);if(!response.body)throw new ProviderError('protocol');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
  function parse(record:string){const data=record.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return null;if(data==='[DONE]')return 'done';try{return JSON.parse(data);}catch{throw new ProviderError('protocol');}}
  try{
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32_000_000)throw new ProviderError('protocol');
      buffer+=decoder.decode(part.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');if(buffer.length>8_000_000)throw new ProviderError('protocol');
      let index:number;while((index=buffer.indexOf('\n\n'))>=0){const item=parse(buffer.slice(0,index));buffer=buffer.slice(index+2);if(item==='done')return;if(item)yield item;}
    }
    buffer+=decoder.decode();if(buffer.trim()){const item=parse(buffer.replace(/\r\n/g,'\n'));if(item&&item!=='done')yield item;}
  }catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError('protocol');}
  finally{try{await reader.cancel();}catch{/* preserve original failure */}reader.releaseLock();}
}
