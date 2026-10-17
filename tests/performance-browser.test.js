// Slow/error/competing-request checks with real frontend scripts and isolated responses only.
import assert from 'node:assert/strict';
import {after,before,describe,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor,planView} from '../src/state.js';

const TODAY='2026-10-17',MEMBER='11111111-2222-3333-4444-555555555555';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(role='member'){
 const plans=[planView({id:'basic',name:'Essential',coaching:'none',coach_sessions:0,price_cents:89900,available:true,days:30,features:['Frozen purchased gym access']})];
 const member={id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:TODAY+'T00:00:00Z'}};
 return {plans,member,health:{heightCm:null,weightKg:null,ageBand:null,conditions:[]},user:{id:role==='member'?MEMBER:role+'-user',memberId:role==='member'?MEMBER:role+'-user',role,name:member.name,workspace:'production',can:capabilitiesFor(role)},signedIn:true,requests:[],errors:[],unexpected:[],delay:0,fail:{},holds:{}};
}
const snapshot=f=>({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:[{id:'INV-CURRENT',memberId:MEMBER,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:89900,start:f.member.start,end:f.member.end,due:f.member.start,created:f.member.start}],memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},memberHealth:f.health,paymongo:{configured:true,methods:['gcash','card'],testMode:true},stats:f.user.role==='member'?undefined:{visitsToday:0}});

