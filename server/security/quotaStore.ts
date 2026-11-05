import type { DbLike } from '../db/pool';

/* WS-1 trvalé kvóty — mesačné okno per user, atomic inkrement v jednom UPDATE.
   fallback: InMemoryQuotaStore pre mód bez DB (pilot, AUTH_ENABLED=0). */

export type Plan = 'free' | 'pro';

export const PLAN_LIMITS: Record<Plan, number> = {
  free: 10,   // generácie/mes
  pro: 200,   // generácie/mes
};

export interface QuotaSnapshot {
  used: number;
  limit: number;
  remaining: number;
  plan: Plan;
}

export interface QuotaStore {
  /** Vráti použité generácie v aktuálnom mesiaci (bez inkrementu). */
  usage(userId: string): Promise<QuotaSnapshot>;
  /** Atomic inkrement; ok=false keď je kvóta vyčerpaná (vtedy NEPOČÍTA). */
  consume(userId: string): Promise<{ ok: boolean; snapshot: QuotaSnapshot }>;
}

function snapshotFor(plan: Plan, used: number): QuotaSnapshot {
  const limit = PLAN_LIMITS[plan];
  return { used, limit, remaining: Math.max(0, limit - used), plan };
}

/** MESACNÉ okno v UTC ako 'YYYY-MM-01' (stabilita SQL parametra). */
export function monthWindow(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export class PostgresQuotaStore implements QuotaStore {
  constructor(private db: DbLike) {}

  async usage(userId: string): Promise<QuotaSnapshot> {
    const period = monthWindow();
    const r = await this.db.query(
      'SELECT generations FROM user_quotas WHERE user_id = $1 AND period_start = $2',
      [userId, period]
    );
    const row = r.rows[0];
    const plan = await this.planOf(userId);
    return snapshotFor(plan, row ? Number(row.generations) : 0);
  }

  async consume(userId: string): Promise<{ ok: boolean; snapshot: QuotaSnapshot }> {
    const period = monthWindow();
    const plan = await this.planOf(userId);
    const limit = PLAN_LIMITS[plan];
    /* Atomic inkrement = jediný UPSERT (INSERT ... ON CONFLICT). LIMIT kontrola
       je na vrátenej hodnote: used<=limit ⇒ povolené. Súbežné prekročenie
       odráža len čítač (never generuje), presnosť accountingu je korektná. */
    const r = await this.db.query(
      `INSERT INTO user_quotas (user_id, period_start, generations)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id) DO UPDATE SET
         generations = CASE WHEN user_quotas.period_start = $2
                            THEN user_quotas.generations + 1
                            ELSE 1 END,
         period_start = $2
       RETURNING generations`,
      [userId, period]
    );
    const used = r.rows.length ? Number(r.rows[0].generations) : 0;
    const ok = used <= limit;
    const shown = ok ? used : Math.min(used - 1, limit);
    return { ok, snapshot: snapshotFor(plan, shown) };
  }

  private async planOf(userId: string): Promise<Plan> {
    const r = await this.db.query('SELECT plan FROM users WHERE id = $1', [userId]);
    return r.rows[0]?.plan === 'pro' ? 'pro' : 'free';
  }
}

/** Fallback bez DB — pilot mód (kvóty sa resetujú pri reboote, ako dnes). */
export class InMemoryQuotaStore implements QuotaStore {
  private used = new Map<string, number>();
  private window = monthWindow();

  private roll(): void {
    const current = monthWindow();
    if (current !== this.window) {
      this.window = current;
      this.used.clear();
    }
  }

  async usage(userId: string): Promise<QuotaSnapshot> {
    this.roll();
    return snapshotFor('free', this.used.get(userId) ?? 0);
  }

  async consume(userId: string): Promise<{ ok: boolean; snapshot: QuotaSnapshot }> {
    this.roll();
    const next = (this.used.get(userId) ?? 0) + 1;
    if (next > PLAN_LIMITS.free) {
      return { ok: false, snapshot: snapshotFor('free', this.used.get(userId) ?? 0) };
    }
    this.used.set(userId, next);
    return { ok: true, snapshot: snapshotFor('free', next) };
  }
}
