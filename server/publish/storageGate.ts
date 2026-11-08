import { PublishError } from "./config";

export interface StorageOutcome<T> {
  ok: boolean;
  ioStarted: boolean;
  value?: T;
  error?: unknown;
}
export interface StorageOperation<T> {
  result: Promise<T>;
  settled: Promise<StorageOutcome<T>>;
}
export interface StorageLease {
  beginIO(): boolean;
}
type Queued = { start(): void; cancel(): void; expired: boolean };

/** Process-wide slots are released only after the real work has settled.
 * A caller deadline never abandons a running writer or replays a queued write. */
export class FilesystemGate {
  private active = 0;
  private queue: Queued[] = [];
  private idleWaiters: Array<() => void> = [];
  constructor(
    private readonly concurrency = 2,
    private readonly capacity = 8,
    private readonly timeoutMs = 5000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2 ||
        !Number.isInteger(capacity) || capacity < 0 || capacity > 8 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
      throw new Error("Invalid publish filesystem budget");
  }
  get stats() { return { active: this.active, queued: this.queue.length }; }
  idle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  submit<T>(work: (lease: StorageLease) => Promise<T>): StorageOperation<T> {
    let resolveResult!: (value: T) => void, rejectResult!: (error: unknown) => void;
    let resolveSettled!: (value: StorageOutcome<T>) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const settled = new Promise<StorageOutcome<T>>(resolve => { resolveSettled = resolve; });
    // A handle may be inspected before the result is awaited; suppress only the
    // runtime unhandled-rejection warning, never the caller's rejection.
    void result.catch(() => {});
    let started = false, ioStarted = false, done = false;
    const deadline = Date.now() + this.timeoutMs;
    const finish = (outcome: StorageOutcome<T>) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (!entry.expired && Date.now() >= deadline) {
        entry.expired = true; rejectResult(new PublishError("publish_storage_timeout"));
      }
      if (!entry.expired) {
        if (outcome.ok) resolveResult(outcome.value!); else rejectResult(outcome.error);
      }
      resolveSettled(outcome);
      if (started) this.active--;
      this.drain();
    };
    const entry: Queued = {
      expired: false,
      cancel: () => {
        if (done || entry.expired) return;
        entry.expired = true;
        const error = new PublishError("publish_storage_timeout");
        rejectResult(error);
        if (!started) {
          this.queue = this.queue.filter(value => value !== entry);
          finish({ ok: false, ioStarted: false, error });
        }
      },
      start: () => {
        if (done || entry.expired) return;
        if (Date.now() >= deadline) { entry.cancel(); return; }
        started = true; this.active++;
        Promise.resolve().then(() => work({ beginIO: () => {
          if (entry.expired) return false;
          if (Date.now() >= deadline) { entry.cancel(); return false; }
          ioStarted = true; return true;
        } })).then(
          value => finish({ ok: true, ioStarted, value }),
          error => finish({ ok: false, ioStarted, error }),
        );
      },
    };
    const timer = setTimeout(entry.cancel, this.timeoutMs);
    if (this.active < this.concurrency) entry.start();
    else if (this.queue.length < this.capacity) this.queue.push(entry);
    else {
      const error = new PublishError("publish_storage_busy");
      finish({ ok: false, ioStarted: false, error });
    }
    return { result, settled };
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) this.queue.shift()!.start();
    if (!this.active && !this.queue.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
  }
}

export const publishFilesystemGate = new FilesystemGate();
// Anonymous reads cannot occupy the slots required to admit or settle a publish.
export const publicArtifactReadGate = new FilesystemGate();
// Owners retain bounded verification capacity even when the public read queue is full.
export const promotionArtifactReadGate = new FilesystemGate();
