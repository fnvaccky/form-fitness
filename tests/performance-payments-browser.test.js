// Deterministic slow-response comparisons. Every API/provider request is intercepted.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const TODAY='2026-10-17', MEMBER='11111111-2222-3333-4444-555555555555';
const baseline=process.env.PAYMENT_PERFORMANCE_BASELINE==='1';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
 const plan=planView({id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength'],available:true,days:30,description:'Membership',features:['Purchased benefit']});
 const member={id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri']},enabled:true,photo:'',plan:'basic',terms:plan,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
 return {user:{id:MEMBER,memberId:MEMBER,role:'member',name:member.name,can:capabilitiesFor('member')},plans:[plan],member,
 invoices:[{id:'INV-PERFORMANCE-001',memberId:MEMBER,plan:'basic',terms:plan,amount:899,amountCents:89900,paidCents:0,start:member.start,end:member.end,due:member.start,created:member.start}],
 checkout:{id:'checkout-performance',status:'pending',url:'https://checkout.paymongo.com/isolated',invoiceId:'INV-PERFORMANCE-001',amount:899,reviewReason:''},
 requests:[],errors:[],unexpected:[],navigation:[],stateDelay:0,statusDelay:250,checkoutDelay:250,statusFailure:false,status:'pending'};
}
const snapshot=f=>({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[{id:f.checkout.id,invoice_id:f.checkout.invoiceId,member_id:MEMBER,status:f.status,checkout_url:f.checkout.url,amount_cents:89900}],outbox:[],settings:{payments:{},email:null},stats:{visitsToday:0},staff:[],unpaidAccounts:[],memberHealth:null,visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:true,methods:['gcash','paymaya','grab_pay','card'],testMode:true}});

describe('focused payment responsiveness and stale-response protection',{concurrency:false},()=>{
 let browser,server,origin;const timings=[];
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await mkdir('test-results/performance',{recursive:true});await writeFile(`test-results/performance/payment-${baseline?'before':'after'}.json`,JSON.stringify({source:baseline?'pre-change source':'working source',kind:'isolated fixed-latency simulation, not live provider timing',statusDelayMs:250,stateDelayMs:500,timings},null,2));});
 async function open(f){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);page.on('pageerror',error=>f.errors.push(error.message));
  await page.addInitScript(()=>document.addEventListener('repready-ready',()=>window.paymentPerformanceReady=true));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname;
   if(url.origin==='https://checkout.paymongo.com'){f.navigation.push(url.href);return route.fulfill({contentType:'text/html',body:'<title>Isolated checkout</title>'});}
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({body:''});
   if(!path.startsWith('/api/'))return route.continue();
   f.requests.push({path,method:request.method(),body:request.method()==='GET'?null:request.postDataJSON(),started:performance.now()});
   let body;
   if(path==='/api/plans')body={plans:f.plans};
   else if(path==='/api/session')body={user:f.user,date:TODAY};
   else if(path==='/api/state'){await wait(f.stateDelay);body=snapshot(f);}
   else if(path==='/api/paymongo/status'){await wait(f.statusDelay);if(f.statusFailure)return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Provider unavailable. Check this existing checkout before trying again.'})});if(f.status==='paid')f.invoices[0].paidCents=89900;body={checkout:{...f.checkout,status:f.status}};}
   else if(path==='/api/paymongo/checkout'){await wait(f.checkoutDelay);body={checkout:f.checkout};}
   else if(path==='/api/member-health')body={health:null};
   else if(path==='/api/logout')body={ok:true};
   else{f.unexpected.push(`${request.method()} ${path}`);return route.fulfill({status:500,contentType:'application/json',body:'{"error":"Unexpected isolated request"}'});}
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${origin}/#/member/payments`);await page.waitForFunction(()=>window.paymentPerformanceReady);return page;
 }
 const clean=f=>{assert.deepEqual(f.unexpected,[]);assert.deepEqual(f.errors,[]);};
 async function statusModal(page){await page.evaluate(()=>showPaymongo({id:'checkout-performance',status:'pending',url:'https://checkout.paymongo.com/isolated',amount:899,reviewReason:''}));}

 test('pending status avoids unrelated state and rendering work; immediate feedback and one request',async()=>{
  const f=fixture(),page=await open(f);try{
   f.stateDelay=500;await statusModal(page);const start=f.requests.length;
   await page.evaluate(()=>{window.paymentPriorModal=document.querySelector('.modal');window.paymentPriorMain=document.querySelector('#main');window.paymentClickAt=performance.now();document.querySelector('[data-action="paymongo-status"]').click();window.paymentFeedback={disabled:document.querySelector('[data-action="paymongo-status"]').disabled,text:document.querySelector('[data-action="paymongo-status"]').textContent,ms:performance.now()-window.paymentClickAt};});
   await page.waitForFunction(()=>!window.paymentPriorModal.isConnected);
   const result=await page.evaluate(()=>({elapsedMs:performance.now()-window.paymentClickAt,feedback:window.paymentFeedback,mainRetained:window.paymentPriorMain===document.querySelector('#main')}));
   const requests=f.requests.slice(start).map(x=>`${x.method} ${x.path}`);timings.push({flow:'pending payment-status refresh',...result,requests});
   assert.equal(result.feedback.disabled,true);assert.equal(f.invoices[0].paidCents,0);
   if(!baseline){assert.match(result.feedback.text,/Checking/);assert.ok(result.feedback.ms<50);assert.equal(result.mainRetained,true);assert.deepEqual(requests,['POST /api/paymongo/status']);}
   else assert.deepEqual(requests,['POST /api/paymongo/status','GET /api/state']);clean(f);
  }finally{await page.close();}
 });

 if(!baseline){
 test('rapid status clicks and repeated install share one operation; failure permits explicit retry',async()=>{
  const f=fixture(),page=await open(f);try{
   await statusModal(page);f.statusFailure=true;const start=f.requests.length;
   await page.evaluate(()=>{installPaymongo();const button=document.querySelector('[data-action="paymongo-status"]');button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
   await page.waitForFunction(()=>document.querySelector('[data-action="paymongo-status"]')?.disabled===false);
   assert.deepEqual(f.requests.slice(start).map(x=>x.path),['/api/paymongo/status']);assert.match(await page.locator('#toast').innerText(),/Provider unavailable/);
   f.statusFailure=false;await page.locator('[data-action="paymongo-status"]').click();await page.waitForFunction(()=>document.querySelector('[data-action="paymongo-status"]')?.disabled===false);
   assert.equal(f.requests.slice(start).filter(x=>x.path==='/api/paymongo/status').length,2);assert.equal(f.invoices[0].paidCents,0);clean(f);
  }finally{await page.close();}
 });
 test('paid response waits for confirmed full state; no optimistic access or success',async()=>{
  const f=fixture(),page=await open(f);try{
   f.status='paid';f.statusDelay=300;f.stateDelay=300;await statusModal(page);const start=f.requests.length;
   await page.locator('[data-action="paymongo-status"]').click();await wait(70);assert.equal(await page.evaluate(()=>state.invoices[0].paidCents),0);assert.doesNotMatch(await page.locator('#toast').innerText(),/confirmed/);
   await page.waitForFunction(()=>document.querySelector('[role="dialog"]')===null);
   assert.equal(await page.evaluate(()=>state.invoices[0].paidCents),89900);assert.deepEqual(f.requests.slice(start).map(x=>x.path),['/api/paymongo/status','/api/state']);assert.match(await page.locator('#toast').innerText(),/confirmed/);clean(f);
  }finally{await page.close();}
 });
 test('closed or navigated status request cannot reopen modal; confirmed checkout state remains usable',async()=>{
  const f=fixture(),page=await open(f);try{
   await statusModal(page);await page.locator('[data-action="paymongo-status"]').click();await page.getByRole('button',{name:'Close',exact:true}).click();await wait(400);
   assert.equal(await page.getByRole('dialog').count(),0);assert.equal(f.invoices[0].paidCents,0);
   await statusModal(page);await page.locator('[data-action="paymongo-status"]').click();await page.evaluate(()=>{closeModal();navigate('overview');});await wait(400);
   assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>section),'overview');clean(f);
  }finally{await page.close();}
 });
 test('auth invalidation suppresses stale status and checkout redirects, clearing intent and private identifiers',async()=>{
  for(const flow of ['status','checkout']){
   const f=fixture(),page=await open(f);try{
    if(flow==='status'){await statusModal(page);await page.locator('[data-action="paymongo-status"]').click();}
    else{await page.evaluate(()=>{state.checkouts=[];pay('INV-PERFORMANCE-001');});await page.locator('#invoice-channel').selectOption('card');await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).click();assert.match(await page.getByRole('button',{name:/Preparing checkout/}).innerText(),/Preparing checkout/);}
    await page.evaluate(()=>{document.dispatchEvent(new Event('repready-auth-changing'));closeModal();currentUser=null;state={members:[],invoices:[],payments:[],activity:[]};render();});await wait(400);
    assert.equal(f.navigation.length,0);assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(await page.evaluate(()=>({intent:paymentIntent,invoice:paymentInvoice})),{intent:'',invoice:null});assert.equal(await page.evaluate(()=>currentUser),null);clean(f);
   }finally{await page.close();}
  }
 });
 test('slow checkout selection is immediate and unchanged; rapid submit makes one financial request only',async()=>{
  const f=fixture(),page=await open(f);try{
   await page.evaluate(()=>{state.checkouts=[];pay('INV-PERFORMANCE-001');});const start=f.requests.length;
   await page.locator('#invoice-channel').selectOption('card');assert.equal(await page.locator('#invoice-channel').inputValue(),'card');assert.equal(f.requests.length,start);
   await page.getByRole('button',{name:'Pay cash at the front desk',exact:true}).click();await page.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await page.locator('#invoice-channel').inputValue(),'card');assert.equal(f.requests.length,start);
   const intent=await page.evaluate(()=>paymentIntent);
   await page.evaluate(()=>{const form=document.getElementById('paymongo-member-form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
   assert.equal(await page.getByRole('button',{name:/Preparing checkout/}).isDisabled(),true);
   await page.waitForURL('https://checkout.paymongo.com/isolated');
   assert.deepEqual(f.requests.slice(start).map(({path,body})=>({path,body})),[{path:'/api/paymongo/checkout',body:{kind:'invoice',invoiceId:'INV-PERFORMANCE-001',method:'card',requestId:intent}}]);assert.equal(f.invoices.length,1);assert.equal(f.invoices[0].paidCents,0);assert.equal(f.navigation.length,1);clean(f);
  }finally{await page.close();}
 });
 }
});
