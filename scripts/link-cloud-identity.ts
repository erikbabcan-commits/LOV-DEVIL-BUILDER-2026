import { parseArgs } from 'node:util';
import { makeDb, getPool } from '../server/db/pool';
import { linkCloudIdentity } from '../server/auth/linkIdentity';

// No dotenv auto-loading. The operator explicitly selects the database and
// configured Cloud issuer in the process environment. Default is read-only.
let values: { 'user-id'?: string; subject?: string; apply?: boolean } | undefined;
try {
  ({ values } = parseArgs({ options: { 'user-id': { type: 'string' }, subject: { type: 'string' }, apply: { type: 'boolean', default: false } }, allowPositionals: false }));
} catch {
  console.error('Invalid flags. Use --user-id, --subject and optional --apply; never pass credentials as arguments.');
  process.exitCode = 1;
}
const databaseUrl = process.env.DATABASE_URL;
const issuer = process.env.CLOUD_AUTH_ISSUER;
if (!values) {
  // The parser deliberately does not echo unrecognized arguments.
} else if (!databaseUrl || !issuer || !values['user-id'] || !values.subject) {
  console.error('Set DATABASE_URL and CLOUD_AUTH_ISSUER explicitly; pass --user-id and --subject. Default: dry run; --apply creates a new binding only.');
  process.exitCode = 1;
} else {
  try {
    const status = await linkCloudIdentity(makeDb(databaseUrl), { issuer, subject: values.subject, userId: values['user-id'] }, values.apply);
    console.log(JSON.stringify({ status, mode: values.apply ? 'apply' : 'dry-run' }));
    if (status === 'conflict' || status === 'user_not_found') process.exitCode = 1;
  } catch {
    // Never log DB exceptions, environment, URLs, emails or user credentials.
    console.error('Identity link failed; verify configuration, migration 003 and supplied account IDs. No existing binding is overwritten.');
    process.exitCode = 1;
  } finally {
    await getPool(databaseUrl).end();
  }
}
