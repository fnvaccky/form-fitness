// Two real tabs share an isolated server session. No hosted accounts or API writes.
import assert from 'node:assert/strict';
import {after,before,describe,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor,planView} from '../src/state.js';

const TODAY='2026-10-17',A='11111111-2222-3333-4444-555555555555',B='22222222-3333-4444-5555-666666666666';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const user=id=>id?{id,memberId:id,role:'member',workspace:'production',name:id===A?'First Private Member':'Second Private Member',can:capabilitiesFor('member')}:null;
function fixture(current=A){
 const plans=[planView({id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength'],available:true,days:30,description:'Membership',features:['Frozen purchased benefit']})];
 return {current,plans,requests:[],errors:[],unexpected:[],pages:new Map(),sessionDelay:0,sessionFailure:false,loginDelay:0,holdState:null,holdProgress:null,holdLogout:null,stateFailures:{}};
}
function snapshot(f,id){
 const account=user(id),member={id,name:account.name,email:(id===A?'first':'second')+'@example.invalid',phone:'09170000001',goal:'Improve fitness',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:TODAY+'T00:00:00Z'},enabled:true,photo:'',plan:'basic',terms:f.plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
 return {user:account,date:TODAY,members:[member],plans:f.plans,invoices:[{id:'INV-'+(id===A?'FIRST':'SECOND'),memberId:id,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start}],memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},stats:undefined,memberHealth:{heightCm:175,weightKg:id===A?70:88,ageBand:'20plus',conditions:[],updatedAt:TODAY+'T00:00:00Z'},paymongo:{configured:true,methods:['gcash','paymaya','grab_pay','card'],testMode:true}};
}
function progress(id){
 const weight=id===A?70:88,goal={id:'goal-'+id,periodId:'period-'+id,goalType:'maintain',status:'active',startDate:'2026-10-12',startingWeightKg:weight,measurementDate:'2026-10-12',targetWeightKg:null,recordedAt:'2026-10-12T00:00:00Z',endedAt:null};
 return {today:TODAY,currentGoal:goal,goals:[goal],measurements:[{id:'weight-'+id,date:'2026-10-12',weightKg:weight,recordedAt:goal.recordedAt,updatedAt:goal.recordedAt}],healthWeight:{weightKg:weight,recordedAt:goal.recordedAt}};
}

describe('server-revalidated cross-tab authentication',{concurrency:false},()=>{
 let browser,server,origin;
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

 async function setup(f,{fallback=false}={}){
  const context=await browser.newContext();
  await context.addInitScript(({fallback})=>{
   window.__syncMessages=[];window.__syncStorage=[];window.__syncEvents=[];
   document.addEventListener('repready-ready',()=>window.__syncReady=true);
   document.addEventListener('repready-auth-changing',()=>window.__syncEvents.push({kind:'changing',at:performance.now()}));
   document.addEventListener('repready-auth-committed',event=>window.__syncEvents.push({kind:'committed',detail:event.detail}));
   const nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){window.__syncStorage.push({key,value});return nativeSet.call(this,key,value);};
   if(fallback){Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true});return;}
   const Native=window.BroadcastChannel;
   window.BroadcastChannel=class extends Native{constructor(name){super(name);this.__testName=name;}postMessage(message){window.__syncMessages.push({name:this.__testName,message:structuredClone(message)});return super.postMessage(message);}};
  },{fallback});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),page=request.frame().page(),label=f.pages.get(page)||'opening',id=f.current;
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({body:''});
   if(!path.startsWith('/api/'))return route.continue();
   f.requests.push({label,path,method});let status=200,body;
   if(path==='/api/plans')body={plans:f.plans};
   else if(path==='/api/session'){await wait(f.sessionDelay);status=f.sessionFailure?502:200;body=status===200?{user:user(id),date:TODAY}:{error:'Session could not be checked. Try again.'};}
   else if(path==='/api/state'){
    const hold=f.holdState?.label===label?f.holdState:null;
    if(hold){f.holdState=null;hold.started.resolve();await hold.release.promise;status=hold.status||200;}
    if(f.stateFailures[label]){f.stateFailures[label]--;status=502;}
    if(status===200&&!id)status=401;body=status===200?snapshot(f,id):{error:status===502?'The workspace could not be loaded. Please sign in again to retry.':'The earlier session expired.'};
   }else if(path==='/api/login'&&method==='POST'){const input=request.postDataJSON();await wait(f.loginDelay);f.current=input.email.startsWith('second')?B:A;body={ok:true,user:user(f.current)};}
   else if(path==='/api/logout'&&method==='POST'){const hold=f.holdLogout;f.holdLogout=null;if(hold){hold.started.resolve();await hold.release.promise;}f.current=null;body={ok:true};}
   else if(path==='/api/member-progress'){
    const hold=f.holdProgress?.label===label?f.holdProgress:null;
    if(hold){f.holdProgress=null;hold.started.resolve();await hold.release.promise;}
    status=id?200:401;body=id?{memberProgress:progress(id)}:{error:'Member access required.'};
   }else{f.unexpected.push(`${method} ${path}`);status=500;body={error:'Unexpected isolated request'};}
   try{return await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}catch(error){if(!/closed|disposed|aborted/i.test(error.message))throw error;}
  });
  async function open(label,section='overview'){
   const page=await context.newPage();f.pages.set(page,label);page.setDefaultTimeout(7000);page.on('pageerror',error=>f.errors.push(error.message));await page.goto(`${origin}/#/member/${section}`);await page.waitForFunction(()=>document.querySelector('#login-form')||window.__syncReady);return page;
  }
  const first=await open('first'),second=await open('second');return {context,first,second,open};
 }
 const current=page=>page.evaluate(()=>currentUser?.id||null);
 const accountAt=(page,id)=>page.waitForFunction(expected=>(currentUser?.id||null)===expected&&(!expected||state.user?.id===expected),id);
 async function login(page,second=false){await page.locator('#login-email').fill((second?'second':'first')+'@example.invalid');await page.locator('#login-password').fill('isolated-password-value');await page.locator('#login-form button[type="submit"]').click();await accountAt(page,second?B:A);}
 const logout=async page=>{await page.getByRole('button',{name:'Log out',exact:true}).click();await accountAt(page,null);};
 const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);};
 async function noPrivateMessages(...pages){
  for(const page of pages){const messages=await page.evaluate(()=>({broadcast:window.__syncMessages,storage:window.__syncStorage})),encoded=JSON.stringify(messages);assert.doesNotMatch(encoded,/isolated-password|First Private|Second Private|memberHealth|weightKg|conditions|Bearer|access_token|refresh_token|token_hash/);assert.equal(encoded.includes(A)||encoded.includes(B),false,'no account identities are broadcast');const payloads=[...messages.broadcast.map(item=>item.message),...messages.storage.filter(item=>item.key==='repready.session.changed.v1').map(item=>JSON.parse(item.value))];for(const payload of payloads){assert.ok(JSON.stringify(payload).length<1024);assert.deepEqual(Object.keys(payload).sort(),['id','phase','reason','v']);assert.ok(['begin','committed'].includes(payload.phase));assert.equal(payload.v,1);}}
 }

 test('BroadcastChannel login/logout uses two tabs and clears the receiver before its slow session check',async()=>{
  const f=fixture(null),{context,first,second}=await setup(f);try{
   await login(first);await accountAt(second,A);assert.match(await second.locator('#main').innerText(),/First/);
   f.sessionDelay=350;await logout(first);await second.waitForFunction(()=>currentUser===null);
   assert.equal(await second.evaluate(()=>state.members.length),0);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member/);
   await second.locator('#login-form').waitFor();assert.equal(await current(second),null);assert.equal(await second.locator('#login-form').isVisible(),true);await noPrivateMessages(first,second);const receiverCommits=await second.evaluate(()=>window.__syncEvents.filter(event=>event.kind==='committed'));assert.equal(receiverCommits.length,0,'receiving invalidation never rebroadcasts a committed event');clean(f);
  }finally{await context.close();}
 });
 test('login begins cross-tab invalidation without unlocking its saving form or repeating credentials',async()=>{
  const f=fixture(null),{context,first,second}=await setup(f);try{
   f.loginDelay=300;await first.locator('#login-email').fill('first@example.invalid');await first.locator('#login-password').fill('isolated-password-value');const before=f.requests.length;
   const saving=await first.evaluate(()=>{const form=document.getElementById('login-form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));const button=form.querySelector('[type="submit"]');return {submitting:form.dataset.submitting,disabled:button.disabled,text:button.textContent};});
   assert.equal(saving.submitting,'true');assert.equal(saving.disabled,true);assert.match(saving.text,/Signing in/);
   await first.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});await wait(100);
   assert.equal(f.requests.slice(before).filter(row=>row.label==='first'&&row.path==='/api/session').length,0,'focus does not race the local sign-in request');
   await accountAt(first,A);await accountAt(second,A);assert.equal(f.requests.slice(before).filter(row=>row.path==='/api/login').length,1);await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });
 test('slow logout immediately hides private data and blocks a new login until confirmation',async()=>{
  const f=fixture(),{context,first,second}=await setup(f),hold={started:deferred(),release:deferred()};try{
   f.holdLogout=hold;const before=f.requests.length;await first.getByRole('button',{name:'Log out',exact:true}).click();await hold.started.promise;await accountAt(first,null);await second.waitForFunction(()=>currentUser===null);
   assert.deepEqual(await first.evaluate(()=>state.members),[]);assert.doesNotMatch(await first.locator('body').innerText(),/First Private Member/);
   assert.equal(await first.locator('#login-form button[type="submit"]').isDisabled(),true,'server logout must finish before a new login');
   await first.evaluate(()=>{document.getElementById('login-email').value='second@example.invalid';document.getElementById('login-password').value='isolated-password-value';document.getElementById('login-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await wait(100);
   assert.equal(f.requests.slice(before).filter(row=>row.path==='/api/login').length,0,'stale/programmatic submission cannot race the pending logout');
   hold.release.resolve();await first.waitForFunction(()=>!document.querySelector('#login-form button[type="submit"]')?.disabled);await login(first,true);await accountAt(second,B);
   assert.equal(f.requests.slice(before).filter(row=>row.path==='/api/logout').length,1);assert.equal(f.requests.slice(before).filter(row=>row.path==='/api/login').length,1);await noPrivateMessages(first,second);clean(f);
  }finally{hold.release.resolve();await context.close();}
 });
 test('a confirmed login followed by a failed workspace load remains private and allows explicit retry',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await logout(first);await accountAt(second,null);f.stateFailures.first=1;const before=f.requests.length;
   await first.locator('#login-email').fill('second@example.invalid');await first.locator('#login-password').fill('isolated-password-value');await first.locator('#login-form button[type="submit"]').click();
   await first.waitForFunction(()=>document.querySelector('#login-form .form-error')?.textContent.includes('workspace'));
   assert.equal(await current(first),null);assert.deepEqual(await first.evaluate(()=>state.members),[]);assert.doesNotMatch(await first.locator('body').innerText(),/First Private Member|Second Private Member/);assert.equal(await first.locator('#login-form button[type="submit"]').isDisabled(),false);
   assert.equal(f.requests.slice(before).filter(row=>row.label==='first'&&row.path==='/api/login').length,1,'no automatic login mutation retry');
   await login(first,true);await accountAt(second,B);assert.deepEqual(await first.evaluate(()=>state.members.map(member=>member.id)),[B]);assert.equal(f.requests.slice(before).filter(row=>row.label==='first'&&row.path==='/api/login').length,2);await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });

 for(const status of [200,401])test(`old account state ${status} cannot restore or sign out a newer account`,async()=>{
  const f=fixture(),{context,first,second}=await setup(f);const hold={label:'second',status,started:deferred(),release:deferred()};try{
   f.holdState=hold;await second.evaluate(()=>{window.__heldRefresh=refreshData().catch(error=>error.code||error.message);});await hold.started.promise;
   await logout(first);await accountAt(second,null);await login(first,true);await accountAt(second,B);
   hold.release.resolve();await second.evaluate(()=>window.__heldRefresh);await wait(100);
   assert.equal(await current(second),B);assert.deepEqual(await second.evaluate(()=>state.members.map(member=>member.id)),[B]);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member/);await noPrivateMessages(first,second);clean(f);
  }finally{hold.release.resolve();await context.close();}
 });

 test('account changes clear private goal drafts and reject delayed previous-owner progress',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);const hold={label:'second',started:deferred(),release:deferred()};try{
   await second.evaluate(()=>navigate('goal'));await second.locator('#progress-summary').waitFor();assert.match(await second.locator('#progress-summary').innerText(),/70\.0 kg/);
   await second.locator('[data-action="progress-record-weight"]').click();await second.locator('#progress-weightKg').fill('77.7');
   f.holdProgress=hold;await second.locator('[data-action="progress-retry"]').click();await hold.started.promise;
   await logout(first);await accountAt(second,null);assert.equal(await second.locator('#progress-weight-form').count(),0);await login(first,true);await accountAt(second,B);
   hold.release.resolve();await second.evaluate(()=>navigate('goal'));await second.locator('#progress-summary').waitFor();assert.match(await second.locator('#progress-summary').innerText(),/88\.0 kg/);assert.doesNotMatch(await second.locator('#member-progress').innerText(),/70\.0|77\.7/);
   assert.equal(await second.locator('#progress-weight-form').count(),0);clean(f);
  }finally{hold.release.resolve();await context.close();}
 });

 test('storage fallback synchronizes login/logout without private values',async()=>{
  const f=fixture(null),{context,first,second}=await setup(f,{fallback:true});try{
   await login(first);await accountAt(second,A);await logout(first);await accountAt(second,null);await second.locator('#login-form').waitFor();assert.equal(await second.locator('#login-form').isVisible(),true);assert.ok((await first.evaluate(()=>window.__syncStorage)).length>0);await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });

 test('a hidden receiver immediately clears data and safely refreshes on return',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await second.evaluate(()=>{Object.defineProperty(document,'visibilityState',{get:()=>window.__hidden?'hidden':'visible',configurable:true});Object.defineProperty(document,'hidden',{get:()=>!!window.__hidden,configurable:true});window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
   f.sessionDelay=250;await logout(first);await second.waitForFunction(()=>currentUser===null);assert.equal(await second.evaluate(()=>state.members.length),0);
   await login(first,true);await second.waitForFunction(()=>currentUser===null||currentUser.id==='22222222-3333-4444-5555-666666666666');
   await second.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});await accountAt(second,B);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member/);clean(f);
  }finally{await context.close();}
 });

 test('duplicate script installation and invalidation bursts do not create refresh loops',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await second.addScriptTag({url:origin+'/session-sync.js'});await second.addScriptTag({url:origin+'/session-sync.js'});f.sessionDelay=200;const before=f.requests.length;
   await first.evaluate(()=>{for(let index=0;index<5;index++)document.dispatchEvent(new CustomEvent('repready-auth-committed',{detail:{reason:'login'}}));});await accountAt(second,A);await wait(600);
   const reads=f.requests.slice(before).filter(row=>row.label==='second'&&row.path==='/api/session');assert.ok(reads.length>=1&&reads.length<=2,`burst coalesced to ${reads.length} checks`);
   const stable=f.requests.length;await wait(300);assert.equal(f.requests.length,stable,'receivers do not trigger a broadcast/refresh loop');assert.equal((await second.evaluate(()=>window.__syncMessages)).length,0);clean(f);
  }finally{await context.close();}
 });

 test('pagehide/pageshow reconnects once and revalidates the current server session',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await second.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));f.current=B;
   await second.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await accountAt(second,B);
   await logout(first);await accountAt(second,null);const before=f.requests.length;await wait(300);assert.ok(f.requests.length-before<=1,'returning tab has no repeated listeners/poll loop');clean(f);
  }finally{await context.close();}
 });
 test('failed receiver revalidation keeps data hidden and supports an explicit safe retry',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   f.sessionFailure=true;await logout(first);await second.waitForFunction(()=>currentUser===null);await wait(300);
   assert.equal(await second.evaluate(()=>state.members.length),0);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member/);
   f.sessionFailure=false;f.current=B;f.sessionDelay=300;const before=f.requests.length;
   await second.evaluate(()=>{for(let index=0;index<3;index++)document.querySelector('[data-action="sync-session"]')?.click();});await accountAt(second,B);
   assert.equal(f.requests.slice(before).filter(row=>row.label==='second'&&row.path==='/api/session').length,1,'rapid explicit retry shares one session request');
   assert.deepEqual(f.requests.filter(row=>row.label==='second'&&row.method!=='GET'),[],'session retries do not repeat mutations');await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });
 test('a failed background session check preserves this owner’s goal draft and retry does not overlap',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await second.evaluate(()=>navigate('goal'));await second.locator('#progress-summary').waitFor();await second.locator('[data-action="progress-record-weight"]').click();await second.locator('#progress-weightKg').fill('77.7');
   f.sessionFailure=true;await second.evaluate(()=>window.dispatchEvent(new Event('focus')));await second.locator('#session-sync-error').waitFor();
   assert.equal(await current(second),A);assert.equal(await second.locator('#progress-weightKg').inputValue(),'77.7');assert.equal(await second.locator('#member-progress').count(),1);
   f.sessionFailure=false;f.sessionDelay=250;const before=f.requests.length;
   await second.evaluate(()=>{for(let index=0;index<3;index++)document.querySelector('[data-action="sync-session"]')?.click();});await second.waitForFunction(()=>!document.getElementById('session-sync-error'));
   assert.equal(await current(second),A);assert.equal(await second.locator('#progress-weightKg').inputValue(),'77.7');assert.equal(f.requests.slice(before).filter(row=>row.label==='second'&&row.path==='/api/session').length,1);assert.equal(f.requests.slice(before).filter(row=>row.method!=='GET').length,0);await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });
 test('a missed invalidation discovered by state refresh clears old private fitness drafts before applying a new owner',async()=>{
  const f=fixture(),{context,first,second}=await setup(f);try{
   await second.evaluate(()=>navigate('members'));await second.getByRole('button',{name:'Edit answers',exact:true}).click();assert.equal(await second.locator('#health-weight').inputValue(),'70');await second.locator('#health-weight').fill('77.7');
   f.current=B;
   const outcome=await second.evaluate(async()=>{try{await refreshData();return 'fulfilled';}catch(error){return error.code||error.message;}});
   assert.equal(outcome,'STALE_RESPONSE','the previous owner’s caller must stop after applying the newly confirmed owner');await accountAt(second,B);await accountAt(first,B);
   assert.equal(await second.locator('#member-survey-form').count(),0);assert.equal(await second.locator('#health-weight').count(),0);assert.equal(await second.evaluate(()=>state.memberHealth.weightKg),88);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member|77\.7/);
   await second.getByRole('button',{name:'Edit answers',exact:true}).click();assert.equal(await second.locator('#health-weight').inputValue(),'88','new owner loads only their confirmed health data');assert.deepEqual(await second.evaluate(()=>state.members.map(member=>member.id)),[B]);await noPrivateMessages(first,second);clean(f);
  }finally{await context.close();}
 });
});
