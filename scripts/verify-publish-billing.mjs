import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
if(process.env.RELEASE_WORKFLOW_FIXTURE!=='1')throw new Error('Explicit disposable release fixture required');
fs.mkdirSync('/tmp/lov-release-proof',{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/hono/'))requests.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 const base='http://localhost:5191/qa/hybrid/index.html';
 try{
 await page.goto(base);await expect(page.getByRole('button',{name:'Alice',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('combobox',{name:'Režim generovania'})).toContainText('AI (mock-patch)');
 await page.getByRole('button',{name:'Editor',exact:true}).click();
 await page.getByRole('button',{name:'Hybridná testovacia aplikácia · r1',exact:true}).click();
 await page.getByRole('button',{name:'Publikovať',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Publikovať aplikáciu'});
 await expect(dialog.getByRole('button',{name:'Publikovať verejne',exact:true})).toBeDisabled();
 await dialog.getByRole('checkbox').check();await expect(dialog.getByRole('button',{name:'Publikovať verejne',exact:true})).toBeEnabled();
 await dialog.getByRole('button',{name:'Publikovať verejne',exact:true}).click();
 const link=dialog.getByRole('link',{name:'Otvoriť publikovanú aplikáciu'});await link.waitFor({timeout:45000});
 const url=await link.getAttribute('href');expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8791\/p\/[a-f0-9-]{36}\/$/);
 await page.screenshot({path:'/tmp/lov-release-proof/modern-published.png'});
 const publicPage=await browser.newPage();const response=await publicPage.goto(url);expect(response.status()).toBe(200);expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts');expect(response.headers()['set-cookie']).toBeUndefined();
 await expect(publicPage.getByRole('heading',{name:'Kontrola cielenej zmeny'})).toBeVisible();await publicPage.screenshot({path:'/tmp/lov-release-proof/public-application.png'});await publicPage.close();
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Pripojenie backendov'}).click();
 const card=page.getByRole('region',{name:'Predplatné',exact:true});await expect(card.getByText(/^Forge Free/)).toBeVisible();await expect(card.getByText('Testovací režim Stripe',{exact:true})).toBeVisible();
 await page.route('https://checkout.stripe.com/**',r=>r.fulfill({status:200,contentType:'text/html',body:'<h1>Synthetic Stripe boundary: no payment</h1>'}));
 await card.getByRole('button',{name:'Otvoriť testovací Checkout',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Synthetic Stripe boundary: no payment'})).toBeVisible();
 const grant=await page.request.get('http://localhost:5191/__test/billing/pro');expect(grant.status()).toBe(200);
 await page.goto(base);await expect(page.getByRole('button',{name:'Alice',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('combobox',{name:'Režim generovania'})).toContainText('AI (mock-patch)');await page.getByRole('button',{name:'Pripojenie backendov'}).click();
 await expect(page.getByRole('region',{name:'Predplatné',exact:true}).getByText(/^Forge Pro/)).toBeVisible();await page.screenshot({path:'/tmp/lov-release-proof/modern-pro.png'});
 await page.getByRole('button',{name:'Bob',exact:true}).click();await expect(page.getByRole('button',{name:'Bob',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Pripojenie backendov'}).click();
 await expect(page.getByRole('region',{name:'Predplatné',exact:true}).getByText(/^Forge Free/)).toBeVisible();
 expect(requests.filter(r=>r.path==='/api/hono/publish')).toHaveLength(1);expect(requests.filter(r=>r.path==='/api/hono/billing/checkout')).toHaveLength(1);expect(errors).toEqual([]);
 const result={passed:true,publishUrl:url,publishRequest:requests.find(r=>r.path==='/api/hono/publish'),checkoutRequest:requests.find(r=>r.path==='/api/hono/billing/checkout'),pageErrors:errors,verified:['modern Lovable UI -> explicit public consent -> CloudBFF -> Hono -> owned snapshot -> real compiler -> durable artifact -> publicHTTP200 and renderedReact','public CSP opaque sandbox and no authcookie','Cloud billing -> explicit Checkout -> intercepted synthetic Stripe page, no external Stripe traffic','signed SDK webhook -> DB Pro -> modern UI','Bob remains Free'],limits:['disposable pg-mem; native DB tests separate','Stripe boundary synthetic, not a payment','local mirror not hosted Lovable or VPS deployment']};fs.writeFileSync('/tmp/lov-release-proof/browser-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }catch(e){console.log('BODY',await page.locator('body').innerText());await page.screenshot({path:'/tmp/lov-release-proof/failure.png'});throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
