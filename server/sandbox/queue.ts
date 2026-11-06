import { SandboxError } from './errors';

interface Job {
  start(): void;
  cancel(error: SandboxError): void;
}

/** One coordinator owns this queue; active slots are released only after cleanup settles. */
export class CompileQueue {
  private active = 0;
  private pending: Job[] = [];
  constructor(private readonly concurrency = 1, private readonly capacity = 8, private readonly waitMs = 30_000) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2 ||
        !Number.isInteger(capacity) || capacity < 0 || capacity > 8 || waitMs < 1 || waitMs > 30_000)
      throw new Error('Invalid sandbox queue configuration');
  }
  get stats() { return { active: this.active, waiting: this.pending.length }; }

  run<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new SandboxError('sandbox_aborted'));
    if (this.active >= this.concurrency && this.pending.length >= this.capacity)
      return Promise.reject(new SandboxError('sandbox_busy'));
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      let settled = false;
      const controller = new AbortController();
      const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const job: Job = {
        cancel: error => {
          if (started || settled) return;
          settled = true; detach();
          const index = this.pending.indexOf(job);
          if (index !== -1) this.pending.splice(index, 1);
          reject(error);
        },
        start: () => {
          if (settled) return;
          started = true; clearTimeout(timer); this.active++;
          const finish = () => {
            if (settled) return;
            settled = true; detach(); this.active--;
            while (this.active < this.concurrency && this.pending.length) this.pending.shift()!.start();
          };
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new SandboxError('sandbox_aborted');
            return task(controller.signal);
          }).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        },
      };
      const abort = () => {
        if (started) controller.abort();
        else job.cancel(new SandboxError('sandbox_aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (this.active < this.concurrency) job.start();
      else {
        this.pending.push(job);
        timer = setTimeout(() => job.cancel(new SandboxError('sandbox_queue_timeout')), this.waitMs);
      }
      if (signal?.aborted) abort();
    });
  }
}
