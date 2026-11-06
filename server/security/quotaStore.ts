import type { DbLike } from '../db/pool';
import { effectivePlan } from '../auth/plans';

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
  readonly transactionalDb?: DbLike;
  consumeRecorded?(userId: string, record: (tx: DbLike, quota: QuotaSnapshot, period: string) => Promise<void>): Promise<{ ok: boolean; snapshot: QuotaSnapshot }>;
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
  constructor(private db: DbLike, private readonly now: () => Date = () => new Date()) {}
  get transactionalDb(): DbLike { return this.db; }

  async usage(userId: string): Promise<QuotaSnapshot> {
    const period = monthWindow(this.now());
    const r = await this.db.query(
      'SELECT generations FROM user_quotas WHERE user_id = $1 AND period_start = $2',
      [userId, period]
    );
    const row = r.rows[0];
    const plan = await this.planOf(userId);
    return snapshotFor(plan, row ? Number(row.generations) : 0);
  }

  async consume(userId: string): Promise<{ ok: boolean; snapshot: QuotaSnapshot }> {
    return this.consumeRecorded(userId, async () => {});
  }

  async consumeRecorded(userId: string, record: (tx: DbLike, quota: QuotaSnapshot, period: string) => Promise<void>): Promise<{ ok: boolean; snapshot: QuotaSnapshot }> {
    const period = monthWindow(this.now());
    if (!this.db.transaction) throw new Error('quota_transaction_unavailable');
    return this.db.transaction(async tx => {
      // Use the same pinned READ COMMITTED capability as project storage. Plan
      // changes, account deletion and admissions serialize on this existing row.
      const owner = await tx.query('SELECT plan, plan_expires_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!owner.rows.length) throw new Error('quota_owner_unavailable');
      const plan = effectivePlan(owner.rows[0], this.now());
      const limit = PLAN_LIMITS[plan];
      await tx.query(`INSERT INTO user_quotas(user_id,period_start,generations)
        VALUES($1,$2,0) ON CONFLICT(user_id) DO NOTHING`, [userId, period]);
      const result = await tx.query(`UPDATE user_quotas SET
          generations = CASE WHEN period_start < $2 THEN 1 ELSE generations + 1 END,
          period_start = $2
        WHERE user_id=$1 AND (period_start < $2 OR (period_start=$2 AND generations < $3))
        RETURNING generations`, [userId, period, limit]);
      if (result.rows.length) {
        const snapshot = snapshotFor(plan, Number(result.rows[0].generations));
        await record(tx, snapshot, period);
        return { ok: true, snapshot };
      }
      // An older request must never roll a newer UTC month backwards.
      const future = await tx.query('SELECT user_id FROM user_quotas WHERE user_id=$1 AND period_start > $2', [userId, period]);
      if (future.rows.length) throw new Error('quota_period_unavailable');
      const current = await tx.query('SELECT generations FROM user_quotas WHERE user_id=$1 AND period_start=$2', [userId, period]);
      return { ok: false, snapshot: snapshotFor(plan, Number(current.rows[0]?.generations ?? 0)) };
    });
  }

  private async planOf(userId: string): Promise<Plan> {
    const r = await this.db.query('SELECT plan, plan_expires_at FROM users WHERE id = $1', [userId]);
    if (!r.rows.length) throw new Error('quota_owner_unavailable');
    return effectivePlan(r.rows[0], this.now());
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
