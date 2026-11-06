import type { DbLike } from '../db/pool';

interface Index { table_name: string; unique_key: boolean; valid: boolean; columns: string[]; predicate: string | null }
const normalize = (value: string) => value.replace(/\s|[()"]|::text/g, '');
const reserved = normalize("status = ANY (ARRAY['prepared'::text, 'running'::text, 'succeeded'::text, 'failed'::text])");
const states = normalize("CHECK (status = ANY (ARRAY['prepared'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'expired'::text]))");

/** Read-only deployment probe: column permissions, unique indexes and status
 * contract. No data rows, identity links, migration writes or GitHub calls. */
export async function probeCloudGitHubSchema(db: DbLike, exportsEnabled: boolean): Promise<{ ready: boolean; issues: string[] }> {
  const issues: string[] = [];
  const probes = [
    ['identity_columns', 'SELECT u.id,u.email,u.plan,l.issuer,l.subject,l.user_id FROM identity_links l JOIN users u ON u.id=l.user_id LIMIT 0'],
    ['oauth_columns', 'SELECT owner_id,state_hash,nonce_hash,expires_at,consumed,verifier_cipher,connection_cipher,connection_expires_at FROM github_pending LIMIT 0'],
    ...(exportsEnabled ? [
      ['export_columns', 'SELECT owner_id,request_id,repo_name,github_username,selection,source_hash,fingerprint,connection_hash,status,result,expires_at,checkpoint,reconciled_at FROM github_exports LIMIT 0'],
      ['project_columns', 'SELECT owner_id,project_id,revision,workspace,deleted_at FROM builder_projects LIMIT 0'],
    ] : []),
  ];
  for (const [name, sql] of probes) { try { await db.query(sql); } catch { issues.push(name); } }
  try {
    const result = await db.query(`SELECT tab.relname AS table_name, idx.indisunique AS unique_key, idx.indisvalid AS valid,
      ARRAY(SELECT pg_get_indexdef(idx.indexrelid,k.n,true) FROM generate_series(1,idx.indnkeyatts) AS k(n) ORDER BY k.n) AS columns,
      pg_get_expr(idx.indpred,idx.indrelid) AS predicate
      FROM pg_catalog.pg_index idx JOIN pg_catalog.pg_class tab ON tab.oid=idx.indrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
      WHERE ns.nspname=current_schema() AND tab.relname IN ('identity_links','github_pending','github_exports','builder_projects')`);
    const indexes = result.rows as Index[];
    const has = (table: string, columns: string[], predicate: string | null = null) => indexes.some(index => index.table_name === table && index.unique_key && index.valid &&
      Array.isArray(index.columns) && index.columns.join(',') === columns.join(',') && (predicate === null ? index.predicate === null : typeof index.predicate === 'string' && normalize(index.predicate) === predicate));
    for (const [table, columns] of [
      ['identity_links', ['issuer','subject']], ['identity_links', ['issuer','user_id']],
      ['github_pending', ['owner_id']], ['github_pending', ['state_hash']],
      ...(exportsEnabled ? [['github_exports', ['owner_id','request_id']], ['builder_projects', ['owner_id','project_id']]] : []),
    ] as Array<[string,string[]]>) if (!has(table, columns)) issues.push(table + '_unique_' + columns.join('_'));
    if (exportsEnabled && !has('github_exports', ['owner_id','repo_name'], reserved)) issues.push('export_name_reservation');
    if (exportsEnabled) {
      const constraints = await db.query(`SELECT pg_get_constraintdef(con.oid) AS definition FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class tab ON tab.oid=con.conrelid JOIN pg_catalog.pg_namespace ns ON ns.oid=tab.relnamespace
        WHERE ns.nspname=current_schema() AND tab.relname='github_exports' AND con.contype='c' AND con.convalidated`);
      if (!constraints.rows.some(row => typeof row.definition === 'string' && normalize(row.definition) === states)) issues.push('export_status_constraint');
    }
  } catch { issues.push('schema_catalog_unavailable'); }
  return { ready: issues.length === 0, issues };
}
