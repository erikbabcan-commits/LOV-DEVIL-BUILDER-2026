import { parseArgs } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { CloudGitHubConfigurationError, readCloudGitHubConfig } from '../server/integrations/githubRuntime';
import { probeCloudGitHubSchema } from '../server/integrations/githubSchema';

// Deliberately no dotenv/config or server/index import. Explicit file only;
// process env wins, matching the server's default dotenv precedence.
let pool: Pool | undefined;
try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'check-db': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } }, allowPositionals: false });
  if (values.help) {
    console.log('Usage: github:preflight [--env-file <private-file>] [--check-db]\nDefault: configuration only, no network. Optional DB probe is read-only. No secrets as arguments; no automatic dotenv, migrations, binding or GitHub calls. Process environment takes precedence.');
  } else {
    let env = { ...process.env };
    if (values['env-file']) {
      try {
        const file = values['env-file'];
        if (!statSync(file).isFile() || statSync(file).size > 65536) throw new Error('invalid_file');
        env = { ...parse(readFileSync(file)), ...env };
      } catch { throw new CloudGitHubConfigurationError(['env_file_unavailable']); }
    }
    const config = readCloudGitHubConfig(env);
    if (!config) {
      console.log(JSON.stringify({ ok: true, mode: 'disabled', database: 'not_checked', provider: 'not_called' }));
    } else {
      let database: { ready: boolean; issues: string[] } | undefined;
      if (values['check-db']) {
        pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
          application_name: 'lov-cloud-github-preflight', options: '-c default_transaction_read_only=on' });
        await pool.query('BEGIN READ ONLY');
        try {
          database = await probeCloudGitHubSchema({ query: async (sql, params) => { const result = await pool!.query(sql, params); return { rows: result.rows, rowCount: result.rowCount }; } }, config.exportsEnabled);
        } finally { await pool.query('ROLLBACK'); }
      }
      console.log(JSON.stringify({ ok: database?.ready ?? true, mode: config.exportsEnabled ? 'oauth_and_export' : 'oauth_only',
        scope: 'public_repo', database: database ?? 'not_checked', provider: 'not_called', identityBinding: 'operator_required', hostedIntegration: 'not_checked' }));
      if (database && !database.ready) process.exitCode = 1;
    }
  }
} catch (error) {
  // Never echo flags, environment, private file paths or DB/provider exceptions.
  console.log(JSON.stringify({ ok: false, issues: error instanceof CloudGitHubConfigurationError ? error.fields : ['preflight_failed'] }));
  process.exitCode = 1;
} finally { await pool?.end(); }
