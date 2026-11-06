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

/* CLI: npm run db:migrate (DATABASE_URL povinný) */
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('db:migrate: chýba DATABASE_URL');
    process.exit(1);
  }
  const { makeDb } = await import('./pool');
  const db = makeDb(databaseUrl);
  const applied = await applyMigrations(db);
  console.log('Aplikované migrácie:', applied.join(', ') || '(žiadne)');
  process.exit(0);
}
