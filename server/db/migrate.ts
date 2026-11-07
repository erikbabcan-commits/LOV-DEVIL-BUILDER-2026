import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbLike } from './pool';

/* Migrácie: SQL súbory v server/migrations zoradené lexikálne (001_, 002_, ...).
   Idempotentné — súbor musí používať IF NOT EXISTS / ON CONFLICT (aby re-run bol bezpečný). */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function listMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(name => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

export async function applyMigrations(db: DbLike): Promise<string[]> {
  const applied: string[] = [];
  for (const m of listMigrations()) {
    /* pg-mem aj pg: multi-statement v jednom query() je OK (pg podporuje simple protocol) */
    await db.query(m.sql);
    applied.push(m.name);
  }
  return applied;
}

const schemaMetadata = `
  WITH tables AS (
    SELECT relation.oid, relation.relname, relation.relkind,
      relation.relrowsecurity, relation.relforcerowsecurity
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND relation.relkind IN ('r', 'p')
  )
  SELECT current_schema() AS schema_name,
    current_setting('server_version_num')::int / 10000 AS postgres_major,
    (SELECT jsonb_agg(jsonb_build_array(relname, relkind, relrowsecurity, relforcerowsecurity)
      ORDER BY relname COLLATE "C") FROM tables) AS tables,
    (SELECT jsonb_agg(jsonb_build_array(t.relname, a.attname,
      pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid), column_collation.collname)
      ORDER BY t.relname COLLATE "C", a.attnum)
      FROM tables t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation column_collation ON column_collation.oid = a.attcollation
      WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(t.relname, c.conname, c.convalidated,
      pg_catalog.pg_get_constraintdef(c.oid))
      ORDER BY t.relname COLLATE "C", c.conname COLLATE "C")
      FROM tables t JOIN pg_catalog.pg_constraint c ON c.conrelid = t.oid) AS constraints,
    (SELECT jsonb_agg(jsonb_build_array(t.relname, relation.relname, i.indisvalid, i.indisready,
      pg_catalog.pg_get_indexdef(i.indexrelid))
      ORDER BY t.relname COLLATE "C", relation.relname COLLATE "C")
      FROM tables t JOIN pg_catalog.pg_index i ON i.indrelid = t.oid
      JOIN pg_catalog.pg_class relation ON relation.oid = i.indexrelid) AS indexes
`;

/** Identifies the migration set and schema shape without reading application rows. */
export async function readSchemaFingerprint(db: DbLike): Promise<string> {
  if (!db.transaction) throw new Error('Schema verification requires PostgreSQL transactions.');
  const migrations = listMigrations().map(({ name, sql }) =>
    [name, createHash('sha256').update(sql).digest('hex')],
  );
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout='4000ms'");
    const metadata = (await tx.query(schemaMetadata)).rows[0];
    if (!Array.isArray(metadata?.tables) || !metadata.tables.length)
      throw new Error('Cannot fingerprint an empty application schema.');
    return createHash('sha256')
      .update(JSON.stringify([
        1, migrations, metadata.schema_name, metadata.postgres_major,
        metadata.tables, metadata.columns, metadata.constraints, metadata.indexes,
      ]))
      .digest('hex');
  });
}

/** Uses the legacy replay unless an operator pins a previously verified schema. */
export async function prepareAuthSchema(db: DbLike, expected?: string): Promise<string[] | null> {
  if (expected === undefined) return applyMigrations(db);
  if (!/^[0-9a-f]{64}$/.test(expected))
    throw new Error('DATABASE_SCHEMA_SHA256 must be a lowercase SHA-256 digest.');
  if (await readSchemaFingerprint(db) !== expected)
    throw new Error('Database schema fingerprint mismatch. Apply and verify migrations before starting.');
  return null;
}

/* CLI: npm run db:migrate (DATABASE_URL povinný) */
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('db:migrate: chýba DATABASE_URL');
    process.exit(1);
  }
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== undefined && mode !== '--schema-fingerprint'))
    throw new Error('Usage: npm run db:migrate -- [--schema-fingerprint]');
  const { dbFromPool, getPool } = await import('./pool');
  const pool = getPool(databaseUrl);
  try {
    const db = dbFromPool(pool);
    if (mode === '--schema-fingerprint') {
      console.log(await readSchemaFingerprint(db));
    } else {
      const applied = await applyMigrations(db);
      console.log('Aplikované migrácie:', applied.join(', ') || '(žiadne)');
    }
  } finally {
    await pool.end();
  }
}
