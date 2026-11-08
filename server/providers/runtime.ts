import {contextGuardedProvider,DEFAULT_CONTEXT_WINDOW} from './contextBudget';
import {MistralProvider} from './mistral';
import {OpenAIProvider} from './openai';
import {AnthropicProvider} from './anthropic';
import {makeProviderTransport,readJson,record} from './http';
import {ProviderRegistry,type ModelEntry} from './registry';
import {safeModel} from '../usage/validation';
type ProviderEnv = Readonly<Record<string, string | undefined>>;
const MISTRAL_BASE = 'https://api.mistral.ai/v1';
const MISTRAL_BASES = new Set([MISTRAL_BASE, 'https://api.eu.mistral.ai/v1', 'https://api.us.mistral.ai/v1']);
const MISTRAL_CHOICES = [
  { id: 'mistral-medium-2604', label: 'Mistral Medium' },
  { id: 'mistral-small-2603', label: 'Mistral Small' },
] as const;
type MistralChoice = (typeof MISTRAL_CHOICES)[number] & { window: number };

export function configuredProviders(env:ProviderEnv,fetcher:typeof fetch=fetch):ProviderRegistry{
  return buildRegistry(env, fetcher, []);
}

function buildRegistry(env:ProviderEnv, fetcher:typeof fetch, mistralChoices: readonly MistralChoice[]):ProviderRegistry{
  const entries:ModelEntry[]=[];
  const extraEntries:ModelEntry[]=[];
  const timeout=env.PROVIDER_TIMEOUT_MS===undefined?120_000:Number(env.PROVIDER_TIMEOUT_MS);
  if(!Number.isInteger(timeout)||timeout<100||timeout>120_000)throw new Error('invalid_provider_configuration');
  for(const vendor of ['mistral','openai','anthropic'] as const){
    const flag=env['AI_'+vendor.toUpperCase()+'_ENABLED'];
    if(flag!==undefined&&!['0','1'].includes(flag))throw new Error('invalid_provider_configuration');
    if(vendor==='mistral'?flag==='0':flag!=='1')continue;
    const prefix=vendor.toUpperCase(),key=env[prefix+'_API_KEY'],model=env[prefix+'_MODEL']??(vendor==='mistral'?'mistral-large-latest':undefined);
    if(!key){if(flag==='1')throw new Error('invalid_provider_configuration');continue;}
    if(!model||!safeModel(model)||/\s/.test(key))throw new Error('invalid_provider_configuration');
    const base=env[prefix+'_BASE_URL']??({mistral:MISTRAL_BASE,openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1'}[vendor]);
    const path={mistral:'/chat/completions',openai:'/responses',anthropic:'/messages'}[vendor];
    const transport=makeProviderTransport({apiKey:key,url:base.replace(/\/$/,'')+path,timeoutMs:timeout,...(vendor==='anthropic'?{headers:{'anthropic-version':'2026-10-21'}}:{})},fetcher);
    const provider=vendor==='mistral'?new MistralProvider({apiKey:key,model},transport):vendor==='openai'?new OpenAIProvider(model,transport):new AnthropicProvider(model,transport);
    const window=env[prefix+'_CONTEXT_WINDOW_TOKENS']===undefined?DEFAULT_CONTEXT_WINDOW:Number(env[prefix+'_CONTEXT_WINDOW_TOKENS']);
    entries.push({id:vendor,label:'AI ('+({mistral:'Mistral',openai:'OpenAI',anthropic:'Claude'}[vendor])+')',provider:contextGuardedProvider(provider,window)});
    if (vendor === 'mistral') {
      for (const choice of mistralChoices) {
        const extra = new MistralProvider({ apiKey: key, model: choice.id }, transport);
        extraEntries.push({ id: choice.id, label: choice.label, provider: contextGuardedProvider(extra, Math.min(window, choice.window)) });
      }
    }
  }
  if(env.AI_DEFAULT_MODEL){const index=entries.findIndex(entry=>entry.id===env.AI_DEFAULT_MODEL);if(index<0)throw new Error('invalid_provider_configuration');entries.unshift(...entries.splice(index,1));}
  const fallbacks=env.AI_FALLBACK_MODELS?env.AI_FALLBACK_MODELS.split(',').map(s=>s.trim()):[];
  return new ProviderRegistry([...entries, ...extraEntries],fallbacks);
}

/** Adds optional picker entries only when the configured key can see them in the official catalog. */
export async function configuredProvidersWithMistralCatalog(env: ProviderEnv, fetcher: typeof fetch = fetch): Promise<ProviderRegistry> {
  const baseline = configuredProviders(env, fetcher);
  const { models } = baseline.catalog();
  const primary = models.find(model => model.id === 'mistral');
  const base = (env.MISTRAL_BASE_URL ?? MISTRAL_BASE).replace(/\/$/, '');
  const availableSlots = 3 - models.length;
  if (!primary || !availableSlots || !MISTRAL_BASES.has(base)) return baseline;
  let choices: MistralChoice[];
  try {
    const response = await fetcher(base + '/models', {
      headers: { Authorization: 'Bearer ' + env.MISTRAL_API_KEY },
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return baseline;
    }
    const data = record(await readJson(response, 1_000_000)).data;
    if (!Array.isArray(data)) return baseline;
    const cards = data.map(record);
    choices = MISTRAL_CHOICES.flatMap(choice => {
      const card = cards.find(entry => entry.id === choice.id);
      if (!card || card.archived === true || record(card.capabilities).completion_chat !== true ||
          primary.model === choice.id || (Array.isArray(card.aliases) && card.aliases.includes(primary.model))) return [];
      const window = card.max_context_length;
      if (typeof window !== 'number' || !Number.isInteger(window) || window < 8192) return [];
      return [{ ...choice, window }];
    }).slice(0, availableSlots);
  } catch {
    return baseline;
  }
  return choices.length ? buildRegistry(env, fetcher, choices) : baseline;
}
