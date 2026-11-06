import type {AIProvider,ChatMessage} from './types';
export const DEFAULT_CONTEXT_WINDOW=65_536;
export class ContextBudgetError extends Error{
  constructor(){super('Kontext projektu prekračuje kapacitu vybraného modelu. Vyber model s väčším kontextom alebo zmenši projekt. Súbory sa neskrátili a projekt zostal zachovaný.');}
}
/** Conservative text units, not billable usage or a model-specific tokenizer.
 * UTF-8 JSON bytes plus protocol overhead; output capacity reserved separately. */
export function inputUnits(messages:ChatMessage[]):number{
  return Buffer.byteLength(JSON.stringify(messages),'utf8')+messages.length*128+512;
}
export function contextWindow(provider:Pick<AIProvider,'contextWindowTokens'>):number{return provider.contextWindowTokens??DEFAULT_CONTEXT_WINDOW;}
export function generationOutputBudget(provider:Pick<AIProvider,'contextWindowTokens'>):number{return Math.min(24_000,Math.floor(contextWindow(provider)/3));}
export function assertContextBudget(provider:Pick<AIProvider,'contextWindowTokens'>,messages:ChatMessage[],maxTokens:number):void{
  if(!Number.isSafeInteger(maxTokens)||maxTokens<1||inputUnits(messages)+maxTokens>contextWindow(provider))throw new ContextBudgetError();
}
/** Outside physical metering and resilience: no reservation/network/retry for a local overflow. */
export function contextGuardedProvider(base:AIProvider,window=contextWindow(base)):AIProvider{
  if(!Number.isInteger(window)||window<8192||window>2_000_000)throw new Error('invalid_provider_configuration');
  return{name:base.name,model:base.model,contextWindowTokens:window,
    async complete(messages,opts){assertContextBudget({contextWindowTokens:window},messages,opts?.maxTokens??4096);return base.complete(messages,opts);},
    async *stream(messages,opts){assertContextBudget({contextWindowTokens:window},messages,opts?.maxTokens??4096);yield*base.stream(messages,opts);},
  };
}
