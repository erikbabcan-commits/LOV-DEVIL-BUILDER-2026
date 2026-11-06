/** Explicit disposable loopback fixture: real signed Cloud JWT/BFF/Hono/SQL/compiler/files; synthetic Stripe only. */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { newDb } from 'pg-mem';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { dbFromPool } from '../../server/db/pool';
import { applyMigrations } from '../../server/db/migrate';
import { HostExecutor } from '../../server/sandbox/executor';
import { PublishService } from '../../server/publish/service';
import { publicPublishApp } from '../../server/publish/public';
import { BillingService } from '../../server/billing/service';
import { verifyBillingEvent } from '../../server/billing/gateway';
import type { BillingConfig, BillingGateway, BillingSession, BillingSubscription } from '../../server/billing/types';
import { registerProjectByteLength } from '../helpers/projectMemoryDb';
import { hybridAiBackend } from './hybridAiBackend';
if(process.env.RELEASE_WORKFLOW_FIXTURE!=='1'||process.env.NODE_ENV!=='test')throw new Error('Explicit release workflow test only');
process.env.GITHUB_ALLOWED_ORIGINS='http://localhost:5191';
const memory=newDb();registerProjectByteLength(memory);const pool=new (memory.adapters.createPg().Pool)(),db=dbFromPool(pool);await applyMigrations(db);
for(const user of ['alice','bob'])await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[user,user+'@example.test','not-a-password']);
const directory=await mkdtemp(join(tmpdir(),'lov-release-publish-'));
const publishConfig={baseUrl:'http://127.0.0.1:8791/',appUrl:'http://localhost:5191/',artifactDir:directory,bind:'127.0.0.1',port:8791,maxArtifacts:20,maxOwnerBytes:30000000,maxArtifactBytes:3000000,allowHostTest:true};
const publisher=new PublishService(db,publishConfig,new HostExecutor());
const config:BillingConfig={secretKey:'sk_test_release_fixture_only',webhookSecret:'whsec_release_fixture_only',appUrl:'http://localhost:5191/',prices:{month:{priceId:'price_release_month',amount:2000},year:{priceId:'price_release_year',amount:20000}}};
const sessions=new Map<string,BillingSession>();let subscriptions:BillingSubscription[]=[];
const gateway:BillingGateway={
 verifyEvent:(raw,signature)=>verifyBillingEvent(raw,signature,config.webhookSecret),
 price:async id=>({id,amount:id===config.prices.month.priceId?2000:20000,currency:'eur',interval:id===config.prices.month.priceId?'month':'year',intervalCount:1,active:true,livemode:false}),
 createCustomer:async user=>({id:'cus_release_'+user,livemode:false}),
 subscriptions:async customer=>({data:subscriptions.filter(s=>s.customerId===customer),hasMore:false}),
 createCheckout:async input=>{const id='cs_test_release_'+sessions.size,session:BillingSession={id,customerId:input.customerId,url:'https://checkout.stripe.com/c/pay/'+id,expiresAt:input.expiresAt,status:'open',livemode:false};sessions.set(id,session);return session;},
 checkout:async id=>{const session=sessions.get(id);if(!session)throw new Error('unknown synthetic checkout');return session;},
 createPortal:async()=>({url:'https://billing.stripe.com/p/session/test_release_fixture'}),
};
const billing=new BillingService(db,config,gateway),backend=await hybridAiBackend(db,true,{billing,publish:publisher}),app=new Hono();
app.get('/__test/session/:user',c=>{const user=c.req.param('user');return backend.tokens[user]?c.json({access_token:backend.tokens[user],user:{id:user,email:user+'@example.test'}}):c.notFound();});
app.get('/__test/billing/:state',async c=>{
 const state=c.req.param('state');if(!['pro','cancel','free'].includes(state))return c.notFound();
 if(!(await db.query('SELECT customer_id FROM billing_accounts WHERE user_id=$1',['alice'])).rows[0]?.customer_id)await billing.checkout('alice','month',crypto.randomUUID());
 subscriptions=state==='free'?[]:[{id:'sub_release_alice',customerId:'cus_release_alice',livemode:false,status:'active',priceId:config.prices.month.priceId,quantity:1,itemsCount:1,periodEnd:Math.floor(Date.now()/1000)+30*86400,trialEnd:null,cancelAtPeriodEnd:state==='cancel',collectionPaused:false}];
 const payload=JSON.stringify({id:'evt_release_'+crypto.randomUUID().replaceAll('-',''),object:'event',type:'customer.subscription.updated',livemode:false,data:{object:{id:'sub_release_alice',customer:'cus_release_alice'}}});
 const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:config.webhookSecret});
 const response=await backend.app.request('/api/billing/webhook',{method:'POST',headers:{'Stripe-Signature':signature},body:payload});
 return c.json({ok:response.ok},response.ok?200:500);
});
app.all('/api/hono/*',async c=>backend.proxy(new Request('http://localhost:5191'+new URL(c.req.url).pathname+new URL(c.req.url).search,{method:c.req.method,headers:c.req.raw.headers,signal:c.req.raw.signal,...(c.req.method==='POST'?{body:await c.req.raw.arrayBuffer()}: {})})));
const api=serve({fetch:app.fetch,hostname:'127.0.0.1',port:8789});
const published=serve({fetch:publicPublishApp(publishConfig,db,publisher.artifacts).fetch,hostname:'127.0.0.1',port:8791});
async function stop(){api.close();published.close();await publisher.settled();await pool.end();await rm(directory,{recursive:true,force:true});process.exit(0);}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
console.log('Release fixture: signed Cloud identities -> BFF -> Hono -> ephemeral SQL; actual compiler/artifact/publicHTTP; Stripe synthetic only. Ports8789/8791');
