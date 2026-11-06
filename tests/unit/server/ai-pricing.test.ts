// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePricePolicy, quoteUsage, readAiPricePolicy, formatMicroUsd } from '../../../server/usage/pricing';
const rate={provider:'mistral',model:'actual-2026',validFrom:'2026-11-01T00:00:00Z',validUntil:'2026-12-01T00:00:00Z',inputUsdPerMillion:'2',outputUsdPerMillion:'6'};
const document={schemaVersion:1,version:'test-price-v1',currency:'USD',basis:'uncached-text-tokens',rates:[rate]};
const policy=()=>parsePricePolicy(JSON.stringify(document));
const now=new Date('2026-11-06T00:00:00Z');
describe('versioned uncached-token cost estimates',()=>{
  it('uses exact integer micro USD and rounds up once for the combined input/output call',()=>{
    expect(quoteUsage(policy(),'mistral','actual-2026',now,{promptTokens:1200,completionTokens:200})).toMatchObject({status:'priced',estimatedCostMicrousd:'3600',rateIndex:0});
    const tiny=parsePricePolicy(JSON.stringify({...document,rates:[{...rate,inputUsdPerMillion:'0.000001',outputUsdPerMillion:'0.000001'}]}));
    expect(quoteUsage(tiny,'mistral','actual-2026',now,{promptTokens:1,completionTokens:1})).toMatchObject({estimatedCostMicrousd:'1'});
    expect(formatMicroUsd('3600')).toBe('0.003600');expect(formatMicroUsd('12345678901234567890')).toBe('12345678901234.567890');
  });
  it('keeps reported zero distinct from unknown usage and missing prices',()=>{
    expect(quoteUsage(policy(),'mistral','actual-2026',now,{promptTokens:0,completionTokens:0})).toMatchObject({status:'priced',estimatedCostMicrousd:'0'});
    expect(quoteUsage(policy(),'mistral','actual-2026',now,null)).toMatchObject({status:'unpriced',reason:'unknown_usage',estimatedCostMicrousd:null});
    expect(quoteUsage(null,'mistral','actual-2026',now,{promptTokens:0,completionTokens:0})).toMatchObject({status:'unpriced',reason:'no_policy'});
  });
  it('requires the exact reported provider/model and a rate effective at call start',()=>{
    for(const [provider,model] of [['other','actual-2026'],['mistral','requested-alias']]) expect(quoteUsage(policy(),provider,model,now,{promptTokens:1,completionTokens:1})).toMatchObject({reason:'no_effective_rate'});
    expect(quoteUsage(policy(),'mistral',null,now,{promptTokens:1,completionTokens:1})).toMatchObject({reason:'model_missing'});
    expect(quoteUsage(policy(),'mistral','actual-2026',new Date(rate.validFrom),{promptTokens:1,completionTokens:1}).status).toBe('priced');
    expect(quoteUsage(policy(),'mistral','actual-2026',new Date(rate.validUntil),{promptTokens:1,completionTokens:1})).toMatchObject({reason:'no_effective_rate'});
  });
  it('normalizes money, timestamps and rate order into a stable hash and freezes the snapshot',()=>{
    const second={...rate,model:'other',inputUsdPerMillion:'3.5'};
    const a=parsePricePolicy(JSON.stringify({...document,rates:[rate,second]}));
    const b=parsePricePolicy(JSON.stringify({...document,rates:[{...second,inputUsdPerMillion:'3.500000'}, {...rate,validFrom:'2026-11-01T00:00:00.000Z',inputUsdPerMillion:'2.000000'}]}));
    expect(a.fingerprint).toBe(b.fingerprint);expect(Object.isFrozen(a.document.rates[0])).toBe(true);
    expect(()=>{a.document.version='mutated';}).toThrow();
    expect(parsePricePolicy(JSON.stringify({...document,version:'v2'})).fingerprint).not.toBe(policy().fingerprint);
  });
  it.each(['-1','1e3','01','0.0000001','10000.000001','NaN','Infinity'])('rejects invalid or excessive prices %s',price=>{
    expect(()=>parsePricePolicy(JSON.stringify({...document,rates:[{...rate,inputUsdPerMillion:price}]}))).toThrow('invalid_ai_price_policy');
  });
  it.each([
    {...document,extra:'private-token'}, {...document,currency:'EUR'}, {...document,basis:'all-invoice-costs'}, {...document,rates:[]},
    {...document,rates:[rate,rate]}, {...document,rates:[{...rate,validUntil:rate.validFrom}]},
    {...document,rates:[{...rate,model:'mstrl_'+'a'.repeat(32)}]}, {...document,rates:[{...rate,validFrom:'not-a-date'}]},
  ])('rejects malformed policies without echoing values',input=>{
    expect(()=>parsePricePolicy(JSON.stringify(input))).toThrow(/^invalid_ai_price_policy$/);
  });
  it('permits adjacent rate windows and handles maximum supported counts exactly',()=>{
    const p=parsePricePolicy(JSON.stringify({...document,rates:[{...rate,inputUsdPerMillion:'10000',outputUsdPerMillion:'10000'},{...rate,validFrom:'2026-12-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z'}]}));
    expect(quoteUsage(p,'mistral','actual-2026',now,{promptTokens:1_000_000_000,completionTokens:1_000_000_000})).toMatchObject({estimatedCostMicrousd:'20000000000000'});
    expect(quoteUsage(p,'mistral','actual-2026',new Date(rate.validUntil),{promptTokens:1,completionTokens:1})).toMatchObject({estimatedCostMicrousd:'8'});
  });
  it('defaults to no policy and refuses oversized or secret-bearing configuration',()=>{
    expect(readAiPricePolicy({})).toBeNull();expect(readAiPricePolicy({AI_PRICE_POLICY_JSON:' '})).toBeNull();
    expect(()=>readAiPricePolicy({AI_PRICE_POLICY_JSON:'secret-not-json'})).toThrow(/^invalid_ai_price_policy$/);
    expect(()=>parsePricePolicy(' '.repeat(65_537))).toThrow(/^invalid_ai_price_policy$/);
  });
});
