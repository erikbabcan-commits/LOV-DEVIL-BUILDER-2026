import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { dbFromPool } from '../server/db/pool';
import { productReportWindow, weeklyProductReport } from '../server/usage/productReport';

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: { week: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('Usage: product:weekly-report --week YYYY-MM-DD [--env-file <private-file>]\nUse the UTC Monday. Returns aggregate JSON only. DATABASE_URL comes from the environment or explicitly supplied private file.');
  } else {
    const week = values.week ?? '';
    productReportWindow(week);
    let databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl && values['env-file']) {
      const file = statSync(values['env-file']);
      if (!file.isFile() || file.size > 65_536 || (file.mode & 0o077) !== 0)
        throw new Error('env_file_unavailable');
      databaseUrl = parse(readFileSync(values['env-file'])).DATABASE_URL;
    }
    if (!databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
      throw new Error('database_unavailable');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      application_name: 'lov-product-weekly-report',
      options: '-c default_transaction_read_only=on',
    });
    console.log(JSON.stringify({ ok: true, ...await weeklyProductReport(dbFromPool(pool), week) }));
  }
} catch {
  console.log(JSON.stringify({ ok: false, issues: ['product_weekly_report_failed'] }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
