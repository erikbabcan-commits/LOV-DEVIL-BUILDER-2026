// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompileQueue } from '../../../server/sandbox/queue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('shared compile queue', () => {
  it('runs FIFO, with one active and exactly eight waiting by default', async () => {
    const queue = new CompileQueue(); const gate = deferred(); const order: number[] = [];
    const first = queue.run(async () => { await gate.promise; order.push(0); });
    const pending = Array.from({ length: 8 }, (_, i) => queue.run(async () => { order.push(i + 1); }));
    expect(queue.stats).toEqual({ active: 1, waiting: 8 });
    await expect(queue.run(async () => {})).rejects.toMatchObject({ code: 'sandbox_busy' });
    gate.resolve(); await Promise.all([first, ...pending]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(queue.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('expires a queued task at 30 seconds without invoking it', async () => {
    vi.useFakeTimers();
    const queue = new CompileQueue(); const gate = deferred(); const task = vi.fn();
    const first = queue.run(() => gate.promise);
    const expired = expect(queue.run(task)).rejects.toMatchObject({ code: 'sandbox_queue_timeout' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(queue.stats.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await expired;
    expect(task).not.toHaveBeenCalled(); expect(queue.stats.waiting).toBe(0);
    gate.resolve(); await first;
  });

  it('removes cancelled queued tasks and holds an active slot until cleanup settles', async () => {
    const queue = new CompileQueue(); const cleanup = deferred(); const entered = deferred();
    const activeAbort = new AbortController(); const waitingAbort = new AbortController();
    const active = queue.run(async signal => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup.promise; throw new Error('cancelled after cleanup');
    }, activeAbort.signal);
    await entered.promise;
    const cancelledTask = vi.fn();
    const cancelled = expect(queue.run(cancelledTask, waitingAbort.signal)).rejects.toMatchObject({ code: 'sandbox_aborted' });
    const nextTask = vi.fn(async () => 'next'); const next = queue.run(nextTask);
    waitingAbort.abort(); await cancelled;
    const failure = expect(active).rejects.toThrow('cancelled after cleanup');
    activeAbort.abort(); activeAbort.abort();
    await Promise.resolve();
    expect(queue.stats).toEqual({ active: 1, waiting: 1 }); expect(nextTask).not.toHaveBeenCalled();
    cleanup.resolve(); await failure; expect(await next).toBe('next');
    expect(cancelledTask).not.toHaveBeenCalled(); expect(nextTask).toHaveBeenCalledTimes(1);
    expect(queue.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('handles pre-abort, synchronous throws and invalid resource settings', async () => {
    const queue = new CompileQueue(); const controller = new AbortController(); controller.abort();
    await expect(queue.run(async () => 1, controller.signal)).rejects.toMatchObject({ code: 'sandbox_aborted' });
    await expect(queue.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(await queue.run(async () => 2)).toBe(2);
    expect(queue.stats.active).toBe(0);
    expect(() => new CompileQueue(3)).toThrow(); expect(() => new CompileQueue(1, 9)).toThrow();
  });
});
