export type ProviderFailure = 'unavailable' | 'rate_limited' | 'authentication' | 'request' | 'quota' | 'timeout' | 'network' | 'protocol' | 'refusal' | 'attempt_limit';
const messages:Record<ProviderFailure,string>={
  unavailable:'AI provider je dočasne nedostupný. Skús to znova o chvíľu.',rate_limited:'AI provider teraz obmedzuje počet požiadaviek. Skús to neskôr.',
  authentication:'Vybraný AI model teraz nie je dostupný. Skús iný model alebo neskôr.',request:'Vybraný model túto požiadavku neprijal. Skús kratší kontext alebo iný model.',
  quota:'AI provider dosiahol prevádzkový limit. Skús to neskôr.',timeout:'AI odpoveď prekročila časový limit. Projekt zostal zachovaný.',
  network:'Spojenie s AI providerom sa prerušilo. Projekt zostal zachovaný.',protocol:'AI provider nevrátil úplnú platnú odpoveď. Projekt zostal zachovaný.',
  refusal:'AI provider túto požiadavku odmietol. Uprav zadanie a skús novú úlohu.',attempt_limit:'AI úloha dosiahla limit pokusov. Projekt zostal zachovaný.',
};
export class ProviderError extends Error {
  constructor(readonly kind:ProviderFailure,readonly retryAfterMs:number|null=null){super(messages[kind]);}
  get retryable(){return this.kind==='unavailable'||(this.kind==='rate_limited'&&this.retryAfterMs!==null);}
}
export function retryAfter(value:string|null,now=Date.now()):number|null{
  if(value===null)return null;
  const delay=/^\d+(?:\.\d+)?$/.test(value.trim())?Number(value)*1000:Date.parse(value)-now;
  return Number.isFinite(delay)&&delay>=0?delay:null;
}
