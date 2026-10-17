// Public released assets only; every browser API is mocked at a loopback origin.
// Usage: node tests/performance-release-smoke.mjs --origin=https://repready-gym.vercel.app --commit=<full SHA>
// Local rehearsal: --origin=local --commit=working. No SMTP, provider or hosted business writes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {capabilitiesFor,planView} from '../src/state.js';
import {createAttendanceTracker} from '../public/attendance-tracker.js';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
assert.ok(args.origin&&args.commit,'Supply --origin and --commit explicitly.');
assert.ok(args.origin==='local'||/^https:\/\//.test(args.origin),'Use HTTPS for public deployed assets.');
const local=args.origin==='local',working=args.commit==='working',TODAY='2026-10-17';
assert.ok(!working||local,'Working-tree assets are only allowed for a local rehearsal.');
const A='11111111-2222-3333-4444-555555555555',B='22222222-3333-4444-5555-666666666666';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function filesAt(directory){const entries=await readdir(directory,{withFileTypes:true});return (await Promise.all(entries.map(entry=>entry.isDirectory()?filesAt(directory+'/'+entry.name):directory+'/'+entry.name))).flat();}
const files=working?await filesAt('public'):execFileSync('git',['ls-tree','-r','--name-only',args.commit,'public'],{encoding:'utf8'}).trim().split(/\r?\n/);
const assets=new Map(),verified=[];
// Six independent public reads at a time, with no cookies or authorization headers.
for(let index=0;index<files.length;index+=6)await Promise.all(files.slice(index,index+6).map(async file=>{
 const expected=working?await readFile(file):execFileSync('git',['show',args.commit+':'+file],{encoding:'buffer',maxBuffer:8000000});
 const path=file.slice('public'.length);let actual;
 if(local)actual=await readFile(file);
 else{const response=await fetch(new URL(path,args.origin),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,'Public asset '+path);actual=Buffer.from(await response.arrayBuffer());}
 assert.ok(actual.equals(expected),'Released asset bytes differ from reviewed commit: '+path);
 assets.set(path,actual);verified.push({path,sha256:createHash('sha256').update(actual).digest('hex'),bytes:actual.length});
}));
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname,file=path==='/'?'/index.html':path,body=assets.get(file);if(!body){res.writeHead(404);res.end();return;}res.setHeader('content-type',mime[file.slice(file.lastIndexOf('.'))]||'text/plain');res.end(body);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'}),results=[];
function fixture(role='member',current=A){
 const plans=[{id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength']},{id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio']},{id:'elite',name:'Performance',price_cents:249900,coaching:'personal',coach_sessions:4,focus_tags:['strength']}].map(plan=>planView({...plan,available:true,days:30,features:['Frozen purchased benefit']}));
 return {role,current,plans,requests:[],errors:[],httpFailures:[],unexpected:[],pages:new Map(),progress:new Map(),health:new Map(),memberOverrides:new Map(),loginDelay:0,statusDelay:0,sessionDelay:0,holdState:null,hostedApiRequests:0};
}
const account=(f,id)=>id?{id:f.role==='member'?id:f.role+'-user',memberId:f.role==='member'?id:f.role+'-user',role:f.role,name:id===A?'First Private Member':'Second Private Member',workspace:'production',can:capabilitiesFor(f.role)}:null;
function member(f,id){return {id,name:id===A?'First Private Member':'Second Private Member',email:(id===A?'first':'second')+'@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:f.plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat'],updatedAt:TODAY+'T00:00:00Z'},...f.memberOverrides.get(id)};}
function health(f,id){if(!f.health.has(id))f.health.set(id,{heightCm:175,weightKg:id===A?70:88,ageBand:'20plus',conditions:['none'],updatedAt:TODAY+'T00:00:00Z'});return f.health.get(id);}
function progress(f,id){if(!f.progress.has(id)){const weight=id===A?60:88,goal={id:'aaaaaaaa-bbbb-cccc-dddd-000000000001',periodId:'aaaaaaaa-bbbb-cccc-dddd-000000000002',goalType:'gain',status:'active',startDate:'2026-10-12',startingWeightKg:weight,measurementDate:'2026-10-12',targetWeightKg:weight+5,recordedAt:TODAY+'T00:00:00Z',endedAt:null};f.progress.set(id,{today:TODAY,currentGoal:goal,goals:[goal],measurements:[{id:'aaaaaaaa-bbbb-cccc-dddd-000000000003',date:'2026-10-12',weightKg:weight,recordedAt:goal.recordedAt,updatedAt:goal.recordedAt}],healthWeight:{weightKg:health(f,id).weightKg,recordedAt:TODAY+'T00:00:00Z'}});}return f.progress.get(id);}
function snapshot(f,id){
 const item=member(f,id);return {user:account(f,id),date:TODAY,members:f.role==='member'?[item]:[member(f,A),member(f,B)],plans:f.plans,invoices:[{id:'INV-CURRENT',memberId:id,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:89900,start:item.start,end:item.end,due:item.start,created:item.start},{id:'INV-NEXT',memberId:id,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:0,start:'2026-10-31',end:'2026-11-29',due:'2026-10-31',created:TODAY}],memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},memberHealth:f.role==='member'?health(f,id):null,visits:{recent:[],last:null,thisMonth:0},stats:f.role==='member'?undefined:{visitsToday:0},paymongo:{configured:true,methods:['gcash','paymaya','grab_pay','card'],testMode:true}};
}
const checkout={id:'isolated-checkout',status:'needs_review',reviewReason:'test_provider_pending',url:'',amount:899};
async function setup(f){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{window.smokeReady=false;window.smokeMessages=[];document.addEventListener('repready-ready',()=>window.smokeReady=true);const Native=window.BroadcastChannel;if(Native)window.BroadcastChannel=class extends Native{postMessage(message){window.smokeMessages.push(structuredClone(message));return super.postMessage(message);}};});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),page=request.frame().page(),label=f.pages.get(page)||'opening',id=f.current;
  if(url.origin!==origin){if(path.startsWith('/api/'))f.hostedApiRequests++;return route.fulfill({status:200,body:''});}
  if(path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
  if(!path.startsWith('/api/'))return route.continue();
  f.requests.push({label,path,method,body:method==='POST'?request.postDataJSON():null});let body,status=200;
  if(path==='/api/plans')body={plans:f.plans};
  else if(path==='/api/session'){await wait(f.sessionDelay);body={user:account(f,id),date:TODAY};}
  else if(path==='/api/state'){
   body=id?structuredClone(snapshot(f,id)):{error:'Not signed in'};status=id?200:401;
   const hold=f.holdState?.label===label?f.holdState:null;if(hold){f.holdState=null;hold.started.resolve();await hold.release.promise;}
  }else if(path==='/api/login'&&method==='POST'){await wait(f.loginDelay);f.current=request.postDataJSON().email.startsWith('second')?B:A;body={ok:true,user:account(f,f.current)};}
  else if(path==='/api/logout'&&method==='POST'){f.current=null;body={ok:true};}
  else if(path==='/api/member-progress'){
   if(method==='POST'){const input=request.postDataJSON();assert.equal(input.action,'add_weight');progress(f,id).measurements.push({id:'aaaaaaaa-bbbb-cccc-dddd-000000000004',date:input.date,weightKg:input.weightKg,recordedAt:TODAY+'T01:00:00Z',updatedAt:TODAY+'T01:00:00Z'});}
   body={memberProgress:structuredClone(progress(f,id))};
  }else if(path==='/api/member-survey'&&method==='POST'){const input=request.postDataJSON();assert.deepEqual(Object.keys(input).sort(),['availableDays','exercises','experience','goal']);f.memberOverrides.set(id,{goal:input.goal,survey:{experience:input.experience,exercises:input.exercises,availableDays:input.availableDays,updatedAt:TODAY+'T01:00:00Z'}});body=f.memberOverrides.get(id);}
  else if(path==='/api/member-health'&&method==='POST'){const input=request.postDataJSON();assert.deepEqual(Object.keys(input).sort(),['ageBand','conditions','heightCm','weightKg']);f.health.set(id,{...input,updatedAt:TODAY+'T01:00:00Z'});body={memberHealth:health(f,id)};}
  else if(path==='/api/member-attendance')body=createAttendanceTracker({period:url.searchParams.get('period'),date:url.searchParams.get('date'),today:TODAY,events:[{id:'mon',at:'2026-10-12T01:00:00Z'},{id:'wed',at:'2026-10-14T01:00:00Z'}],schedules:[{effectiveFrom:'2026-10-12',days:['mon','wed','fri']}],coverage:[{start:'2026-10-01',end:'2026-10-30'}]});
  else if(path==='/api/paymongo/checkout'&&method==='POST'){const input=request.postDataJSON();assert.equal(input.invoiceId,'INV-NEXT');assert.equal(input.method,'card');body={checkout};}
  else if(path==='/api/paymongo/status'&&method==='POST'){await wait(f.statusDelay);body={checkout};}
  else{f.unexpected.push(`${method} ${path}`);status=500;body={error:'Unexpected isolated smoke request'};}
  try{await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}catch(error){if(!/closed|disposed|aborted/i.test(error.message))throw error;}
 });
 async function open(label,section='overview'){
  const page=await context.newPage();f.pages.set(page,label);page.setDefaultTimeout(7000);page.on('pageerror',error=>f.errors.push(error.message));page.on('response',response=>{if(response.status()>=400)f.httpFailures.push({status:response.status(),path:new URL(response.url()).pathname});});
  await page.goto(`${origin}/#/${f.role==='member'?'member':'admin'}/${section}`);await page.waitForFunction(()=>window.smokeReady||document.querySelector('#login-form'));return page;
 }
 return {context,open};
}
const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.httpFailures,[]);assert.deepEqual(f.unexpected,[]);assert.equal(f.hostedApiRequests,0);};
const accountAt=(page,id)=>page.waitForFunction(expected=>(currentUser?.id||null)===expected&&(!expected||state.user?.id===expected),id);
async function login(page,email='first@example.invalid'){await page.locator('#login-email').fill(email);await page.locator('#login-password').fill('Dummy-password-only');return page.locator('#login-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();const button=form.querySelector('[type="submit"]');return {disabled:button.disabled,label:button.textContent};});}
try{
 for(const role of ['admin','staff','member']){
  const f=fixture(role,null),{context,open}=await setup(f);
  try{f.loginDelay=150;const page=await open('login'),saving=await login(page);assert.equal(saving.disabled,true);assert.match(saving.label,/Signing in/);await page.locator('.sidebar').waitFor();assert.equal(f.requests.filter(r=>r.path==='/api/login').length,1);if(role!=='member'){await page.evaluate(()=>navigate('members'));await page.locator('#directory-search').fill('Second');assert.match(await page.locator('#member-results').innerText(),/Second Private Member/);assert.doesNotMatch(await page.locator('#member-results').innerText(),/First Private Member/);}clean(f);}finally{await context.close();}
 }
 results.push('Admin/staff/member login, immediate saving state, rapid-click protection and operational search');

 {
  const f=fixture(),{context,open}=await setup(f);
  try{
   const page=await open('member','members');assert.equal(await page.locator('#sample-training').count(),1);assert.equal(await page.locator('.sample-week-day').count(),7);assert.equal(await page.locator('.recommended-plan h2').innerText(),'Performance');const originalInvoices=JSON.stringify(snapshot(f,A).invoices);
   await page.getByRole('button',{name:'Edit answers',exact:true}).click();await page.locator('#survey-goal').selectOption('Build strength');await page.locator('#health-asthma').check();await page.locator('#member-survey-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await page.getByRole('button',{name:'Edit answers',exact:true}).waitFor();assert.match(await page.locator('#sample-training').innerText(),/Professional guidance recommended/);assert.equal(await page.locator('.sample-week-day').count(),0);assert.equal(f.requests.filter(r=>['/api/member-survey','/api/member-health'].includes(r.path)).length,2);
   await page.evaluate(()=>navigate('goal'));await page.locator('#progress-summary').waitFor();await page.locator('[data-action="progress-record-weight"]').click();await page.locator('#progress-weightKg').fill('61.2');const stateReads=f.requests.filter(r=>r.path==='/api/state').length;await page.locator('#progress-weight-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await page.waitForFunction(()=>!document.querySelector('#progress-weight-form'));assert.match(await page.locator('#progress-summary').innerText(),/61\.2 kg/);assert.equal(f.requests.filter(r=>r.path==='/api/member-progress'&&r.method==='POST').length,1);assert.equal(f.requests.filter(r=>r.path==='/api/state').length,stateReads);
   await page.evaluate(()=>navigate('attendance'));await page.locator('#attendance-tracker-summary').waitFor();assert.match(await page.locator('#attendance-tracker-summary').innerText(),/66\.7%/);assert.equal(await page.locator('#member-progress').count(),0);await page.setViewportSize({width:320,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(JSON.stringify(snapshot(f,A).invoices),originalInvoices);assert.match(await page.evaluate(()=>state.members[0].terms.features.join(' ')),/Frozen purchased benefit/);clean(f);
  }finally{await context.close();}
 }
 results.push('Restored survey/recommendation, combined private save, confirmed goal/weight response, attendance and 320px layout');

 {
  const f=fixture(),{context,open}=await setup(f);
  try{
   const page=await open('payment','payments');await page.locator('[data-action="pay"][data-id="INV-NEXT"]').click();assert.equal(await page.locator('#invoice-channel option').count(),4);await page.locator('#invoice-channel').selectOption('card');const before=f.requests.length;await page.locator('[data-action="paymongo-front-desk"]').click();await page.locator('[data-action="paymongo-online-back"]').click();assert.equal(await page.locator('#invoice-channel').inputValue(),'card');assert.equal(f.requests.length,before);
   const stateReads=f.requests.filter(r=>r.path==='/api/state').length;await page.locator('#paymongo-member-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await page.locator('[data-action="paymongo-status"]').waitFor();assert.equal(f.requests.filter(r=>r.path==='/api/paymongo/checkout').length,1);f.statusDelay=150;await page.locator('[data-action="paymongo-status"]').evaluate(button=>{button.click();button.click();});await page.waitForFunction(()=>document.querySelector('[data-action="paymongo-status"]:not(:disabled)'));assert.equal(f.requests.filter(r=>r.path==='/api/paymongo/status').length,1);assert.equal(f.requests.filter(r=>r.path==='/api/state').length,stateReads);assert.equal(await page.evaluate(()=>state.invoices.find(invoice=>invoice.id==='INV-NEXT').paidCents),0);clean(f);
  }finally{await context.close();}
 }
 results.push('Existing invoice/card and cash Back preserved; single checkout/status calls; no unnecessary state request or paid assertion');

 {
  const f=fixture(),{context,open}=await setup(f),hold={label:'second',started:deferred(),release:deferred()};
  try{
   const first=await open('first','goal'),second=await open('second','goal');await second.locator('#progress-summary').waitFor();f.holdState=hold;await second.evaluate(()=>{window.delayedSmokeState=refreshData().catch(error=>error.code);});await hold.started.promise;
   f.sessionDelay=150;await first.locator('[data-action="logout"]').evaluate(button=>button.click());await second.waitForFunction(()=>currentUser===null);assert.equal(await second.evaluate(()=>state.members.length),0);assert.equal(await second.locator('#member-progress').count(),0);
   await first.locator('#login-form').waitFor();await login(first,'second@example.invalid');await accountAt(second,B);hold.release.resolve();await second.evaluate(()=>window.delayedSmokeState);assert.equal(await second.evaluate(()=>currentUser.id),B);assert.deepEqual(await second.evaluate(()=>state.members.map(value=>value.id)),[B]);assert.equal(await second.evaluate(()=>state.memberHealth.weightKg),88);assert.doesNotMatch(await second.locator('body').innerText(),/First Private Member/);
   for(const page of [first,second])for(const message of await page.evaluate(()=>window.smokeMessages)){assert.deepEqual(Object.keys(message).sort(),['id','phase','reason','v']);assert.doesNotMatch(JSON.stringify(message),/password|weightKg|memberHealth|token|First Private|Second Private/);}
   clean(f);
  }finally{hold.release.resolve();await context.close();}
 }
 results.push('Two-tab logout/login, immediate private clearing and rejection of a delayed previous-account state response');
 const report={origin:args.origin,commit:args.commit,rehearsal:local,checkedAt:new Date().toISOString(),assets:verified.sort((a,b)=>a.path.localeCompare(b.path)),cases:results,hostedBrowserApiRequests:0,javascriptExceptions:0,httpFailures:0,limits:'Public assets fetched without credentials. Browser APIs and every mutation were isolated; no live login, survey, health record, goal, weight, check-in, checkout, payment or email was created.'};
 await mkdir('artifacts/performance-phase',{recursive:true});await writeFile(`artifacts/performance-phase/${local?'local-':'release-'}smoke.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({origin:args.origin,commit:args.commit,assets:verified.length,cases:results.length,hostedBrowserApiRequests:0,javascriptExceptions:0,httpFailures:0,results},null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
