import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { dbFromPool } from '../server/db/pool';
import { authLogRetentionWindow, retainAuthLog } from '../server/auth/logRetention';

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      limit: { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: auth:log-retention --days <1–3650> [--limit <1–10000>] [--apply]\n' +
      'Uses DATABASE_URL from the environment. Dry run is the default. Each apply deletes at most one batch.');
  } else {
    const window = authLogRetentionWindow(values.days ?? '', values.limit ?? '1000');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol))
      throw new Error('database_unavailable');
    const apply = values.apply === true;
    pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      lock_timeout: 1000,
      application_name: 'lov-auth-log-retention',
    });
    const report = await dbFromPool(pool).transaction!(async db => {
      if (!apply) await db.query('SET TRANSACTION READ ONLY');
      return retainAuthLog(db, window, apply);
    });
    console.log(JSON.stringify({ ok: true, ...report }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, error: 'auth_log_retention_failed' }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
