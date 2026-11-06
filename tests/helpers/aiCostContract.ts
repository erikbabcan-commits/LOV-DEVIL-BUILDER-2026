import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyMigrations } from '../../server/db/migrate';
import type { DbLike } from '../../server/db/pool';
import { PostgresQuotaStore } from '../../server/security/quotaStore';
import { PostgresAiUsageStore, type RunInput } from '../../server/usage/store';
import { parsePricePolicy } from '../../server/usage/pricing';
import { aiCostReport } from '../../server/usage/costReport';
import { meteredProvider } from '../../server/usage/meter';
import { MistralProvider } from '../../server/providers/mistral';
import { signToken } from '../../server/auth/tokens';
import type { ChatMessage } from '../../server/providers/types';
import { createApp, makeMockProvider } from '../../server/index';
const execute=promisify(execFile);
const document={schemaVersion:1,version:'synthetic-v1',currency:'USD',basis:'uncached-text-tokens',rates:[{provider:'mistral',model:'actual-2026',validFrom:'2026-11-01T00:00:00Z',validUntil:'2026-12-01T00:00:00Z',inputUsdPerMillion:'2',outputUsdPerMillion:'6'}]};
export function aiCostContract(connect:()=>Promise<{db:DbLike;close:()=>Promise<void>}>) {
  describe('durable AI cost snapshots and operator reporting',()=>{
    let db:DbLike,close:()=>Promise<void>,store:PostgresAiUsageStore,quota:PostgresQuotaStore;
    const now=()=>new Date('2026-11-06T12:00:00Z');
    const policy=()=>parsePricePolicy(JSON.stringify(document));
    const run=(userId='alice'):RunInput=>({userId,id:randomUUID(),kind:'generation'});
    const complete={status:'completed' as const,actualModel:'actual-2026',usage:{promptTokens:1200,completionTokens:200}};
    const costs=()=>db.query('SELECT status,reason,estimated_cost_microusd,policy_fingerprint,rate_index FROM ai_call_costs ORDER BY call_no');
    beforeEach(async()=>{
      ({db,close}=await connect());await applyMigrations(db);await applyMigrations(db);
      for(const id of ['alice','bob'])await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[id,id+'@example.test','unused']);
      store=new PostgresAiUsageStore(db,now,policy());quota=new PostgresQuotaStore(db,now);
    });
    afterEach(async()=>{await close?.();});
    it('uses the policy and call-start time captured before a rotation, then refuses repricing',async()=>{
      const item=run();await store.admit(item,quota);const call=await store.startCall(item,'mistral','requested-alias');
      const changed=parsePricePolicy(JSON.stringify({...document,version:'synthetic-v2',rates:[{...document.rates[0],inputUsdPerMillion:'100'}]}));
      const reopened=new PostgresAiUsageStore(db,()=>new Date('2026-12-01T00:01:00Z'),changed);
      await reopened.finishCall(item,call,complete);await reopened.finishRun(item,'succeeded');
      expect((await costs()).rows[0]).toMatchObject({status:'priced',estimated_cost_microusd:'3600',policy_fingerprint:policy().fingerprint});
      await expect(reopened.finishCall(item,call,complete)).rejects.toThrow();
      const report=await aiCostReport(db,{month:'2026-11',userId:'alice'},now);
      expect(report.totals).toMatchObject({calls:'1',pricedCalls:'1',estimatedKnownCostUsd:'0.003600',estimatedRecordedCostUsd:'0.003600'});
      expect(report.policies).toEqual([{version:'synthetic-v1',fingerprint:policy().fingerprint}]);
      expect((await aiCostReport(db,{month:'2026-12'},now)).totals.calls).toBe('0');
      expect(await store.report('alice')).not.toHaveProperty('estimatedKnownCostUsd');
    });
    it('does not retrofit a new price policy onto a previously unpriced reservation',async()=>{
      const item=run(),unpriced=new PostgresAiUsageStore(db,now);await unpriced.admit(item,quota);const call=await unpriced.startCall(item,'mistral','alias');
      await store.finishCall(item,call,complete);
      expect((await costs()).rows[0]).toMatchObject({status:'unpriced',reason:'no_policy',estimated_cost_microusd:null,policy_fingerprint:null});
      expect((await aiCostReport(db,{month:'2026-11'},now)).totals).toMatchObject({unknownCostCalls:'1',estimatedKnownCostUsd:'0.000000',estimatedRecordedCostUsd:null});
    });
    it('keeps usage, model and effective-rate gaps explicit instead of inventing a zero price',async()=>{
      const item=run();await store.admit(item,quota);
      for(const result of [{...complete,usage:null},{...complete,actualModel:null},{...complete,actualModel:'other-model'}]){
        const call=await store.startCall(item,'mistral','alias');await store.finishCall(item,call,result);
      }
      expect((await costs()).rows.map(row=>[row.status,row.reason,row.estimated_cost_microusd])).toEqual([
        ['unpriced','unknown_usage',null],['unpriced','model_missing',null],['unpriced','no_effective_rate',null],
      ]);
    });
    it('records a genuine zero estimate and excludes a known not-sent call',async()=>{
      const item=run();await store.admit(item,quota);
      const zero=await store.startCall(item,'mistral','alias');await store.finishCall(item,zero,{...complete,usage:{promptTokens:0,completionTokens:0}});
      const absent=await store.startCall(item,'mistral','alias');await store.finishCall(item,absent,{status:'not_sent',actualModel:null,usage:null});
      expect((await costs()).rows.map(row=>[row.status,row.estimated_cost_microusd])).toEqual([['priced','0'],['not_sent',null]]);
      expect((await aiCostReport(db,{month:'2026-11'},now)).totals).toMatchObject({calls:'1',pricedCalls:'1',estimatedRecordedCostUsd:'0.000000'});
    });
    it('rolls back the whole reservation and makes no provider call if the cost snapshot cannot be written',async()=>{
      const broken:DbLike={query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
        if(sql.includes('INSERT INTO ai_call_costs'))throw new Error('synthetic-cost-write-failure');return tx.query(sql,params);
      }}))};
      const failed=new PostgresAiUsageStore(broken,now,policy()),item=run(),provider=makeMockProvider(),inference=vi.spyOn(provider,'complete');
      await failed.admit(item,new PostgresQuotaStore(broken,now));
      await expect(meteredProvider(provider,failed,item).provider.complete([])).rejects.toThrow('Záznam spotreby');
      expect(inference).not.toHaveBeenCalled();expect((await db.query('SELECT call_count FROM ai_runs')).rows[0].call_count).toBe(0);
      expect((await db.query('SELECT * FROM ai_calls')).rows).toEqual([]);expect((await costs()).rows).toEqual([]);
      expect((await db.query('SELECT * FROM ai_price_policies')).rows).toEqual([]);
    });
    it('rolls back cost and usage together when completion storage fails',async()=>{
      const item=run();await store.admit(item,quota);const call=await store.startCall(item,'mistral','alias');
      const broken:DbLike={query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
        if(sql.includes('UPDATE ai_calls SET'))throw new Error('synthetic-completion-write-failure');return tx.query(sql,params);
      }}))};
      await expect(new PostgresAiUsageStore(broken,now,policy()).finishCall(item,call,complete)).rejects.toThrow();
      expect((await costs()).rows[0]).toMatchObject({status:'pending',estimated_cost_microusd:null});
      expect((await db.query('SELECT status,prompt_tokens FROM ai_calls')).rows[0]).toEqual({status:'prepared',prompt_tokens:null});
      expect((await aiCostReport(db,{month:'2026-11'},now)).totals).toMatchObject({pendingCalls:'1',unknownCostCalls:'1',estimatedRecordedCostUsd:null});
    });
    it('fails closed if a stored policy no longer matches its content address',async()=>{
      const item=run();await store.admit(item,quota);const call=await store.startCall(item,'mistral','alias');
      await db.query('UPDATE ai_price_policies SET document=$1::jsonb',[JSON.stringify({...document,version:'tampered'})]);
      await expect(store.finishCall(item,call,complete)).rejects.toThrow();
      await expect(store.startCall(item,'mistral','alias')).rejects.toThrow();
      expect((await db.query('SELECT call_count FROM ai_runs')).rows[0].call_count).toBe(1);
      await expect(aiCostReport(db,{month:'2026-11'},now)).rejects.toThrow();
      expect((await costs()).rows[0]).toMatchObject({status:'pending'});
      expect((await db.query('SELECT status FROM ai_calls')).rows[0].status).toBe('prepared');
    });
    it('groups by the plan at admission and keeps owners and filters separate',async()=>{
      const first=run();await store.admit(first,quota);await store.finishCall(first,await store.startCall(first,'mistral','alias'),complete);
      await db.query("UPDATE users SET plan='pro' WHERE id=$1",['alice']);
      const second=run();await store.admit(second,quota);await store.startCall(second,'mistral','alias');
      const bob=run('bob');await store.admit(bob,quota);await store.finishCall(bob,await store.startCall(bob,'mistral','alias'),complete);
      const report=await aiCostReport(db,{month:'2026-11'},now);
      expect(report.accounts.map(row=>[row.userId,row.admissionPlan,row.calls,row.estimatedRecordedCostUsd])).toEqual([
        ['alice','free','1','0.003600'],['alice','pro','1',null],['bob','free','1','0.003600'],
      ]);
      expect((await aiCostReport(db,{month:'2026-11',userId:'alice',plan:'free'},now)).totals).toMatchObject({calls:'1',estimatedRecordedCostUsd:'0.003600'});
      expect((await aiCostReport(db,{month:'2026-11',userId:'missing'},now)).accounts).toEqual([]);
    });
    it('preserves populated v008 calls as legacy unknown costs on migration replay',async()=>{
      await db.query('DROP TABLE ai_call_costs');await db.query('DROP TABLE ai_price_policies');
      const item=run();await quota.consumeRecorded(item.userId,async(tx,snapshot,period)=>{
        await tx.query('INSERT INTO ai_runs(user_id,id,kind,period_start,plan,started_at) VALUES($1,$2,$3,$4,$5,$6)',[item.userId,item.id,item.kind,period,snapshot.plan,now()]);
      });
      await db.query(`INSERT INTO ai_calls(user_id,run_id,call_no,provider,requested_model,status,started_at,prompt_tokens,completion_tokens)
        VALUES($1,$2,1,'mistral','alias','completed',$3,1200,200)`,[item.userId,item.id,now()]);
      await applyMigrations(db);await applyMigrations(db);
      expect((await costs()).rows).toEqual([]);
      expect((await aiCostReport(db,{month:'2026-11'},now)).totals).toMatchObject({calls:'1',legacyCallsWithoutCostSnapshot:'1',unknownCostCalls:'1',estimatedRecordedCostUsd:null});
    });
    it('enforces cost-state constraints and cascades account deletion while retaining source-free policies',async()=>{
      const item=run();await store.admit(item,quota);await store.startCall(item,'mistral','alias');
      for(const update of ["status='priced'","status='unpriced',reason=NULL","status='not_sent',reason=NULL","estimated_cost_microusd=1"])
        await expect(db.query('UPDATE ai_call_costs SET '+update)).rejects.toThrow();
      await store.finishCall(item,1,complete);await db.query('DELETE FROM users WHERE id=$1',['alice']);
      expect((await costs()).rows).toEqual([]);expect((await db.query('SELECT * FROM ai_calls')).rows).toEqual([]);
      expect((await db.query('SELECT fingerprint FROM ai_price_policies')).rows).toHaveLength(1);
    });
    it('rejects missing cost migrations before consuming monthly quota or opening an inference stream',async()=>{
      await db.query('DROP TABLE ai_call_costs');
      const provider=makeMockProvider(),inference=vi.spyOn(provider,'complete'),secret='missing-cost-schema-secret-01234567890123456789';
      const token=await signToken({sub:'alice',email:'alice@example.test',plan:'free'},secret);
      const app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await app.request('/api/agent/generate',{method:'POST',headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify({projectId:'p',prompt:'Build a dashboard',mode:'create'})});
      expect(response.status).toBe(503);expect(await response.json()).toMatchObject({error:'quota_unavailable'});
      expect(inference).not.toHaveBeenCalled();expect(await quota.usage('alice')).toMatchObject({used:0});
      expect((await db.query('SELECT * FROM ai_runs')).rows).toEqual([]);
    });
    it('wires configured pricing through signed HTTP generation without exposing costs in customer API',async()=>{
      const mock=makeMockProvider(),provider=new MistralProvider({apiKey:'synthetic-unused',model:'requested-alias'}, {postChat:async body=>{
        const result=await mock.complete((body as {messages:ChatMessage[]}).messages);
        return Response.json({model:'actual-2026',choices:[{message:{content:result.text},finish_reason:'stop'}],usage:{prompt_tokens:1200,completion_tokens:200}});
      }});
      const pricing=parsePricePolicy(JSON.stringify({...document,rates:[{...document.rates[0],validFrom:'2000-01-01T00:00:00Z',validUntil:'9998-01-01T00:00:00Z'}]}));
      const secret='cost-http-secret-01234567890123456789',token=await signToken({sub:'alice',email:'alice@example.test',plan:'free'},secret);
      const app=createApp({aiPricing:pricing},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const headers={Cookie:'lov_token='+token+'; lov_csrf=cost-test','X-CSRF-Token':'cost-test','Content-Type':'application/json'};
      const response=await app.request('/api/agent/generate',{method:'POST',headers,body:JSON.stringify({projectId:'price-test',prompt:'Build a small dashboard',mode:'create'})});
      expect(response.status).toBe(200);expect(await response.text()).toContain('"type":"done"');
      const customer=await app.request('/api/ai-usage',{headers}),payload=await customer.json();
      expect(payload).toMatchObject({calls:2,reportedCalls:2,promptTokens:2400,completionTokens:400});
      expect(JSON.stringify(payload)).not.toMatch(/cost|price|policy|currency/i);
      const report=await aiCostReport(db,{month:new Date().toISOString().slice(0,7)},now);
      expect(report.totals).toMatchObject({calls:'2',pricedCalls:'2',estimatedRecordedCostUsd:'0.007200'});
    });
    it('runs the CLI with SELECT-only credentials, explicit private config and no automatic dotenv or writes',async()=>{
      const item=run();await store.admit(item,quota);await store.finishCall(item,await store.startCall(item,'mistral','alias'),complete);
      const schema=(await db.query('SELECT current_schema() AS name')).rows[0].name;
      const role='report_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      const directory=await mkdtemp(join(tmpdir(),'lov-report-'));
      try{
        const url=new URL(process.env.PROJECTS_TEST_DATABASE_URL!);url.username=role;url.password=password;url.searchParams.set('options','-c search_path='+schema);
        const config=join(directory,'private.env');await writeFile(config,'DATABASE_URL='+url.toString()+'\n',{mode:0o600});
        await writeFile(join(directory,'.env'),'DATABASE_URL=postgresql://private-secret@127.0.0.1:1/wrong\n',{mode:0o600});
        const env={...process.env};delete env.DATABASE_URL;env.MISTRAL_API_KEY='';env.LOV_SERVER='0';env.NODE_ENV='test';
        const args=[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/ai-usage-report.ts'),'--month','2026-11','--user-id','alice','--env-file',config,'--html-output',join(directory,'private-report.html')];
        const output=await execute(process.execPath,args,{cwd:directory,env,timeout:15000,maxBuffer:100_000});
        const report=JSON.parse(output.stdout);expect(report).toMatchObject({ok:true,coverage:'recorded_calls_only',totals:{estimatedRecordedCostUsd:'0.003600'}});
        const html=await readFile(join(directory,'private-report.html'),'utf8');
        expect(html).toContain('0.003600');expect(html).toContain("connect-src 'none'");expect((await stat(join(directory,'private-report.html'))).mode&0o777).toBe(0o600);
        expect(output.stdout).not.toMatch(/password_hash|private-secret|postgresql:|alice@example|prompt.*content/);
        expect((await costs()).rows[0]).toMatchObject({estimated_cost_microusd:'3600'});
        try {await execute(process.execPath,args,{cwd:directory,env,timeout:15000});throw new Error('Expected exclusive output refusal');}
        catch(error){expect((error as {stdout:string}).stdout).toContain('ai_usage_report_failed');}
        expect(await readFile(join(directory,'private-report.html'),'utf8')).toBe(html);
        await chmod(config,0o644);
        try {await execute(process.execPath,args,{cwd:directory,env,timeout:15000});throw new Error('Expected CLI refusal');}
        catch(error){expect((error as {stdout:string}).stdout).toContain('ai_usage_report_failed');expect((error as {stdout:string}).stdout).not.toContain(directory);}
      }finally{
        await rm(directory,{recursive:true,force:true});await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
        await db.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);await db.query(`DROP ROLE ${role}`);
      }
    }, 55_000); // Three bounded CLI processes plus SQL setup; application/provider deadlines are unchanged.
  });
}
