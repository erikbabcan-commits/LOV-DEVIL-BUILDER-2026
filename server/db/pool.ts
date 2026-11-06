import { Pool } from 'pg';

/* WS-1 DB vrstva — Postgres je OPTIONAL (pilot beží aj bez neho, AUTH_ENABLED=0).
   Pool sa vytvára lazy až pri prvom použití; AUTH_ENABLED=1 bez DATABASE_URL
   zlyhá už pri štarte servera (fail-fast, nie za letu). */

export interface DbLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
  /** Must pin one connection for the entire transaction. Project writes fail
   * closed if this capability is absent; never emulate BEGIN across pool.query. */
  transaction?: <T>(work: (db: DbLike) => Promise<T>) => Promise<T>;
}

export function dbFromPool(p: Pick<Pool, 'query' | 'connect'>): DbLike {
  const queryFor = (connection: Pick<Pool, 'query'>): DbLike['query'] => async (sql, params) => {
    const result = await connection.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  };
  return { query: queryFor(p), transaction: async work => {
    const client = await p.connect();
    try {
      // Each statement after acquiring the owner lock must see newly committed
      // projects, even if the connection's default isolation was overridden.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work({ query: queryFor(client) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  } };
}

let pool: Pool | null = null;

export function getPool(databaseUrl: string): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export function makeDb(databaseUrl: string): DbLike {
  return dbFromPool(getPool(databaseUrl));
}

/* Pre testy (pg-mem) — injects fake DbLike bez globálneho poolu. */
export function dbFrom(query: DbLike['query']): DbLike {
  return { query };
}
