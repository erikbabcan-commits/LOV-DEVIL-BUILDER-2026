/* Single-process admission guard for the loopback pilot only.
   Public multi-user deployments require durable per-user accounting. */
export interface LocalBudgetConfig {
  maxConcurrent: number;
  maxRunsPerDay: number;
}

export class LocalBudgetGuard {
  private active = 0;
  private day = new Date().toISOString().slice(0, 10);
  private admitted = 0;

  constructor(private readonly cfg: LocalBudgetConfig) {}

  acquire(): { ok: true; release(): void } | { ok: false; reason: 'concurrency' | 'daily_budget' } {
    const today = new Date().toISOString().slice(0, 10);
    if (this.day !== today) { this.day = today; this.admitted = 0; }
    if (this.active >= this.cfg.maxConcurrent) return { ok: false, reason: 'concurrency' };
    if (this.admitted >= this.cfg.maxRunsPerDay) return { ok: false, reason: 'daily_budget' };
    this.active++;
    this.admitted++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
      },
    };
  }

  getStats(): { active: number; admittedToday: number } {
    return { active: this.active, admittedToday: this.admitted };
  }
}
