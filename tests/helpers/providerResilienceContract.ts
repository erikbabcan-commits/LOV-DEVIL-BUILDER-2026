import {sourceHash} from '../../server/agent/patches';
import {PATCH_PROJECT_FILES} from '../fixtures/patchProject';
import {BUILD_REPAIR_FILES,BUILD_REPAIR_MARKER} from '../fixtures/buildRepairProject';
import {HostExecutor} from '../../server/sandbox/executor';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {DbLike} from '../../server/db/pool';
import {applyMigrations} from '../../server/db/migrate';
import {PostgresQuotaStore} from '../../server/security/quotaStore';
import {PostgresAiUsageStore} from '../../server/usage/store';
import {parsePricePolicy} from '../../server/usage/pricing';
import {ProviderRegistry} from '../../server/providers/registry';
import {MistralProvider} from '../../server/providers/mistral';
import {OpenAIProvider} from '../../server/providers/openai';
import {AnthropicProvider} from '../../server/providers/anthropic';
import {signToken} from '../../server/auth/tokens';
import {createApp,makeMockProvider} from '../../server/index';
import type {ChatMessage} from '../../server/providers/types';

export function providerResilienceContract(connect:()=>Promise<{db:DbLike;close:()=>Promise<void>}>){
  describe('real HTTP admission and per-attempt PostgreSQL provider accounting',()=>{
    let db:DbLike,close:()=>Promise<void>,quota:PostgresQuotaStore,token:string;
    const secret='provider-pg-secret-01234567890123456789';
    const input={projectId:'provider-test',prompt:'Build a small dashboard',mode:'create',modelId:'mistral'};
    const policy=parsePricePolicy(JSON.stringify({schemaVersion:1,version:'synthetic-route-prices',currency:'USD',basis:'uncached-text-tokens',rates:[{provider:'openai',model:'openai-actual',validFrom:'2000-01-01T00:00:00Z',validUntil:'9998-01-01T00:00:00Z',inputUsdPerMillion:'0.5',outputUsdPerMillion:'2'}]}));
    const setup=()=>{
      const mock=makeMockProvider(),primary=vi.fn(async()=>Response.json({error:{message:'synthetic outage'}},{status:503}));
      const openai=vi.fn(async(body:unknown)=>{
        const messages=(body as {input:Array<{role:string;content:string}>}).input.map(message=>({...message,role:message.role==='developer'?'system':message.role})) as ChatMessage[];
        const result=await mock.complete(messages);return Response.json({status:'completed',model:'openai-actual',output:[{type:'message',content:[{type:'output_text',text:result.text}]}],usage:{input_tokens:100,output_tokens:500}});
      });
      const anthropic=vi.fn(async(body:unknown)=>{
        const data=body as {system:string;messages:ChatMessage[]},result=await mock.complete([{role:'system',content:data.system},...data.messages]);
        return Response.json({model:'claude-actual',stop_reason:'end_turn',content:[{type:'text',text:result.text}],usage:{input_tokens:10,output_tokens:20}});
      });
      const primaryProvider=new MistralProvider({apiKey:'unused',model:'mistral-test'},{postChat:primary});
      const registry=new ProviderRegistry([{id:'mistral',label:'AI (Mistral)',provider:primaryProvider},{id:'openai',label:'AI (OpenAI)',provider:new OpenAIProvider('openai-test',{postChat:openai})},{id:'anthropic',label:'AI (Claude)',provider:new AnthropicProvider('claude-test',{postChat:anthropic})}],['openai','anthropic']);
      return{primary,openai,anthropic,primaryProvider,registry};
    };
    const request=(app:ReturnType<typeof createApp>,body:unknown=input,signal?:AbortSignal)=>app.request(new Request('http://localhost/api/agent/generate',{method:'POST',signal,headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify(body)}));
    beforeEach(async()=>{
      ({db,close}=await connect());await applyMigrations(db);
      for(const id of ['alice','bob'])await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[id,id+'@example.test','unused']);
      quota=new PostgresQuotaStore(db);token=await signToken({sub:'alice',email:'alice@example.test',plan:'free'},secret);
    });afterEach(async()=>{await close?.();});
    it('records each rejected primary attempt and sticky backup call while charging one monthly task',async()=>{
      const p=setup(),app=createApp({aiPricing:policy},p.primaryProvider,{providers:p.registry,resilience:{sleep:async()=>{},random:()=>0},rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{...input,allowFallback:true,fallbackIds:['openai','anthropic']});expect(response.status).toBe(200);const events=await response.text();
      expect(events).toContain('"reason":"retry"');expect(events).toContain('"reason":"fallback"');expect(events).toContain('"type":"done"');
      expect(p.primary).toHaveBeenCalledTimes(2);expect(p.openai).toHaveBeenCalledTimes(2);expect(p.anthropic).not.toHaveBeenCalled();
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(await quota.usage('bob')).toMatchObject({used:0});
      expect((await db.query('SELECT provider,status,actual_model FROM ai_calls ORDER BY call_no')).rows).toEqual([
        {provider:'mistral',status:'failed',actual_model:null},{provider:'mistral',status:'failed',actual_model:null},
        {provider:'openai',status:'completed',actual_model:'openai-actual'},{provider:'openai',status:'completed',actual_model:'openai-actual'},
      ]);
      expect((await db.query('SELECT status,estimated_cost_microusd FROM ai_call_costs ORDER BY call_no')).rows).toEqual([
        {status:'unpriced',estimated_cost_microusd:null},{status:'unpriced',estimated_cost_microusd:null},{status:'priced',estimated_cost_microusd:'1050'},{status:'priced',estimated_cost_microusd:'1050'},
      ]);
      expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:4,reportedCalls:2,unknownCalls:2,promptTokens:200,completionTokens:1000});
    });
    it('records a physical plan/patch pair and stages exactly one materialized colour change',async()=>{
      const files=PATCH_PROJECT_FILES.map(f=>({...f})),css=files.find(f=>f.path==='src/index.css')!;
      const postChat=vi.fn(async(body:unknown)=>{
        const messages=(body as {messages:Array<{content:string}>}).messages;
        const payload=messages[0].content.includes('Forge Edit Planner')?{summary:'One colour',steps:[{id:'color',title:'Change colour'}],filesPlanned:['src/index.css']}:{version:1,summary:'Only primary colour',changes:[{path:'src/index.css',action:'modify',beforeSha256:sourceHash(css.content),edits:[{search:'#2563eb',replace:'#dc2626'}]}]};
        return Response.json({model:'patch-actual',choices:[{message:{content:JSON.stringify(payload)}}],usage:{prompt_tokens:10,completion_tokens:20}});
      });
      const provider=new MistralProvider({apiKey:'unused',model:'patch-fixture'},{postChat}),app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{projectId:'color',mode:'iterate',prompt:'Zmeň iba farbu hlavného tlačidla.',context:{files,history:[]}}),text=await response.text();
      const events=text.split('\n\n').filter(e=>e.startsWith('data: ')).map(e=>JSON.parse(e.slice(6))),stage=events.find(e=>e.type==='stage');expect(stage).toMatchObject({editMode:'patch',files:[{path:'src/index.css',action:'modify',content:css.content.replace('#2563eb','#dc2626')}]});expect(stage.files).toHaveLength(1);expect(text).toContain('"type":"done"');expect(postChat).toHaveBeenCalledTimes(2);
      const payload=JSON.parse((postChat.mock.calls[1][0] as {messages:Array<{content:string}>}).messages[1].content);expect(payload.files.find((f:{path:string})=>f.path==='src/index.css').sha256).toBe(sourceHash(css.content));
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:2,reportedCalls:2,promptTokens:20,completionTokens:40});expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'succeeded'}]);
    });
    it('repairs a real compiler diagnostic with one exact patch and durable autofix accounting',async()=>{
      const files=BUILD_REPAIR_FILES.map(file=>({...file})),original=JSON.stringify(files);
      const postChat=vi.fn(async(body:unknown)=>{const data=JSON.parse((body as {messages:Array<{content:string}>}).messages[1].content),file=data.files.find((f:{path:string})=>f.path==='src/App.tsx');expect(data.errors[0].message).toContain('ERROR');return Response.json({model:'repair-actual',choices:[{message:{content:JSON.stringify({version:1,summary:'Remove only synthetic syntax error',changes:[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:BUILD_REPAIR_MARKER,replace:''}]}]})}}],usage:{prompt_tokens:7,completion_tokens:9}});});
      const provider=new MistralProvider({apiKey:'unused',model:'repair-fixture'},{postChat}),app=createApp({},provider,{sandbox:new HostExecutor(),rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await app.request('/api/sandbox/autofix',{method:'POST',headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify({files})}),result=await response.json();
      expect(response.status).toBe(200);expect(result).toMatchObject({ok:true,attempts:1,patchesApplied:1});expect(result.finalFiles).toEqual(PATCH_PROJECT_FILES);expect(JSON.stringify(files)).toBe(original);expect(postChat).toHaveBeenCalledOnce();expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:1,reportedCalls:1,promptTokens:7,completionTokens:9});expect((await db.query('SELECT kind,status FROM ai_runs')).rows).toEqual([{kind:'autofix',status:'succeeded'}]);
    });
    it('rebuilds two precise candidates with fresh source hashes while admitting the autofix task once',async()=>{
      const inputs:Array<{content:string;sha256:string}>=[],postChat=vi.fn(async(body:unknown)=>{const data=JSON.parse((body as {messages:Array<{content:string}>}).messages[1].content),file=data.files.find((f:{path:string})=>f.path==='src/App.tsx');inputs.push(file);return Response.json({model:'repair-actual',choices:[{message:{content:JSON.stringify({version:1,summary:'Progressive synthetic repair',changes:[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:inputs.length===1?BUILD_REPAIR_MARKER:'const broken = {\n',replace:inputs.length===1?'const broken = {\n':''}]}]})}}],usage:{prompt_tokens:7,completion_tokens:9}});});
      const provider=new MistralProvider({apiKey:'unused',model:'repair-fixture'},{postChat}),app=createApp({},provider,{sandbox:new HostExecutor(),rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await app.request('/api/sandbox/autofix',{method:'POST',headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify({files:BUILD_REPAIR_FILES})}),result=await response.json();expect(result).toMatchObject({ok:true,attempts:2,patchesApplied:2});expect(result.finalFiles).toEqual(PATCH_PROJECT_FILES);expect(inputs[1].sha256).toBe(sourceHash(inputs[1].content));expect(inputs[1].sha256).not.toBe(inputs[0].sha256);expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:2,reportedCalls:2,promptTokens:14,completionTokens:18});
    });
    it('rejects an oversized repair context before recording an AI run or consuming monthly usage',async()=>{
      const postChat=vi.fn(),provider=Object.assign(new MistralProvider({apiKey:'unused',model:'small-repair'},{postChat}),{contextWindowTokens:8192});
      const app=createApp({},provider,{sandbox:new HostExecutor(),rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}}),files=[{path:'src/main.tsx',content:'// keep\n'.repeat(2000)+'const x = {'}];
      const response=await app.request('/api/sandbox/autofix',{method:'POST',headers:{Cookie:'lov_token='+token+'; lov_csrf=test','X-CSRF-Token':'test','Content-Type':'application/json'},body:JSON.stringify({files})});expect(response.status).toBe(413);expect(await response.json()).toMatchObject({error:'context_limit'});expect(postChat).not.toHaveBeenCalled();expect(await quota.usage('alice')).toMatchObject({used:0});expect((await db.query('SELECT * FROM ai_runs')).rows).toEqual([]);
    });
    it('records a failed conflicted patch without regeneration or any partial stage',async()=>{
      const files=PATCH_PROJECT_FILES.map(f=>({...f})),css=files.find(f=>f.path==='src/index.css')!,appSource=files.find(f=>f.path==='src/App.tsx')!;
      const postChat=vi.fn(async(body:unknown)=>{const messages=(body as {messages:Array<{content:string}>}).messages;const payload=messages[0].content.includes('Forge Edit Planner')?{summary:'Two targeted edits',steps:[{id:'edit',title:'Edit files'}],filesPlanned:['src/index.css','src/App.tsx']}:{version:1,summary:'Conflicted fixture',changes:[{path:css.path,action:'modify',beforeSha256:sourceHash(css.content),edits:[{search:'#2563eb',replace:'#dc2626'}]},{path:appSource.path,action:'delete',beforeSha256:'0'.repeat(64)}]};return Response.json({model:'patch-actual',choices:[{message:{content:JSON.stringify(payload)}}],usage:{prompt_tokens:10,completion_tokens:20}});});
      const provider=new MistralProvider({apiKey:'unused',model:'patch-fixture'},{postChat}),app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}}),original=JSON.stringify(files);
      const response=await request(app,{projectId:'color',mode:'fix',prompt:'Oprav iba dotknuté súbory.',context:{files,history:[]}}),text=await response.text();expect(text).toContain('"code":"patch_conflict"');expect(text).not.toContain('"type":"stage"');expect(text).not.toContain('"type":"file_started"');expect(postChat).toHaveBeenCalledTimes(2);expect(JSON.stringify(files)).toBe(original);
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:2,reportedCalls:2});expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'failed'}]);
    });
    it('classifies and streams a read-only question with durable usage and no project mutation',async()=>{
      const workspace={title:'Current project',isPublic:false,liveId:'v1',snapshots:[{id:'v1',v:1,prompt:'Current',kind:'manual',time:'now',html:'<main>Current</main>'}],files:[{name:'src/App.tsx',content:'export const original=true;'}]};
      await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)',['alice','readonly',workspace.title,JSON.stringify(workspace)]);
      const postChat=vi.fn(async(body:unknown)=>{
        if((body as {stream?:boolean}).stream)return new Response('data: '+JSON.stringify({model:'actual-readonly',choices:[{delta:{content:'Odpoveď k aktuálnemu projektu. Súbory sa nemenili.'}}]})+'\n\ndata: '+JSON.stringify({model:'actual-readonly',choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:50,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
        return Response.json({model:'actual-readonly',choices:[{message:{content:'{"intent":"explain"}'}}],usage:{prompt_tokens:5,completion_tokens:2}});
      });
      const provider=new MistralProvider({apiKey:'unused',model:'read-only-test'},{postChat}),app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{projectId:'readonly',prompt:'Prečo to funguje takto? Iba vysvetli.',mode:'auto',context:{files:[{path:'src/App.tsx',content:workspace.files[0].content}],history:[]}});
      const events=await response.text();expect(events).toContain('"type":"text_delta"');expect(events).toContain('"type":"done"');expect(events).not.toContain('"type":"stage"');expect(events).not.toContain('"type":"plan"');expect(postChat).toHaveBeenCalledTimes(2);
      expect((await db.query('SELECT revision,workspace FROM builder_projects WHERE project_id=$1',['readonly'])).rows).toEqual([{revision:1,workspace}]);
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:2,reportedCalls:2,unknownCalls:0,promptTokens:55,completionTokens:32});
      expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'succeeded'}]);
    });
    it('retains the spent classifier call but never generates after an invalid intent decision',async()=>{
      const postChat=vi.fn(async()=>Response.json({model:'actual-classifier',choices:[{message:{content:'{"intent":"invalid","private":"do-not-echo"}'}}],usage:{prompt_tokens:5,completion_tokens:2}}));
      const provider=new MistralProvider({apiKey:'unused',model:'classifier-fixture'},{postChat}),app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{projectId:'intent',prompt:'Čo teraz?',mode:'auto'}),events=await response.text();expect(events).toContain('"type":"error"');expect(events).not.toContain('do-not-echo');expect(events).not.toContain('"type":"stage"');expect(postChat).toHaveBeenCalledOnce();
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:1,reportedCalls:1});expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'failed'}]);
    });
    it('meters semantic memory with generation once and rejects oversized snapshots before admission',async()=>{
      const provider=makeMockProvider(),complete=vi.spyOn(provider,'complete');
      const app=createApp({},provider,{rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const conversation=Array.from({length:26},(_,i)=>({role:i%2?'assistant':'user',content:'Brand Acme, conversation '+i}));
      const body={...input,modelId:undefined,context:{files:[{path:'src/App.tsx',content:'//'.repeat(2200)+'\nexport const tailMarker=true;'}],history:[],conversation}};
      const response=await request(app,body);const events=await response.text();expect(events).toContain('"type":"context_update"');expect(events).toContain('"type":"done"');
      expect(complete).toHaveBeenCalledTimes(3);expect(complete.mock.calls[1][0][1].content).toContain('tailMarker');
      expect(await quota.usage('alice')).toMatchObject({used:1});
      expect(await new PostgresAiUsageStore(db).report('alice')).toMatchObject({calls:3,reportedCalls:3,unknownCalls:0,promptTokens:230,completionTokens:1020});
      expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'succeeded'}]);
      expect((await request(app,{...body,context:{...body.context,files:[{path:'src/App.tsx',content:'x'.repeat(100000)}]}})).status).toBe(413);
      expect(await quota.usage('alice')).toMatchObject({used:1});expect(complete).toHaveBeenCalledTimes(3);
    });
    it('selects Claude directly and never sends the request to another provider without backup consent',async()=>{
      const p=setup(),app=createApp({},p.primaryProvider,{providers:p.registry,resilience:{sleep:async()=>{}},rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{...input,modelId:'anthropic'});expect(await response.text()).toContain('"type":"done"');
      expect(p.anthropic).toHaveBeenCalledTimes(2);expect(p.primary).not.toHaveBeenCalled();expect(p.openai).not.toHaveBeenCalled();
      expect((await db.query('SELECT DISTINCT provider FROM ai_calls')).rows).toEqual([{provider:'anthropic'}]);
      const failed=await request(app,input);expect(await failed.text()).toContain('"type":"error"');expect(p.primary).toHaveBeenCalledTimes(2);expect(p.openai).not.toHaveBeenCalled();expect(p.anthropic).toHaveBeenCalledTimes(2);
    });
    it('rejects unknown models and stale backup consent before changing quota or recording calls',async()=>{
      const p=setup(),app=createApp({},p.primaryProvider,{providers:p.registry,rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      for(const bad of [{...input,modelId:'unknown'},{...input,allowFallback:true},{...input,allowFallback:true,fallbackIds:['openai']},{...input,allowFallback:true,fallbackIds:['anthropic','openai']}])expect((await request(app,bad)).status).toBe(400);
      expect(await quota.usage('alice')).toMatchObject({used:0});expect((await db.query('SELECT * FROM ai_runs')).rows).toEqual([]);expect(p.primary).not.toHaveBeenCalled();
      expect((await app.request('/api/ai-models')).status).toBe(401);
      const catalog=await app.request('/api/ai-models',{headers:{Cookie:'lov_token='+token}});expect(catalog.status).toBe(200);expect(catalog.headers.get('Cache-Control')).toBe('no-store');
      expect(await catalog.json()).toMatchObject({defaultId:'mistral',models:[{id:'mistral'},{id:'openai'},{id:'anthropic'}]});
    });
    it('stops the entire fallback chain if bookkeeping fails after the first provider rejection',async()=>{
      const p=setup(),broken:DbLike={query:db.query,transaction:work=>db.transaction!(tx=>work({query:async(sql,params)=>{
        if(sql.includes('UPDATE ai_calls SET'))throw new Error('synthetic-private-db-error');return tx.query(sql,params);
      }}))};
      const app=createApp({},p.primaryProvider,{providers:p.registry,resilience:{sleep:async()=>{}},rateLimit:()=>true,auth:{db:broken,jwtSecret:secret,quota:new PostgresQuotaStore(broken)}});
      const response=await request(app,{...input,allowFallback:true,fallbackIds:['openai','anthropic']});const events=await response.text();expect(events).toContain('"type":"error"');expect(events).not.toContain('synthetic-private-db-error');
      expect(p.primary).toHaveBeenCalledOnce();expect(p.openai).not.toHaveBeenCalled();expect(p.anthropic).not.toHaveBeenCalled();
      expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'incomplete'}]);expect((await db.query('SELECT status FROM ai_calls')).rows).toEqual([{status:'prepared'}]);
    });
    it('cancels during backoff without sending a retry or backup request',async()=>{
      const p=setup(),abort=new AbortController();
      const sleep=vi.fn(async(_ms:number,signal?:AbortSignal)=>new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true})));
      const app=createApp({},p.primaryProvider,{providers:p.registry,resilience:{sleep},rateLimit:()=>true,auth:{db,jwtSecret:secret,quota}});
      const response=await request(app,{...input,allowFallback:true,fallbackIds:['openai','anthropic']},abort.signal);
      await vi.waitFor(()=>expect(sleep).toHaveBeenCalledOnce());abort.abort();expect(await response.text()).toContain('"type":"cancelled"');
      expect(p.primary).toHaveBeenCalledOnce();expect(p.openai).not.toHaveBeenCalled();expect(p.anthropic).not.toHaveBeenCalled();
      expect((await db.query('SELECT status FROM ai_runs')).rows).toEqual([{status:'cancelled'}]);
    });
  });
}
