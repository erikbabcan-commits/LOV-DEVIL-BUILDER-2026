import type { AIProvider, CompletionResult } from '../providers/types';
import type { AiUsageStore, CallResult, RunInput, RunStatus } from './store';
import { UsageLedgerError, safeModel, validUsage } from './store';

/** Fail closed before each inference; finish failures poison the whole run so
 * an autofix catch cannot start another unaccounted call. */
export function meteredProvider(base: AIProvider, store: AiUsageStore, run: RunInput, health = {broken: false}) {
  const record = async <T>(work: () => Promise<T>): Promise<T> => {
    if (health.broken) throw new UsageLedgerError();
    try { return await work(); } catch { health.broken = true; throw new UsageLedgerError(); }
  };
  const usageOf = (result: Pick<CompletionResult, 'usage' | 'usageReported'>) =>
    result.usageReported !== false && validUsage(result.usage) ? result.usage : null;
  const provider: AIProvider = {
    name: base.name, model: base.model,
    async complete(messages, opts) {
      opts?.signal?.throwIfAborted();
      const call = await record(() => store.startCall(run, base.name, base.model));
      let result: CompletionResult;
      if (opts?.signal?.aborted) {
        await record(() => store.finishCall(run, call, { status: 'not_sent', actualModel: null, usage: null }));
        opts.signal.throwIfAborted();
      }
      try { result = await base.complete(messages, opts); }
      catch (error) {
        await record(() => store.finishCall(run, call, { status: opts?.signal?.aborted ? 'cancelled' : 'failed', actualModel: null, usage: null }));
        throw error;
      }
      await record(() => store.finishCall(run, call, { status: 'completed', actualModel: safeModel(result.model), usage: usageOf(result) }));
      return result;
    },
    async *stream(messages, opts) {
      opts?.signal?.throwIfAborted();
      const call = await record(() => store.startCall(run, base.name, base.model));
      let status: CallResult['status'] = 'cancelled', actualModel: string | null = null, usage: CallResult['usage'] = null;
      try {
        if (opts?.signal?.aborted) { status = 'not_sent'; opts.signal.throwIfAborted(); }
        let terminal = false;
        for await (const chunk of base.stream(messages, opts)) {
          if (chunk.model) actualModel = safeModel(chunk.model);
          if (chunk.usage && validUsage(chunk.usage)) usage = chunk.usage;
          if (chunk.finishReason) { terminal = true; status = chunk.finishReason === 'error' ? 'failed' : 'completed'; }
          yield chunk;
        }
        if (!terminal) status = opts?.signal?.aborted ? 'cancelled' : 'failed';
      } catch (error) { if (status !== 'not_sent') status = opts?.signal?.aborted ? 'cancelled' : 'failed'; throw error; }
      finally { await record(() => store.finishCall(run, call, { status, actualModel, usage })); }
    },
  };
  return {
    provider,
    async finish(status: RunStatus) {
      if (health.broken) { try { await store.finishRun(run, 'incomplete'); } catch { /* prepared call remains visible */ } throw new UsageLedgerError(); }
      await record(() => store.finishRun(run, status));
    },
  };
}
