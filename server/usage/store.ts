import { safeModel, validUsage } from './validation';
export { safeModel, validUsage } from './validation';
import { parsePricePolicy, quoteUsage, type PricePolicy } from './pricing';
import type { DbLike } from '../db/pool';
import { monthWindow, type QuotaStore } from '../security/quotaStore';
import { AiUsageSchema, type AiUsage } from '../../shared/aiUsage';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'incomplete';
export type CallStatus = 'completed' | 'failed' | 'cancelled' | 'not_sent';
export interface RunInput { userId: string; id: string; kind: 'generation' | 'autofix' }
export interface CallResult {
  status: CallStatus;
  actualModel: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}
export interface AiUsageStore {
  admit(run: RunInput, quota: QuotaStore): ReturnType<QuotaStore['consume']>;
  startCall(run: RunInput, provider: string, model: string): Promise<number>;
  finishCall(run: RunInput, call: number, result: CallResult): Promise<void>;
  finishRun(run: RunInput, status: RunStatus): Promise<void>;
  report(userId: string): Promise<AiUsage>;
}
export class UsageLedgerError extends Error {
  constructor() { super('Záznam spotreby AI teraz nie je dostupný. Skús to znova neskôr.'); }
}
function period(now: Date) {
  return { periodStart: monthWindow(now), periodEnd: monthWindow(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))) };
}

/** All writes pin a connection; lock order is owner (admission), run, call.
 * No transaction spans provider I/O. Unknown/prepared calls survive a restart. */
export class PostgresAiUsageStore implements AiUsageStore {
  private readonly pricing: PricePolicy | null;
  constructor(readonly db: DbLike, private readonly now = () => new Date(), pricing: PricePolicy | null = null) {
    this.pricing = pricing ? parsePricePolicy(JSON.stringify(pricing.document)) : null;
  }
  async admit(run: RunInput, quota: QuotaStore) {
    if (!quota.consumeRecorded || quota.transactionalDb !== this.db) throw new UsageLedgerError();
    const started = this.now();
    return quota.consumeRecorded(run.userId, async (tx, snapshot, window) => {
      // Detect schema drift inside admission, so a missing costs migration
      // rolls back the monthly counter before any SSE response or inference.
      await tx.query('SELECT user_id,run_id,call_no,policy_fingerprint,status,reason,estimated_cost_microusd,rate_index FROM ai_call_costs LIMIT 0');
      await tx.query('SELECT fingerprint,document FROM ai_price_policies LIMIT 0');
      await tx.query(`INSERT INTO ai_runs(user_id,id,kind,period_start,plan,started_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [run.userId, run.id, run.kind, window, snapshot.plan, started]);
    });
  }
  private async locked<T>(run: RunInput, work: (tx: DbLike, row: Record<string, unknown>) => Promise<T>): Promise<T> {
    if (!this.db.transaction) throw new UsageLedgerError();
    return this.db.transaction(async tx => {
      const result = await tx.query('SELECT status,call_count FROM ai_runs WHERE user_id=$1 AND id=$2 FOR UPDATE', [run.userId, run.id]);
      if (!result.rows.length) throw new UsageLedgerError();
      return work(tx, result.rows[0]);
    });
  }
  async startCall(run: RunInput, provider: string, model: string): Promise<number> {
    if (!safeModel(provider) || !safeModel(model)) throw new UsageLedgerError();
    return this.locked(run, async (tx, row) => {
      const next = Number(row.call_count) + 1;
      if (row.status !== 'running' || next > 128) throw new UsageLedgerError();
      await tx.query('UPDATE ai_runs SET call_count=$3 WHERE user_id=$1 AND id=$2', [run.userId, run.id, next]);
      const startedAt = this.now();
      await tx.query(`INSERT INTO ai_calls(user_id,run_id,call_no,provider,requested_model,started_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [run.userId, run.id, next, provider, model, startedAt]);
      if (this.pricing) {
        await tx.query(`INSERT INTO ai_price_policies(fingerprint,document) VALUES($1,$2::jsonb)
          ON CONFLICT(fingerprint) DO NOTHING`, [this.pricing.fingerprint, JSON.stringify(this.pricing.document)]);
        const saved = await tx.query('SELECT document FROM ai_price_policies WHERE fingerprint=$1', [this.pricing.fingerprint]);
        if (!saved.rows[0] || parsePricePolicy(JSON.stringify(saved.rows[0].document)).fingerprint !== this.pricing.fingerprint) throw new UsageLedgerError();
      }
      await tx.query(`INSERT INTO ai_call_costs(user_id,run_id,call_no,policy_fingerprint) VALUES($1,$2,$3,$4)`,
        [run.userId,run.id,next,this.pricing?.fingerprint ?? null]);
      return next;
    });
  }
  async finishCall(run: RunInput, call: number, result: CallResult): Promise<void> {
    const usage = validUsage(result.usage) ? result.usage : null;
    await this.locked(run, async (tx) => {
      const captured = await tx.query(`SELECT c.started_at,c.provider,k.policy_fingerprint,p.document
        FROM ai_calls c JOIN ai_call_costs k ON k.user_id=c.user_id AND k.run_id=c.run_id AND k.call_no=c.call_no
        LEFT JOIN ai_price_policies p ON p.fingerprint=k.policy_fingerprint
        WHERE c.user_id=$1 AND c.run_id=$2 AND c.call_no=$3 AND c.status='prepared'`, [run.userId,run.id,call]);
      const row = captured.rows[0];
      if (!row) throw new UsageLedgerError();
      const policy = row.policy_fingerprint ? parsePricePolicy(JSON.stringify(row.document)) : null;
      if (policy && policy.fingerprint !== row.policy_fingerprint) throw new UsageLedgerError();
      const quote = result.status === 'not_sent'
        ? {status:'not_sent',reason:'not_sent',estimatedCostMicrousd:null,rateIndex:null}
        : quoteUsage(policy, row.provider, safeModel(result.actualModel), new Date(row.started_at), usage);
      const cost = await tx.query(`UPDATE ai_call_costs SET status=$4,reason=$5,estimated_cost_microusd=$6,rate_index=$7
        WHERE user_id=$1 AND run_id=$2 AND call_no=$3 AND status='pending' RETURNING call_no`,
        [run.userId,run.id,call,quote.status,quote.reason,quote.estimatedCostMicrousd,quote.rateIndex]);
      if (!cost.rows.length) throw new UsageLedgerError();
      const updated = await tx.query(`UPDATE ai_calls SET status=$4,actual_model=$5,prompt_tokens=$6,completion_tokens=$7,finished_at=$8
        WHERE user_id=$1 AND run_id=$2 AND call_no=$3 AND status='prepared' RETURNING call_no`,
      [run.userId, run.id, call, result.status, safeModel(result.actualModel), usage?.promptTokens ?? null, usage?.completionTokens ?? null, this.now()]);
      if (!updated.rows.length) throw new UsageLedgerError();
    });
  }
  async finishRun(run: RunInput, status: RunStatus): Promise<void> {
    await this.locked(run, async (tx, row) => {
      if (row.status !== 'running') return;
      if (status !== 'incomplete') {
        const pending = await tx.query("SELECT call_no FROM ai_calls WHERE user_id=$1 AND run_id=$2 AND status='prepared' LIMIT 1", [run.userId, run.id]);
        if (pending.rows.length) throw new UsageLedgerError();
      }
      await tx.query('UPDATE ai_runs SET status=$3,finished_at=$4 WHERE user_id=$1 AND id=$2', [run.userId, run.id, status, this.now()]);
    });
  }
  async report(userId: string): Promise<AiUsage> {
    const window = period(this.now());
    const result = await this.db.query(`SELECT COUNT(*) AS calls,
      COUNT(prompt_tokens) AS reported,
      COUNT(CASE WHEN status='prepared' THEN 1 END) AS pending,
      COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
      FROM ai_calls WHERE user_id=$1 AND started_at >= $2 AND started_at < $3 AND status <> 'not_sent'`, [userId, new Date(window.periodStart + 'T00:00:00Z'), new Date(window.periodEnd + 'T00:00:00Z')]);
    const row = result.rows[0];
    return AiUsageSchema.parse({ ...window, calls: Number(row.calls), reportedCalls: Number(row.reported),
      unknownCalls: Number(row.calls) - Number(row.reported), pendingCalls: Number(row.pending),
      promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens) });
  }
}

