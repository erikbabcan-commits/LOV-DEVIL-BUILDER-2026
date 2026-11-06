import {contextGuardedProvider,DEFAULT_CONTEXT_WINDOW} from './contextBudget';
import {MistralProvider} from './mistral';
import {OpenAIProvider} from './openai';
import {AnthropicProvider} from './anthropic';
import {makeProviderTransport} from './http';
import {ProviderRegistry,type ModelEntry} from './registry';
import {safeModel} from '../usage/validation';
export function configuredProviders(env:Readonly<Record<string,string|undefined>>,fetcher:typeof fetch=fetch):ProviderRegistry{
  const entries:ModelEntry[]=[];
  const timeout=env.PROVIDER_TIMEOUT_MS===undefined?120_000:Number(env.PROVIDER_TIMEOUT_MS);
  if(!Number.isInteger(timeout)||timeout<100||timeout>120_000)throw new Error('invalid_provider_configuration');
  for(const vendor of ['mistral','openai','anthropic'] as const){
    const flag=env['AI_'+vendor.toUpperCase()+'_ENABLED'];
    if(flag!==undefined&&!['0','1'].includes(flag))throw new Error('invalid_provider_configuration');
    if(vendor==='mistral'?flag==='0':flag!=='1')continue;
    const prefix=vendor.toUpperCase(),key=env[prefix+'_API_KEY'],model=env[prefix+'_MODEL']??(vendor==='mistral'?'mistral-large-latest':undefined);
    if(!key){if(flag==='1')throw new Error('invalid_provider_configuration');continue;}
    if(!model||!safeModel(model)||/\s/.test(key))throw new Error('invalid_provider_configuration');
    const base=env[prefix+'_BASE_URL']??({mistral:'https://api.mistral.ai/v1',openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1'}[vendor]);
    const path={mistral:'/chat/completions',openai:'/responses',anthropic:'/messages'}[vendor];
    const transport=makeProviderTransport({apiKey:key,url:base.replace(/\/$/,'')+path,timeoutMs:timeout,...(vendor==='anthropic'?{headers:{'anthropic-version':'2026-10-21'}}:{})},fetcher);
    const provider=vendor==='mistral'?new MistralProvider({apiKey:key,model},transport):vendor==='openai'?new OpenAIProvider(model,transport):new AnthropicProvider(model,transport);
    const window=env[prefix+'_CONTEXT_WINDOW_TOKENS']===undefined?DEFAULT_CONTEXT_WINDOW:Number(env[prefix+'_CONTEXT_WINDOW_TOKENS']);
    entries.push({id:vendor,label:'AI ('+({mistral:'Mistral',openai:'OpenAI',anthropic:'Claude'}[vendor])+')',provider:contextGuardedProvider(provider,window)});
  }
  if(env.AI_DEFAULT_MODEL){const index=entries.findIndex(entry=>entry.id===env.AI_DEFAULT_MODEL);if(index<0)throw new Error('invalid_provider_configuration');entries.unshift(...entries.splice(index,1));}
  const fallbacks=env.AI_FALLBACK_MODELS?env.AI_FALLBACK_MODELS.split(',').map(s=>s.trim()):[];
  return new ProviderRegistry(entries,fallbacks);
}
