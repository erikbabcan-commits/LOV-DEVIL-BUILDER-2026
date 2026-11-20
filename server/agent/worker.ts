import { AgentEventSchema, type AgentEvent } from './schemas';
import { parseAgentRequest, runAgent } from './run';
import { agentRunAbort, type AgentJobRecord, type DurableAgentJobStore } from './jobs';
import { AgentJobResultPatchSchema, type AgentJobErrorPayload, type AgentJobResultPatch } from '../../shared/agentJobs';
import type { AIProvider } from '../providers/types';
import type { ProviderRegistry } from '../providers/registry';
import { createProviderRun } from '../providers/run';
import { PLAN_UPGRADE_REQUIRED, PlanUpgradeRequiredError, referencesPremiumModel, selectGenerationRoute, withRouteDecision, type GenerationRoute } from '../providers/generationRoute';
import { ProviderError } from '../providers/errors';
import type { ResilienceOptions } from '../providers/resilience';
import type { QuotaStore } from '../security/quotaStore';
import { redactSecrets } from '../security/secrets';

/* Durable agent worker (LOV-DEVIL agent 1). Picks `queued` jobs created by
   POST /api/agent/jobs, runs the shared runAgent() and stores the outcome in
   agent_jobs. Quota is debited by DurableAgentJobStore.completeSucceeded —
   exactly once, in the same transaction as running -> succeeded — never here,
   and never for failed / cancelled jobs or retries.

   Single backend instance (same assumption as agentRunAbort). After a restart
   start() requeues interrupted `running` worker jobs (bounded by maxAttempts)
   or fails them with a structured errorPayload. */

export interface AgentWorkerOptions {
  store: DurableAgentJobStore;
  providers: ProviderRegistry;
  /** false -> jobs fail with `ai_disabled` before any provider call. */
  aiAllowed?: () => boolean;
  /** Read-only pre-check at claim time (no debit). */
  quota?: QuotaStore;
  /** Shared concurrency/daily guard (LocalBudgetGuard.acquire). When it refuses, the job stays queued. */
  admit?: () => { ok: true; release(): void; discard(): void } | { ok: false };
  resilience?: ResilienceOptions;
  maxFiles?: number;
  requestTimeoutMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  /** Smart router for jobs without modelId (AI_SMART_ROUTER=1, default OFF; Bora W3 P3-1). */
  smartRouter?: boolean;
  /** Effective plan of the job owner for the smart router (free never gets premium models). Errors/absent = 'free'. */
  planFor?: (ownerId: string) => Promise<'free' | 'pro'>;
  /** test seam: events are flushed to the row in batches of this size. */
  flushEvery?: number;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

function payload(code: string, message: string, retriable: boolean): AgentJobErrorPayload {
  return { code: code.slice(0, 64), message: redactSecrets(message).slice(0, 4000), retriable };
}

/** Counts reported token usage of the calls that actually returned. null when the provider reported none. */
function countingProvider(base: AIProvider) {
  const total = { input: 0, output: 0, reported: false };
  const add = (u: { promptTokens: number; completionTokens: number } | undefined, reported = true) => {
    if (!u || !reported) return;
    total.reported = true;
    total.input += Math.max(0, Math.trunc(u.promptTokens) || 0);
    total.output += Math.max(0, Math.trunc(u.completionTokens) || 0);
  };
  const provider: AIProvider = {
    name: base.name, model: base.model, contextWindowTokens: base.contextWindowTokens,
    async complete(messages, opts) { const r = await base.complete(messages, opts); add(r.usage, r.usageReported !== false); return r; },
    async *stream(messages, opts) { for await (const chunk of base.stream(messages, opts)) { add(chunk.usage); yield chunk; } },
  };
  return { provider, tokens: () => (total.reported ? { input: total.input, output: total.output } : null) };
}

export class AgentWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly maxAttempts: number;
  constructor(private readonly o: AgentWorkerOptions) { this.maxAttempts = o.maxAttempts ?? 2; }

