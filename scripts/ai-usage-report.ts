import { renderAiCostDashboard } from '../server/usage/dashboard';
import { parseArgs } from 'node:util';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { aiCostReport, costReportWindow, type CostReportFilter } from '../server/usage/costReport';

// No dotenv/config or server/index import; no API keys accepted or needed.
let pool: Pool | undefined;
try {
  const {values}=parseArgs({options:{'html-output':{type:'string'},'env-file':{type:'string'},month:{type:'string'},'user-id':{type:'string'},plan:{type:'string'},help:{type:'boolean',default:false}},allowPositionals:false});
  if (values.help) {
    console.log('Usage: ai:usage-report --month YYYY-MM [--user-id <internal-id>] [--plan free|pro] [--env-file <private-file>] [--html-output <new-private-html>]\nJSON on stdout; optional offline HTML dashboard, created exclusively with mode 0600. Uses DATABASE_URL, with process environment taking precedence. No automatic dotenv, migrations, provider requests, repricing or billing writes. Reports recorded calls only; uncached token estimates in USD, not invoices or margins.');
  } else {
    const filter:CostReportFilter={month:values.month??'',...(values['user-id']===undefined?{}:{userId:values['user-id']}),...(values.plan===undefined?{}:{plan:values.plan as 'free'|'pro'})};
    costReportWindow(filter);
    let env={...process.env};
    if (values['env-file']) {
      const stat=statSync(values['env-file']);
      if (!stat.isFile() || stat.size>65_536 || (stat.mode&0o077)!==0) throw new Error('env_file_unavailable');
      env={...parse(readFileSync(values['env-file'])),...env};
    }
    const databaseUrl=env.DATABASE_URL;
    if (!databaseUrl || !['postgres:','postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('database_unavailable');
    pool=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:5000,
      application_name:'lov-ai-usage-report',options:'-c default_transaction_read_only=on'});
    const client=await pool.connect();
    let report: Awaited<ReturnType<typeof aiCostReport>> | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        report=await aiCostReport({query:async(sql,params)=>{const result=await client.query(sql,params);return {rows:result.rows,rowCount:result.rowCount};}},filter);
      } finally {await client.query('ROLLBACK');}
    } finally {client.release();}
    if (!report) throw new Error('report_unavailable');
    if (values['html-output']) writeFileSync(values['html-output'],renderAiCostDashboard(report),{encoding:'utf8',mode:0o600,flag:'wx'});
    console.log(JSON.stringify({ok:true,...report,...(values['html-output']?{html:{written:true}}:{})}));
  }
} catch {
  // Never echo CLI flags, file paths, environment, private identifiers or DB errors.
  console.log(JSON.stringify({ok:false,issues:['ai_usage_report_failed']}));process.exitCode=1;
} finally {await pool?.end();}
