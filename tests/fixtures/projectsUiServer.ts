import {PATCH_PROJECT_FILES,patchFixtureProvider} from './patchProject';
import {BUILD_REPAIR_FILES,buildRepairFixtureProvider} from './buildRepairProject';
import { ProviderRegistry } from '../../server/providers/registry';
import { ProviderError } from '../../server/providers/errors';
import { InMemoryAiUsageStore } from '../../server/usage/store';
/** Disposable loopback-only UI fixture. No application secrets or real accounts. */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { newDb } from 'pg-mem';
import { dbFromPool } from '../../server/db/pool';
import { registerProjectByteLength } from '../helpers/projectMemoryDb';
import { createApp, makeMockProvider } from '../../server/index';
import { applyMigrations } from '../../server/db/migrate';
import { InMemoryQuotaStore } from '../../server/security/quotaStore';
import { signToken } from '../../server/auth/tokens';
import { BLUEPRINT_REGISTRY } from '../../src/templates/registry';
import { WorkspaceSchema } from '../../shared/projectSchema';
if(process.env.PROJECTS_UI_FIXTURE!=='1'||process.env.NODE_ENV!=='test')throw new Error('Test fixture only');
process.env.GITHUB_ALLOWED_ORIGINS='http://localhost:5176';
const mem=newDb();registerProjectByteLength(mem);
const adapter=mem.adapters.createPg(),pool=new adapter.Pool(),db=dbFromPool(pool);
await applyMigrations(db);
for(const id of ['alice','bob'])await db.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',[id,id+'@example.test','not-a-login-password']);
const patchFixture=process.env.PATCH_UI_FIXTURE==='1';
const buildRepairFixture=process.env.BUILD_REPAIR_UI_FIXTURE==='1';
const files=(buildRepairFixture?BUILD_REPAIR_FILES:patchFixture?PATCH_PROJECT_FILES:BLUEPRINT_REGISTRY[1].files).map(file=>({name:file.path,content:file.content,modified:false}));
const conversation=process.env.CONTEXT_UI_FIXTURE==='1'?Array.from({length:26},(_,i)=>({role:i%2?'assistant':'user',content:i===0?'Značka Acme, slovenčina, bez newslettera.':'Syntetická správa '+i})):undefined;
const workspace=WorkspaceSchema.parse({conversation,title:buildRepairFixture?'Kontrola opravy buildu':patchFixture?'Kontrola patchu':'Tímový Kanban',isPublic:false,liveId:'seed-v1',snapshots:[{id:'seed-v1',v:1,prompt:'Kanban template',kind:'template',time:'test',html:files.find(file=>file.name==='index.html')!.content,sourceFiles:JSON.stringify(files)}],files});
await db.query('INSERT INTO builder_projects (owner_id,project_id,title,revision,workspace) VALUES ($1,$2,$3,1,$4::jsonb)',['alice',buildRepairFixture?'fixture-build-repair':'fixture-kanban',workspace.title,JSON.stringify(workspace)]);
const secret='disposable-ui-fixture-signing-secret-0123456789',app=new Hono();
app.get('/__test/session/:user',async c=>{
 const user=c.req.param('user');if(!['alice','bob'].includes(user))return c.notFound();
 const token=await signToken({sub:user,email:user+'@example.test',plan:'free'},secret);
 c.header('Set-Cookie','lov_token='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
 c.header('Set-Cookie','lov_csrf=fixture-csrf; Path=/; SameSite=Lax; Max-Age=3600',{append:true});
 return c.redirect('http://localhost:5176/');
});
const fixtureQuota=new InMemoryQuotaStore();for(let i=0;i<8;i++)await fixtureQuota.consume('alice');
const fixtureProviders=process.env.RESILIENCE_UI_FIXTURE==='1'?new ProviderRegistry([
 {id:'mistral',label:'AI (Mistral)',provider:{...makeMockProvider(),name:'mistral',model:'fixture-mistral',complete:async()=>{throw new ProviderError('unavailable');}}},
 {id:'openai',label:'AI (OpenAI)',provider:{...makeMockProvider(),name:'openai',model:'fixture-openai'}}
],['openai']):undefined;
app.route('/',createApp({sandboxMode:'host',projectStorage:{maxBytes:64*1024*1024,maxProjects:1}},buildRepairFixture?buildRepairFixtureProvider():patchFixture?patchFixtureProvider():makeMockProvider(),{providers:fixtureProviders,rateLimit:()=>true,auth:{db,usage: new InMemoryAiUsageStore(), jwtSecret:secret,quota:fixtureQuota}}));
serve({fetch:app.fetch,hostname:'127.0.0.1',port:8788});
console.log('Disposable project UI server: 127.0.0.1:8788 (pg-mem, mock AI, alice/bob test accounts)');