describe('frontend request and interaction resilience',{concurrency:false},()=>{
 let browser,server,origin;
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
 async function open(f,section='overview'){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);page.on('pageerror',error=>f.errors.push(error.message));
  await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.performanceTestReady=true;}));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
   if(!path.startsWith('/api/'))return route.continue();
   f.requests.push({path,method,body:method==='POST'?request.postDataJSON():undefined});
   // Capture the response at request time to reproduce an old session's delayed data.
   let body,status=200;
   if(method==='GET'&&path==='/api/plans')body={plans:f.plans};
   else if(method==='GET'&&path==='/api/session')body={user:f.signedIn?f.user:null,date:TODAY};
   else if(method==='GET'&&path==='/api/state')body=structuredClone(snapshot(f));
   else if(method==='POST'&&path==='/api/logout'){f.signedIn=false;body={ok:true};}
   else if(method==='POST'&&path==='/api/profile'){body={ok:true};if(!f.fail[path])Object.assign(f.member,request.postDataJSON());}
   else if(method==='POST'&&path==='/api/member-health'){f.health={...request.postDataJSON(),updatedAt:TODAY+'T01:00:00Z'};body={memberHealth:f.health};}
   else if(method==='POST'&&path==='/api/login'){f.signedIn=true;body={ok:true,user:f.user,date:TODAY};}
   else if(method==='GET'&&path==='/api/member-progress')body={memberProgress:{today:TODAY,currentGoal:null,goals:[],measurements:[],healthWeight:null}};
   else {f.unexpected.push(`${method} ${path}`);status=500;body={error:'Unexpected isolated request'};}
   if(f.delay)await wait(f.delay);if(f.holds[path])await f.holds[path];
   if(f.fail[path]){status=502;body={error:f.fail[path]};}
   try{await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}catch(error){if(!/closed|disposed|Target/i.test(error.message))throw error;}
  });
  await page.goto(`${origin}/#/${f.user.role==='member'?'member':'admin'}/${section}`);
  if(f.signedIn)await page.waitForFunction(()=>window.performanceTestReady);else await page.locator('#login-form').waitFor();return page;
 }
 const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);};

 test('restored member uses the authorized state catalog without a redundant public-plan request',async()=>{
  const f=fixture(),page=await open(f,'members');
  try{assert.deepEqual(f.requests.filter(r=>r.method==='GET').map(r=>r.path),['/api/session','/api/state']);assert.match(await page.locator('.membership-privileges').innerText(),/Frozen purchased gym access/);clean(f);}finally{await page.close();}
 });

 test('slow login keeps its saving feedback and rejects repeated submissions across authentication cleanup',async()=>{
  const f=fixture();f.signedIn=false;const page=await open(f);let release;
  try{
   await page.locator('#login-email').fill('member@example.invalid');await page.locator('#login-password').fill('Dummy-password-only');
   f.holds['/api/login']=new Promise(resolve=>{release=resolve;});
   await page.locator('#login-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
   await wait(40);assert.equal(f.requests.filter(r=>r.path==='/api/login').length,1);assert.equal(await page.locator('#login-form [type="submit"]').isDisabled(),true);
   assert.match(await page.locator('#login-form [type="submit"]').innerText(),/Signing in/);
   release();delete f.holds['/api/login'];await page.locator('.sidebar').waitFor();assert.equal(f.requests.filter(r=>r.path==='/api/state').length,1);clean(f);
  }finally{release?.();await page.close();}
 });

 test('competing state refreshes share one request and retain directory filter, focus and scroll',async()=>{
  const f=fixture('staff'),page=await open(f,'members');let release;
  try{
   await page.locator('#directory-search').fill('Existing');await page.locator('#status-filter').selectOption('active');await page.locator('#directory-search').focus();
   await page.setViewportSize({width:1440,height:420});const beforeScroll=await page.evaluate(()=>{window.scrollTo(0,120);return window.scrollY;});assert.ok(beforeScroll>0);
   f.holds['/api/state']=new Promise(resolve=>{release=resolve;});const before=f.requests.length;
   await page.evaluate(()=>{window.performanceRefreshes=Promise.all([refreshData(),refreshData(),refreshData()]);});
   await page.waitForFunction(()=>!!document.querySelector('#directory-search'));
   await wait(40);assert.equal(f.requests.slice(before).filter(r=>r.path==='/api/state').length,1);
   release();delete f.holds['/api/state'];await page.evaluate(()=>window.performanceRefreshes);
   assert.equal(await page.locator('#directory-search').inputValue(),'Existing');assert.equal(await page.locator('#status-filter').inputValue(),'active');
   assert.equal(await page.locator('#directory-search').evaluate(el=>document.activeElement===el),true);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.evaluate(()=>window.scrollY),beforeScroll);clean(f);
  }finally{release?.();await page.close();}
 });

 test('slow failed operational form shows feedback, prevents duplicate writes and preserves values for explicit retry',async()=>{
  const f=fixture(),page=await open(f,'members');let release;
  try{
   await page.locator('[data-action="edit-profile"]').click();await page.locator('#edit-phone').fill('09170000002');
   f.holds['/api/profile']=new Promise(resolve=>{release=resolve;});f.fail['/api/profile']='Contact details could not be saved.';
   await page.locator('#profile-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
   await page.waitForFunction(()=>document.querySelector('button[form="profile-form"]')?.disabled);
   assert.match(await page.locator('button[form="profile-form"]').innerText(),/Saving|Working|Please wait/i);
   assert.equal(f.requests.filter(r=>r.path==='/api/profile').length,1);assert.equal(f.member.phone,'09170000001');
   release();delete f.holds['/api/profile'];await page.locator('#profile-form .form-error').filter({hasText:'Contact details could not be saved.'}).waitFor();
   assert.equal(await page.locator('#edit-phone').inputValue(),'09170000002');assert.equal(await page.locator('button[form="profile-form"]').isDisabled(),false);
   delete f.fail['/api/profile'];await page.locator('#profile-form').evaluate(form=>form.requestSubmit());await page.waitForFunction(()=>!document.querySelector('#profile-form'));
   assert.equal(f.requests.filter(r=>r.path==='/api/profile').length,2);assert.equal(f.member.phone,'09170000002');clean(f);
  }finally{release?.();await page.close();}
 });

 test('navigation during a delayed state refresh preserves a member goal draft and its chosen route',async()=>{
  const f=fixture(),page=await open(f,'goal');let release;
  try{
   await page.locator('[data-action="progress-start-goal"]').click();await page.locator('#progress-goal-form [name="goalType"]').selectOption('gain');await page.locator('#progress-goal-form [name="startingWeightKg"]').fill('61.4');
   f.holds['/api/state']=new Promise(resolve=>{release=resolve;});await page.evaluate(()=>{window.performanceRefresh=refreshData();});await wait(30);
   await page.evaluate(()=>navigate('members'));release();delete f.holds['/api/state'];await page.evaluate(()=>window.performanceRefresh);
   assert.match(page.url(),/#\/member\/members$/);assert.equal(await page.locator('#fitness-survey').count(),1);
   await page.evaluate(()=>navigate('goal'));await page.locator('#progress-goal-form').waitFor();assert.equal(await page.locator('#progress-goal-form [name="startingWeightKg"]').inputValue(),'61.4');
   assert.equal(f.requests.some(r=>r.method==='POST'),false);clean(f);
  }finally{release?.();await page.close();}
 });

 test('a state read begun before a confirmed fitness-profile save cannot replace the newly saved private values',async()=>{
  const f=fixture(),page=await open(f,'members');let release;
  try{
   f.holds['/api/state']=new Promise(resolve=>{release=resolve;});await page.evaluate(()=>{window.olderSavedState=refreshData();});await wait(30);
   await page.getByRole('button',{name:'Edit answers',exact:true}).click();await page.locator('#health-height').fill('175');await page.locator('#health-weight').fill('72');
   await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();await page.getByRole('button',{name:'Edit answers',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>state.memberHealth.weightKg),72);
   release();delete f.holds['/api/state'];await page.evaluate(()=>window.olderSavedState);
   assert.equal(await page.evaluate(()=>state.memberHealth.weightKg),72,'older snapshots cannot undo confirmed private fields');assert.match(await page.locator('#member-health-bmi').innerText(),/23\.5/);clean(f);
  }finally{release?.();await page.close();}
 });

 test('idle combined fitness drafts survive refresh and navigation, while Cancel and account clearing discard them',async()=>{
  const f=fixture(),page=await open(f,'members');
  try {
   await page.getByRole('button',{name:'Edit answers',exact:true}).click();
   await page.locator('#survey-goal').selectOption('Build strength');await page.locator('#survey-experience').selectOption('returning');
   await page.locator('#survey-cardio').check();await page.locator('#survey-sun').check();
   await page.locator('#health-height').fill('175');await page.locator('#health-weight').fill('72.4');await page.locator('#health-asthma').check();
   await page.evaluate(()=>refreshData());
   assert.equal(await page.locator('#survey-goal').inputValue(),'Build strength');assert.equal(await page.locator('#survey-experience').inputValue(),'returning');
   assert.equal(await page.locator('#health-weight').inputValue(),'72.4');assert.equal(await page.locator('#health-asthma').isChecked(),true);
   await page.evaluate(()=>navigate('overview'));await page.evaluate(()=>navigate('members'));
   assert.equal(await page.locator('#survey-cardio').isChecked(),true);assert.equal(await page.locator('#survey-sun').isChecked(),true);assert.equal(await page.locator('#health-height').inputValue(),'175');
   assert.equal(f.requests.some(row=>row.method==='POST'),false,'draft refresh/navigation do not submit anything');
   await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Edit answers',exact:true}).click();
   assert.equal(await page.locator('#survey-goal').inputValue(),'Improve fitness');assert.equal(await page.locator('#health-weight').inputValue(),'');
   await page.locator('#health-weight').fill('77');await page.evaluate(()=>refreshData());
   await page.evaluate(()=>beginAuthChange('isolated-account-change'));await page.locator('#login-form').waitFor();
   assert.equal(await page.evaluate(()=>fitnessProfileEditorDraft),null);assert.equal(await page.locator('#member-health').count(),0);clean(f);
  }finally{await page.close();}
 });

 test('logout immediately clears private content and an older successful state response cannot restore it',async()=>{
  const f=fixture(),page=await open(f,'members');let release;
  try{
   f.holds['/api/state']=new Promise(resolve=>{release=resolve;});await page.evaluate(()=>{window.oldPerformanceRefresh=refreshData().catch(error=>error.name);});await wait(30);
   f.holds['/api/logout']=new Promise(resolve=>{f.releaseLogout=resolve;});await page.locator('[data-action="logout"]').evaluate(button=>button.click());
   await page.waitForFunction(()=>!document.querySelector('#fitness-survey')&&!document.querySelector('.membership-privileges'));
   release();delete f.holds['/api/state'];await page.evaluate(()=>window.oldPerformanceRefresh);assert.equal(await page.locator('#fitness-survey,.membership-privileges').count(),0);
   f.releaseLogout();delete f.holds['/api/logout'];await page.locator('#login-form').waitFor();assert.equal(await page.evaluate(()=>currentUser),null);clean(f);
  }finally{release?.();f.releaseLogout?.();await page.close();}
 });
});
