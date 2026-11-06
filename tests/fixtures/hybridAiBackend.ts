import type {BillingService} from '../../server/billing/service';
import type {PublishService} from '../../server/publish/service';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import type {DbLike} from '../../server/db/pool';
import {makeCloudAuth} from '../../server/auth/cloud';
import {makeHonoProxy} from '../../server/integrations/honoProxy';
import {createApp} from '../../server/index';
import {InMemoryQuotaStore,PostgresQuotaStore} from '../../server/security/quotaStore';
import {InMemoryAiUsageStore,PostgresAiUsageStore} from '../../server/usage/store';
import {PATCH_PROJECT_FILES,patchFixtureProvider} from './patchProject';
/** Ephemeral signed test identity + actual bridge/Hono/compiler, no external calls. */
export async function hybridAiBackend(db:DbLike,durable=false,extras:{billing?:BillingService;publish?:PublishService}={}){
 const issuer='https://hybrid-fixture.supabase.co/auth/v1',pair=await generateKeyPair('ES256'),key=await exportJWK(pair.publicKey);
 const cloud=makeCloudAuth(db,issuer,createLocalJWKSet({keys:[{...key,kid:'hybrid-fixture',alg:'ES256'}]})),tokens:Record<string,string>={};
 for(const user of ['alice','bob']){await db.query('INSERT INTO identity_links(issuer,subject,user_id) VALUES($1,$2,$3)',[issuer,'cloud-'+user,user]);tokens[user]=await new SignJWT({role:'authenticated'}).setProtectedHeader({alg:'ES256',kid:'hybrid-fixture'}).setIssuer(issuer).setSubject('cloud-'+user).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);}
 const files=PATCH_PROJECT_FILES.map(f=>({name:f.path,content:f.content,modified:false})),workspace={title:'Hybridná testovacia aplikácia',isPublic:false,liveId:'hybrid-v1',snapshots:[{id:'hybrid-v1',v:1,prompt:'Original fixture',kind:'ai',time:'test',html:files.find(f=>f.name==='index.html')!.content,sourceFiles:JSON.stringify(files)}],files,conversation:[]};
 await db.query('INSERT INTO builder_projects(owner_id,project_id,title,revision,workspace) VALUES($1,$2,$3,1,$4::jsonb)',['alice','hybrid-fixture',workspace.title,JSON.stringify(workspace)]);
 const quota=durable?new PostgresQuotaStore(db):new InMemoryQuotaStore(),usage=durable?new PostgresAiUsageStore(db):new InMemoryAiUsageStore();
 const app=createApp({sandboxMode:'host'},patchFixtureProvider(),{rateLimit:()=>true,auth:{db,jwtSecret:'hybrid-test-cookie-secret-01234567890123456789',cloudAuth:cloud,quota,usage,...extras}});
 const proxy=makeHonoProxy({baseUrl:'https://hono.fixture.test',authenticate:async request=>{const token=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';return await cloud.resolve(token)?{accessToken:token}:null;},fetch:async(input,init)=>app.fetch(new Request(input,init))});
 return{proxy,tokens,quota,usage,workspace,app};
}
