import { Pool } from 'pg';

/* WS-1 DB vrstva — Postgres je OPTIONAL (pilot beží aj bez neho, AUTH_ENABLED=0).
   Pool sa vytvára lazy až pri prvom použití; AUTH_ENABLED=1 bez DATABASE_URL
   zlyhá už pri štarte servera (fail-fast, nie za letu). */

export interface DbLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
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
  const p = getPool(databaseUrl);
  return {
    async query(sql: string, params?: unknown[]) {
      const res = await p.query(sql, params as never[]);
      return { rows: res.rows as any[], rowCount: res.rowCount };
    },
  };
}

/* Pre testy (pg-mem) — injects fake DbLike bez globálneho poolu. */
export function dbFrom(query: DbLike['query']): DbLike {
  return { query };
}
