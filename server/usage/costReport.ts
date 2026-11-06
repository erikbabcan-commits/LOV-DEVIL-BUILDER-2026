import type { DbLike } from '../db/pool';
import { parsePricePolicy, formatMicroUsd } from './pricing';

export interface CostReportFilter { month: string; userId?: string; plan?: 'free' | 'pro' }
const hasControl = (value: string) => [...value].some(ch => ch.charCodeAt(0)<32 || ch.charCodeAt(0)===127);
export class CostReportError extends Error { constructor() { super('ai_cost_report_unavailable'); } }
export function costReportWindow(filter: CostReportFilter) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) throw new CostReportError();
  const [year,month]=filter.month.split('-').map(Number);
  if (year<2000 || year>9998 || (filter.userId!==undefined && (!filter.userId || filter.userId.length>256 || hasControl(filter.userId))) || (filter.plan!==undefined && !['free','pro'].includes(filter.plan))) throw new CostReportError();
  return {start:new Date(Date.UTC(year,month-1,1)),end:new Date(Date.UTC(year,month,1))};
}
function integer(value: unknown): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new CostReportError();
  return BigInt(String(value));
}
const where=`c.started_at >= $1 AND c.started_at < $2 AND c.status <> 'not_sent'
  AND ($3::text IS NULL OR c.user_id=$3) AND ($4::text IS NULL OR r.plan=$4)`;
const sums=['calls','reported_calls','priced_calls','pending_calls','legacy_calls','input_tokens','output_tokens','cost_micros'] as const;
type Sums=Record<typeof sums[number],bigint>;
const empty=():Sums=>Object.fromEntries(sums.map(key=>[key,0n])) as Sums;
function publicSums(sum:Sums) {
  if (sum.priced_calls>sum.calls || sum.reported_calls>sum.calls || sum.pending_calls>sum.calls || sum.legacy_calls>sum.calls) throw new CostReportError();
  const cost=formatMicroUsd(sum.cost_micros.toString());
  return {calls:sum.calls.toString(),reportedCalls:sum.reported_calls.toString(),pricedCalls:sum.priced_calls.toString(),
    unknownCostCalls:(sum.calls-sum.priced_calls).toString(),pendingCalls:sum.pending_calls.toString(),legacyCallsWithoutCostSnapshot:sum.legacy_calls.toString(),
    promptTokens:sum.input_tokens.toString(),completionTokens:sum.output_tokens.toString(),
    estimatedKnownCostUsd:cost,estimatedRecordedCostUsd:sum.calls===sum.priced_calls?cost:null,
    allRecordedCallsPriced:sum.calls===sum.priced_calls};
}
/** Read model only; the CLI pins a REPEATABLE READ READ ONLY transaction around
 * both queries. No provider request, migrations, entitlement change or repricing. */
export async function aiCostReport(db:DbLike,filter:CostReportFilter,now=()=>new Date()) {
  const window=costReportWindow(filter),params=[window.start,window.end,filter.userId??null,filter.plan??null];
  const policies=await db.query(`SELECT DISTINCT p.fingerprint,p.document
    FROM ai_calls c JOIN ai_runs r ON r.user_id=c.user_id AND r.id=c.run_id
    JOIN ai_call_costs k ON k.user_id=c.user_id AND k.run_id=c.run_id AND k.call_no=c.call_no
    JOIN ai_price_policies p ON p.fingerprint=k.policy_fingerprint WHERE ${where} LIMIT 129`,params);
  if (policies.rows.length>128) throw new CostReportError();
  const versions=policies.rows.map(row=>{
    const parsed=parsePricePolicy(JSON.stringify(row.document));
    if (parsed.fingerprint!==row.fingerprint) throw new CostReportError();
    return {version:parsed.document.version,fingerprint:parsed.fingerprint};
  }).sort((a,b)=>a.fingerprint<b.fingerprint?-1:a.fingerprint>b.fingerprint?1:0);
  const result=await db.query(`SELECT c.user_id,r.plan,COUNT(*) AS calls,COUNT(c.prompt_tokens) AS reported_calls,
    COUNT(CASE WHEN k.status='priced' THEN 1 END) AS priced_calls,
    COUNT(CASE WHEN c.status='prepared' THEN 1 END) AS pending_calls,
    COUNT(CASE WHEN k.user_id IS NULL THEN 1 END) AS legacy_calls,
    COALESCE(SUM(c.prompt_tokens),0) AS input_tokens,COALESCE(SUM(c.completion_tokens),0) AS output_tokens,
    COALESCE(SUM(k.estimated_cost_microusd),0) AS cost_micros
    FROM ai_calls c JOIN ai_runs r ON r.user_id=c.user_id AND r.id=c.run_id
    LEFT JOIN ai_call_costs k ON k.user_id=c.user_id AND k.run_id=c.run_id AND k.call_no=c.call_no
    WHERE ${where} GROUP BY c.user_id,r.plan ORDER BY c.user_id,r.plan LIMIT 501`,params);
  if (result.rows.length>500) throw new CostReportError();
  const totals=empty();
  const accounts=result.rows.map(row=>{
    if (typeof row.user_id!=='string' || !row.user_id || row.user_id.length>256 || hasControl(row.user_id) || !['free','pro'].includes(row.plan)) throw new CostReportError();
    const sum=empty();for (const key of sums) {sum[key]=integer(row[key]);totals[key]+=sum[key];}
    return {userId:row.user_id,admissionPlan:row.plan,...publicSums(sum)};
  });
  return {schemaVersion:1,currency:'USD',basis:'estimated-uncached-text-tokens',coverage:'recorded_calls_only',
    periodStart:window.start.toISOString(),periodEnd:window.end.toISOString(),generatedAt:now().toISOString(),policies:versions,accounts,totals:publicSums(totals)};
}
