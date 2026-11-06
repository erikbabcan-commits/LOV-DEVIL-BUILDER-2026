import { createHash } from 'node:crypto';
import { z } from 'zod';
import { safeModel, validUsage, type TokenUsage } from './validation';

const label = z.string().min(1).max(128).refine(value => safeModel(value) !== null);
const money = z.string().regex(/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,6})?$/).refine(value => Number(value) <= 10_000);
const timestamp = z.string().datetime().refine(value => Number.isFinite(Date.parse(value)));
const rateSchema = z.object({
  provider: label, model: label, validFrom: timestamp, validUntil: timestamp,
  inputUsdPerMillion: money, outputUsdPerMillion: money,
}).strict().refine(rate => Date.parse(rate.validFrom) < Date.parse(rate.validUntil));
const policySchema = z.object({ schemaVersion: z.literal(1), version: label.max(64), currency: z.literal('USD'),
  basis: z.literal('uncached-text-tokens'), rates: z.array(rateSchema).min(1).max(128),
}).strict().superRefine((policy, context) => {
  for (let i=0;i<policy.rates.length;i++) for (let j=0;j<i;j++) {
    const a=policy.rates[i],b=policy.rates[j];
    if (a.provider===b.provider && a.model===b.model && Date.parse(a.validFrom)<Date.parse(b.validUntil) && Date.parse(b.validFrom)<Date.parse(a.validUntil))
      context.addIssue({code:'custom',message:'overlapping_rates'});
  }
});
export type PricePolicyDocument = z.infer<typeof policySchema>;
export interface PricePolicy { readonly fingerprint: string; readonly document: PricePolicyDocument }
export class PricePolicyError extends Error { constructor() { super('invalid_ai_price_policy'); } }
const million=1_000_000n;
function rateMicros(value: string): bigint {
  const [whole, fraction='']=value.split('.'); return BigInt(whole)*million+BigInt(fraction.padEnd(6,'0'));
}
function normalizedMoney(value: string): string {
  const micros=rateMicros(value);return (micros/million).toString()+'.'+(micros%million).toString().padStart(6,'0');
}
/** Validate and copy configuration. Never retain mutable caller input. */
export function parsePricePolicy(raw: string): PricePolicy {
  try {
    if (Buffer.byteLength(raw,'utf8')>65_536) throw new PricePolicyError();
    const document=policySchema.parse(JSON.parse(raw));
    document.rates=document.rates.map(rate=>({...rate,validFrom:new Date(rate.validFrom).toISOString(),validUntil:new Date(rate.validUntil).toISOString(),
      inputUsdPerMillion:normalizedMoney(rate.inputUsdPerMillion),outputUsdPerMillion:normalizedMoney(rate.outputUsdPerMillion)}))
      .sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
    const fingerprint=createHash('sha256').update(JSON.stringify(document)).digest('hex');
    for (const rate of document.rates) Object.freeze(rate);
    Object.freeze(document.rates);Object.freeze(document);
    return Object.freeze({fingerprint,document});
  } catch { throw new PricePolicyError(); }
}
export function readAiPricePolicy(env: Readonly<Record<string,string|undefined>>): PricePolicy | null {
  const raw=env.AI_PRICE_POLICY_JSON;
  return raw === undefined || raw.trim()==='' ? null : parsePricePolicy(raw);
}
export type UnpricedReason = 'no_policy' | 'unknown_usage' | 'model_missing' | 'no_effective_rate';
export type CostQuote = { status:'priced'; estimatedCostMicrousd:string; rateIndex:number; reason:null } |
  { status:'unpriced'; estimatedCostMicrousd:null; rateIndex:null; reason:UnpricedReason };
/** Exact integer micro-USD, rounded UP once per call. This is an estimate of
 * uncached text tokens, never an invoice, tax amount or customer charge. */
export function quoteUsage(policy: PricePolicy | null, provider: string, model: string | null, startedAt: Date, usage: TokenUsage | null): CostQuote {
  const unknown=(reason:UnpricedReason):CostQuote=>({status:'unpriced',reason,estimatedCostMicrousd:null,rateIndex:null});
  if (!validUsage(usage)) return unknown('unknown_usage');
  if (!policy) return unknown('no_policy');
  if (!safeModel(model)) return unknown('model_missing');
  const time=startedAt.getTime();
  if (!Number.isFinite(time)) throw new PricePolicyError();
  const index=policy.document.rates.findIndex(rate=>rate.provider===provider && rate.model===model && time>=Date.parse(rate.validFrom) && time<Date.parse(rate.validUntil));
  if (index<0) return unknown('no_effective_rate');
  const rate=policy.document.rates[index];
  const numerator=BigInt(usage.promptTokens)*rateMicros(rate.inputUsdPerMillion)+BigInt(usage.completionTokens)*rateMicros(rate.outputUsdPerMillion);
  return {status:'priced',estimatedCostMicrousd:((numerator+million-1n)/million).toString(),rateIndex:index,reason:null};
}
export function formatMicroUsd(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new PricePolicyError();
  const micros=BigInt(value);return (micros/million).toString()+'.'+(micros%million).toString().padStart(6,'0');
}