  /** Recover interrupted jobs, then poll. The timer is unref'd so it never keeps the process alive. */
  async start() {
    await this.o.store.recoverInterrupted(this.maxAttempts);
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.o.pollMs ?? 1000);
    this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Drain: process queued jobs until none is left (or the budget guard refuses). Returns the number processed. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.tick()) n++;
    return n;
  }

  /** Claim and run at most one job. Returns false when nothing was run. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    let admission: ReturnType<NonNullable<AgentWorkerOptions['admit']>> | null = null;
    try {
      if (this.o.admit) { admission = this.o.admit(); if (!admission.ok) return false; }
      const job = await this.o.store.claimNext();
      if (!job) { if (admission?.ok) admission.discard(); admission = null; return false; }
      try { await this.run(job); } finally { if (admission?.ok) admission.release(); admission = null; }
      return true;
    } finally {
      if (admission?.ok) admission.discard();
      this.busy = false;
    }
  }

  /** Looked up when the router can choose (flag ON, no modelId) or the job names a premium model
   *  (GBBB-3); otherwise the run stays query-free. No planFor or a failed lookup = free. */
  private async ownerPlan(ownerId: string, request: { modelId?: string; allowFallback?: boolean; fallbackIds?: readonly string[] }): Promise<'free' | 'pro'> {
    const needed = (this.o.smartRouter === true && request.modelId === undefined) || referencesPremiumModel(request);
    if (!needed || !this.o.planFor) return 'free';
    try { return (await this.o.planFor(ownerId)) === 'pro' ? 'pro' : 'free'; } catch { return 'free'; }
  }

  private async run(job: AgentJobRecord) {
    const { store } = this.o;
    const id = job.id;
    const failed = (code: string, message: string, retriable: boolean) => store.fail(id, payload(code, message, retriable)).then(() => undefined);
    if (this.o.aiAllowed && !this.o.aiAllowed()) return failed('ai_disabled', 'AI generation is disabled on this deployment.', false);
    const input = parseAgentRequest(job.request);
    if (!input.ok) return failed(input.error.code, input.error.message, false);

    /* Wave-3 glue: same model choice as /api/agent/generate (smart router only without a modelId). */
    let selected: GenerationRoute;
    try {
      selected = selectGenerationRoute(this.o.providers, {
        modelId: input.request.modelId,
        allowFallback: input.request.allowFallback,
        fallbackIds: input.request.fallbackIds,
        prompt: input.request.prompt,
        mode: input.request.mode,
        fileCount: input.request.context.files.length,
        smartRouter: this.o.smartRouter === true,
        plan: await this.ownerPlan(job.ownerId, input.request),
        enforcePlan: true,
      });
    } catch (error) {
      // GBBB-3: explicit premium model on a non-pro plan; fails before quota and any AI call.
      if (error instanceof PlanUpgradeRequiredError) return failed(PLAN_UPGRADE_REQUIRED, error.message + ' (model: ' + error.model + ', requiredPlan: ' + error.requiredPlan + ')', false);
      return failed(this.o.providers.defaultProvider ? 'invalid_model' : 'ai_not_configured', 'The selected AI model is not available.', false);
    }
    const route = selected.entries;
    if (!this.o.providers.defaultProvider) return failed('ai_not_configured', 'AI engine is not configured.', false);

    if (this.o.quota) {
      try {
        const usage = await this.o.quota.usage(job.ownerId);
        if (usage.remaining < 1) return failed('quota_exceeded', 'Monthly generation quota is exhausted.', false);
      } catch { return failed('quota_unavailable', 'Quota could not be verified.', true); }
    }

    const abort = new AbortController();
    agentRunAbort.set(id, abort);
    const timeout = setTimeout(() => abort.abort(new ProviderError('timeout')), this.o.requestTimeoutMs ?? 120_000);
    const counter = countingProvider(createProviderRun(route, null, { userId: job.ownerId, id, kind: 'generation' }, this.o.resilience).provider);
    const pending: AgentEvent[] = [];
    let terminal: AgentEvent | null = null;
    let stage: AgentEvent | null = null;
    let thrown: unknown;
    const flush = async () => { if (pending.length) await store.appendEvents(id, pending.splice(0)).catch(() => {}); };
    try {
      try {
        for await (const raw of runAgent(input.request, { runId: id, provider: counter.provider, signal: abort.signal, maxFiles: this.o.maxFiles ?? 40 })) {
          const event = AgentEventSchema.safeParse(withRouteDecision(raw, selected.decision));
          if (!event.success) continue;
          pending.push(event.data);
          if (event.data.type === 'stage') stage = event.data;
          if (TERMINAL.has(event.data.type)) terminal = event.data;
          if (pending.length >= (this.o.flushEvery ?? 8)) await flush();
        }
      } catch (error) { thrown = error; }
      await flush();

      if (abort.signal.aborted && !(terminal && terminal.type === 'done')) {
        // Cancelled via the jobs API (state already 'cancelled': guarded no-op) or interrupted by the timeout.
        const timedOut = abort.signal.reason instanceof ProviderError && abort.signal.reason.kind === 'timeout';
        if (timedOut) return await failed('provider_timeout', 'The AI response exceeded the time limit.', true);
        await store.finish(id, 'cancelled', 'cancelled');
        return;
      }
      if (terminal && terminal.type === 'done') {
        let resultPatch: AgentJobResultPatch | null = null;
        if (stage && stage.type === 'stage') {
          const parsed = AgentJobResultPatchSchema.safeParse({
            files: stage.files,
            ...(stage.editMode ? { editMode: stage.editMode } : {}),
            ...(stage.summary ? { summary: stage.summary } : {}),
          });
          if (!parsed.success) return await failed('invalid_result', 'The generated result did not match the result contract.', false);
          resultPatch = parsed.data;
        }
        // The only place quota is debited: atomic transition + ledger row + counter increment.
        // A transient DB error rolls the whole transaction back (no debit, state stays `running`);
        // retry a few times, after that recoverInterrupted() requeues the job on the next start.
        for (let attempt = 1; ; attempt++) {
          try { await store.completeSucceeded(id, { resultPatch, tokensUsed: counter.tokens() }); return; }
          catch (error) { if (attempt >= 3) throw error; }
        }
      }
      if (terminal && terminal.type === 'error') return await failed(terminal.code, terminal.message, terminal.retriable);
      if (terminal && terminal.type === 'cancelled') { await store.finish(id, 'cancelled', 'cancelled'); return; }
      return await failed('worker_error', thrown instanceof Error ? thrown.message : 'The run ended without a result.', true);
    } finally {
      clearTimeout(timeout);
      agentRunAbort.delete(id);
    }
  }
}

export function startAgentWorker(options: AgentWorkerOptions): AgentWorker {
  const worker = new AgentWorker(options);
  void worker.start().catch(() => {});
  return worker;
}
