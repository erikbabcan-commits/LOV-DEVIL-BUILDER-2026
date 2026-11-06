import type {AIProvider,CompletionChunk} from './types';
import {ProviderError} from './errors';
export interface ProviderUpdate{type:'provider_update';reason:'retry'|'fallback';provider:string;model:string;attempt:number;maxAttempts:number;message:string}
export interface ResilienceOptions{onUpdate?:(event:ProviderUpdate)=>void;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>;random?:()=>number}
async function sleep(ms:number,signal?:AbortSignal){
  signal?.throwIfAborted();await new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('aborted'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
  });
}
/** Retry orchestration sits OUTSIDE physical metering. Only explicit transient
 * HTTP rejections qualify; never replay partial streams, refusals, ambiguous
 * network/timeouts, malformed model output or bookkeeping failures. */
export function resilientProvider(providers:AIProvider[],options:ResilienceOptions={}):AIProvider{
  if(!providers.length||providers.length>3)throw new Error('invalid_provider_route');
  let active=0,physical=0,extra=0;
  const delay=options.sleep??sleep,random=options.random??Math.random;
  async function* attempts(signal?:AbortSignal){
    const sequence=[active,active,...providers.map((_,i)=>i).filter(i=>i>active)];
    let prior:ProviderError|undefined,localAttempts=0;
    for(let step=0;step<sequence.length;step++){
      signal?.throwIfAborted();const index=sequence[step],provider=providers[index];
      if(step>0){
        if(!prior?.retryable||extra>=6)throw prior??new ProviderError('attempt_limit');
        const same=index===sequence[step-1],backoff=Math.max(250+Math.floor(Math.max(0,Math.min(1,random()))*125),prior.retryAfterMs??0);
        if(same&&backoff>5000)continue;
        extra++;
        options.onUpdate?.({type:'provider_update',reason:same?'retry':'fallback',provider:provider.name,model:provider.model,attempt:localAttempts+1,maxAttempts:sequence.length,
          message:same?'AI provider má dočasný výpadok. Opakujem požiadavku.':'AI provider je nedostupný. Skúšam povolený záložný model.'});
        if(same)await delay(backoff,signal);
      }
      signal?.throwIfAborted();if(physical>=128)throw new ProviderError('attempt_limit');physical++;localAttempts++;
      yield{provider,index,fail:(error:unknown)=>{if(!(error instanceof ProviderError)||!error.retryable)throw error;prior=error;},success:()=>{active=index;}};
    }
    throw prior??new ProviderError('attempt_limit');
  }
  return{
    name:providers[0].name,model:providers[0].model,
    async complete(messages,opts){for await(const attempt of attempts(opts?.signal)){try{const result=await attempt.provider.complete(messages,opts);attempt.success();return result;}catch(error){attempt.fail(error);}}throw new ProviderError('unavailable');},
    async *stream(messages,opts):AsyncIterable<CompletionChunk>{
      for await(const attempt of attempts(opts?.signal)){
        let exposed=false;
        try{for await(const chunk of attempt.provider.stream(messages,opts)){exposed=true;yield chunk;}attempt.success();return;}
        catch(error){if(exposed)throw error;attempt.fail(error);}
      }
    },
  };
}