/** Explicit pilot/test adapter. Bounded, volatile, never used by authenticated
 * production wiring unless injected. Full storage denies before inference. */
export class InMemoryAiUsageStore implements AiUsageStore {
  private runs = new Map<string, { run: RunInput; status: string; calls: Array<{ started: Date; result: CallResult | null }> }>();
  constructor(private readonly now = () => new Date(), private readonly maxRuns = 1000) {}
  private key(run: RunInput) { return JSON.stringify([run.userId, run.id]); }
  private get(run: RunInput) { const row = this.runs.get(this.key(run)); if (!row) throw new UsageLedgerError(); return row; }
  async admit(run: RunInput, quota: QuotaStore) {
    if (this.runs.size >= this.maxRuns || this.runs.has(this.key(run))) throw new UsageLedgerError();
    // Reserve before awaiting quota so overlapping admissions cannot bypass bounds.
    this.runs.set(this.key(run), { run, status: 'admitting', calls: [] });
    try {
      const result = await quota.consume(run.userId);
      if (result.ok) this.get(run).status = 'running'; else this.runs.delete(this.key(run));
      return result;
    } catch (error) { this.runs.delete(this.key(run)); throw error; }
  }
  async startCall(run: RunInput, provider: string, model: string) {
    const row = this.get(run);
    if (row.status !== 'running' || row.calls.length >= 128 || !safeModel(provider) || !safeModel(model)) throw new UsageLedgerError();
    row.calls.push({ started: this.now(), result: null }); return row.calls.length;
  }
  async finishCall(run: RunInput, call: number, result: CallResult) {
    const item = this.get(run).calls[call - 1]; if (!item || item.result) throw new UsageLedgerError();
    item.result = { status: result.status, actualModel: safeModel(result.actualModel), usage: validUsage(result.usage) ? { ...result.usage } : null };
  }
  async finishRun(run: RunInput, status: RunStatus) {
    const row = this.get(run); if (row.status !== 'running') return;
    if (status !== 'incomplete' && row.calls.some(call => !call.result)) throw new UsageLedgerError();
    row.status = status;
  }
  async report(userId: string): Promise<AiUsage> {
    const window = period(this.now());
    const calls = [...this.runs.values()].filter(row => row.run.userId === userId).flatMap(row => row.calls)
      .filter(call => call.started >= new Date(window.periodStart) && call.started < new Date(window.periodEnd) && call.result?.status !== 'not_sent');
    const known = calls.filter(call => call.result?.usage);
    return AiUsageSchema.parse({ ...window, calls: calls.length, reportedCalls: known.length, unknownCalls: calls.length - known.length,
      pendingCalls: calls.filter(call => !call.result).length,
      promptTokens: known.reduce((sum, call) => sum + call.result!.usage!.promptTokens, 0),
      completionTokens: known.reduce((sum, call) => sum + call.result!.usage!.completionTokens, 0) });
  }
}
