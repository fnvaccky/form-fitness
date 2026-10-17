// Comparable browser measurements of actual frontend assets with isolated API fixtures.
// Controlled latency is NOT production/provider/database latency. Never sends live mutations.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {capabilitiesFor,planView} from '../src/state.js';
import {createAttendanceTracker} from '../public/attendance-tracker.js';

const git=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const args=Object.fromEntries(process.argv.slice(2).map(value=>value.replace(/^--/,'').split('=')));
const revision=args.revision||'',label=args.label||(revision?'before':'after');
const API_MS=Number(args.latency||150),PROVIDER_MS=600,TODAY='2026-10-17';
const RUNS=Number(args.runs||1);
const MEMBER='11111111-2222-3333-4444-555555555555',OTHER='22222222-3333-4444-5555-666666666666';
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
const assets=new Map();
async function asset(path){
 const file='public'+(path==='/'?'/index.html':path);
 if(!assets.has(file))assets.set(file,revision?(await git('git',['show',`${revision}:${file}`],{encoding:'buffer',maxBuffer:8000000})).stdout:await readFile(file));
 return assets.get(file);
}
// Snapshot and warm every asset before timing; Git lookup and concurrent editing are not benchmark costs.
async function currentFiles(directory){const entries=await readdir(directory,{withFileTypes:true});return (await Promise.all(entries.map(entry=>entry.isDirectory()?currentFiles(directory+'/'+entry.name):directory+'/'+entry.name))).flat();}
const files=revision?(await git('git',['ls-tree','-r','--name-only',revision,'public'])).stdout.trim().split(/\r?\n/):await currentFiles('public');
await Promise.all(files.map(file=>asset(file.slice('public'.length))));
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;const body=await asset(path);res.setHeader('content-type',mime[path.slice(path.lastIndexOf('.'))]||'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
const results=[],checks=[];
function fixture(role='member',signedIn=true){
 const plans=[planView({id:'basic',name:'Essential',coaching:'none',coach_sessions:0,focus_tags:['strength'],price_cents:89900,available:true,days:30,description:'Membership plan',features:['Frozen purchased gym access']})];
 const member={id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat'],updatedAt:TODAY+'T00:00:00Z'}};
 const user={id:role==='member'?MEMBER:role+'-user',memberId:role==='member'?MEMBER:role+'-user',role,name:role==='member'?member.name:'Gym '+role,workspace:'production',can:capabilitiesFor(role)};
 const members=role==='member'?[member]:[member,...Array.from({length:199},(_,i)=>({...member,id:i===0?OTHER:`member-${i}`,name:`Roster Member ${i}`,email:`roster${i}@example.invalid`}))];
 const currentGoal={id:'aaaaaaaa-bbbb-cccc-dddd-000000000001',periodId:'aaaaaaaa-bbbb-cccc-dddd-000000000002',goalType:'gain',status:'active',startDate:'2026-10-12',startingWeightKg:60,measurementDate:'2026-10-12',targetWeightKg:65,recordedAt:TODAY+'T00:00:00Z',endedAt:null};
 return {role,user,signedIn,member,members,plans,health:{heightCm:175,weightKg:70,ageBand:'20plus',conditions:['none'],updatedAt:TODAY+'T00:00:00Z'},
  invoices:[{id:'INV-CURRENT',memberId:MEMBER,plan:'basic',terms:plans[0],amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start},{id:'INV-NEXT',memberId:MEMBER,plan:'basic',terms:plans[0],amount:899,amountCents:89900,paidCents:0,start:'2026-10-31',end:'2026-11-29',due:'2026-10-31',created:TODAY}],
  progress:{today:TODAY,currentGoal,goals:[currentGoal],measurements:[{id:'aaaaaaaa-bbbb-cccc-dddd-000000000003',date:'2026-10-12',weightKg:60,recordedAt:TODAY+'T00:00:00Z',updatedAt:TODAY+'T00:00:00Z'}],healthWeight:{weightKg:70,recordedAt:TODAY+'T00:00:00Z'}},requests:[],errors:[],unexpected:[],checked:false,fail:{},holds:{}};
}
function state(f){return {user:f.user,date:TODAY,members:f.members,plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},stats:f.role==='member'?undefined:{visitsToday:f.checked?1:0},memberHealth:f.role==='member'?f.health:null,paymongo:{configured:true,methods:['gcash','paymaya','grab_pay','card'],testMode:true}};}
const checkout={id:'checkout-isolated',status:'needs_review',reviewReason:'test_provider_pending',url:'',amount:899,amountCents:89900};
async function respond(f,request,url){
 const path=url.pathname,method=request.method(),body=method==='POST'?request.postDataJSON():null;
 if(method==='GET'&&path==='/api/plans')return {plans:f.plans};
 if(method==='GET'&&path==='/api/session')return {user:f.signedIn?f.user:null,date:TODAY};
 if(method==='POST'&&path==='/api/login'){f.signedIn=true;return {ok:true,user:f.user,date:TODAY};}
 if(method==='POST'&&path==='/api/logout'){f.signedIn=false;return {ok:true};}
 if(method==='GET'&&path==='/api/state')return state(f);
 if(method==='GET'&&path==='/api/member-progress')return {memberProgress:structuredClone(f.progress)};
 if(method==='GET'&&path==='/api/member-attendance')return createAttendanceTracker({period:url.searchParams.get('period'),date:url.searchParams.get('date'),today:TODAY,events:[{id:'visit',at:'2026-10-14T01:00:00Z'}],schedules:[{effectiveFrom:'2026-10-12',days:['mon','wed','fri']}],coverage:[{start:'2026-10-01',end:'2026-10-30'}]});
 if(method==='GET'&&path==='/api/reports/attendance')return {from:'2026-10-11',to:TODAY,totals:{visits:f.checked?1:0,uniqueMembers:f.checked?1:0,days:7,dailyAverage:0},visits:f.checked?[{date:TODAY,time:'10:00',memberId:MEMBER,name:'Existing Member',plan:'Essential',confirmedBy:'Gym staff'}]:[],truncated:false};
 if(method==='POST'&&path==='/api/profile'){Object.assign(f.member,body);return {ok:true};}
 if(method==='POST'&&path==='/api/member-survey'){f.member.goal=body.goal;f.member.survey={experience:body.experience,exercises:body.exercises,availableDays:body.availableDays,updatedAt:TODAY+'T01:00:00Z'};return {goal:f.member.goal,survey:f.member.survey};}
 if(method==='POST'&&path==='/api/member-health'){f.health={...body,updatedAt:TODAY+'T01:00:00Z'};return {memberHealth:f.health};}
 if(method==='POST'&&path==='/api/member-progress'){
  if(body.action==='add_weight')f.progress.measurements.push({id:'aaaaaaaa-bbbb-cccc-dddd-000000000004',date:body.date,weightKg:body.weightKg,recordedAt:TODAY+'T01:00:00Z',updatedAt:TODAY+'T01:00:00Z'});
  else if(body.action==='save_goal'){f.progress.currentGoal={...f.progress.currentGoal,...body,targetWeightKg:body.targetWeightKg};f.progress.goals.push(f.progress.currentGoal);}
  else if(body.action==='pause_goal')f.progress.currentGoal.status='paused';
  return {memberProgress:structuredClone(f.progress)};
 }
 if(method==='POST'&&path==='/api/scan')return {member:f.member,token:'FORM2.isolated-pass',alreadyCheckedInAt:null};
 if(method==='POST'&&path==='/api/check-in'){f.checked=true;return {ok:true};}
 if(method==='POST'&&path==='/api/paymongo/checkout'){assert.equal(body.invoiceId,'INV-NEXT');assert.equal(body.method,'card');return {checkout};}
 if(method==='POST'&&path==='/api/paymongo/status')return {checkout};
 f.unexpected.push(`${method} ${path}`);throw Error('Unexpected isolated request '+method+' '+path);
}
async function open(f,section='overview'){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);page.on('pageerror',error=>f.errors.push(error.message));
 await page.addInitScript(()=>{
  window.benchmarkReady=false;window.benchmarkBrowser={requests:[],renders:[]};
  const originalFetch=window.fetch;
  window.fetch=async function(...args){const start=performance.now(),response=await originalFetch.apply(this,args),headersAt=performance.now(),originalJson=response.json.bind(response),metric={path:new URL(args[0],location.href).pathname,requestStart:start,headersMs:headersAt-start,decodeMs:0};window.benchmarkBrowser.requests.push(metric);response.json=async()=>{const decodeStart=performance.now();try{return await originalJson();}finally{metric.decodeMs=performance.now()-decodeStart;}};return response;};
  document.addEventListener('repready-ready',()=>{window.benchmarkReady=true;});
  document.addEventListener('DOMContentLoaded',()=>{const originalRender=render;render=function(...args){const start=performance.now();try{return originalRender.apply(this,args);}finally{window.benchmarkBrowser.renders.push(performance.now()-start);}};});
 });
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin||url.pathname.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const record={method:request.method(),path:url.pathname+url.search,start:performance.now(),delayMs:url.pathname==='/api/paymongo/checkout'?PROVIDER_MS:API_MS};f.requests.push(record);
  try{await sleep(record.delayMs);if(f.holds[url.pathname])await f.holds[url.pathname];const failed=f.fail[url.pathname];const body=failed?{error:failed}:await respond(f,request,url);record.status=failed?502:200;record.end=performance.now();record.bytes=Buffer.byteLength(JSON.stringify(body));return await route.fulfill({status:record.status,contentType:'application/json',body:JSON.stringify(body)});}catch(error){if(/Target|closed|disposed/i.test(error.message))return;record.end=performance.now();record.status=500;await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:error.message})});}
 });
 const start=performance.now();await page.goto(`${origin}/#/${f.role==='member'?'member':'admin'}/${section}`);if(f.signedIn)await page.waitForFunction(()=>window.benchmarkReady);else await page.locator('#login-form').waitFor();
 const wallMs=performance.now()-start;results.push({...measurement(f,`${f.role} ${f.signedIn?'restored session':'signed-out load'}`,0,start,wallMs),...await browserMetrics(page)});return page;
}
async function browserMetrics(page,start={requests:0,renders:0}){return page.evaluate(start=>{const data=window.benchmarkBrowser,requests=data.requests.slice(start.requests),renders=data.renders.slice(start.renders);return {browserJsonDecodeMs:Number(requests.reduce((sum,item)=>sum+item.decodeMs,0).toFixed(2)),browserRenderMs:Number(renders.reduce((sum,item)=>sum+item,0).toFixed(2)),browserRenderCount:renders.length,browserNetworkWaitingMs:Number(requests.reduce((sum,item)=>sum+item.headersMs,0).toFixed(2))};},start);}
function measurement(f,name,index,start,wallMs,busyMs=null){const requests=f.requests.slice(index);return {name,wallMs:Math.round(wallMs),busyFeedbackMs:busyMs===null?null:Math.round(busyMs),requestCount:requests.length,requests:requests.map(({method,path,start,end,bytes,status,delayMs})=>({method,path,elapsedMs:Math.round((end||performance.now())-start),bytes,status,controlledLatencyMs:delayMs})),responseBytes:requests.reduce((sum,item)=>sum+(item.bytes||0),0),afterLastResponseMs:Math.round(performance.now()-Math.max(start,...requests.map(item=>item.end||start)))};}
async function timed(f,page,name,act,done,{busy}={}){
 const marker=await page.evaluate(()=>({requests:window.benchmarkBrowser.requests.length,renders:window.benchmarkBrowser.renders.length}));
 const index=f.requests.length,start=performance.now();await act();let busyMs=null;if(busy){try{await page.locator(busy).first().waitFor({state:'visible',timeout:80});busyMs=performance.now()-start;}catch{busyMs=null;}}
 await done();await page.evaluate(()=>new Promise(requestAnimationFrame));const wallMs=performance.now()-start;results.push({...measurement(f,name,index,start,wallMs,busyMs),...await browserMetrics(page,marker)});
}
function clean(f){assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);}
try{
 for(let run=0;run<RUNS;run++){
 for(const role of ['admin','staff','member']){
  const f=fixture(role,false),page=await open(f);
  await page.locator('#login-email').fill(`${role}@example.invalid`);await page.locator('#login-password').fill('Isolated-password-only');
  await timed(f,page,`${role} login`,()=>page.locator('#login-form').evaluate(form=>form.requestSubmit()),()=>page.waitForFunction(()=>document.querySelector('.sidebar')),{busy:'#login-form button:disabled'});
  if(role!=='member'){
   await timed(f,page,`${role} member directory navigation`,()=>page.evaluate(()=>navigate('members')),()=>page.locator('#directory-search').waitFor());
   await timed(f,page,`${role} search 200 members`,()=>page.locator('#directory-search').fill('Roster Member 149'),()=>page.waitForFunction(()=>document.querySelector('#member-results')?.textContent.includes('Roster Member 149')&&!document.querySelector('#member-results')?.textContent.includes('Roster Member 148')));
   assert.equal(await page.locator('#directory-search').inputValue(),'Roster Member 149');assert.equal(await page.locator('#directory-search').evaluate(el=>document.activeElement===el),true);
   await timed(f,page,`${role} attendance navigation`,()=>page.evaluate(()=>navigate('attendance')),()=>page.locator('.attendance-panel .stats-grid.three').waitFor());
   // Use real text-verification and confirmed check-in handlers, bypassing camera hardware only.
   await page.evaluate(()=>verifyScanned('7kq2 m9xd',true));await page.locator('#identity-confirmed').check();
   await timed(f,page,`${role} check-in confirmation`,()=>page.locator('#checkin-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Check-in confirmed')&&document.querySelector('.attendance-panel tbody')?.textContent.includes('Existing Member')),{busy:'button[form="checkin-form"]:disabled'});
   assert.equal(f.requests.filter(item=>item.path==='/api/check-in').length,1);assert.equal(f.checked,true);checks.push(`${role}: confirmed check-in duplicate protection and operational navigation`);
  }else{
   await timed(f,page,'member membership navigation',()=>page.evaluate(()=>navigate('members')),()=>page.locator('#fitness-survey').waitFor());
   await page.getByRole('button',{name:'Edit answers',exact:true}).click();await page.locator('#survey-goal').selectOption('Build strength');await page.locator('#health-weight').fill('72');
   await timed(f,page,'member combined profile save',()=>page.locator('#member-survey-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.getByRole('button',{name:'Edit answers',exact:true}).waitFor(),{busy:'#member-survey-form button:disabled'});
   assert.equal(f.requests.filter(item=>item.method==='POST'&&['/api/member-survey','/api/member-health'].includes(item.path)).length,2);assert.equal(f.health.weightKg,72);checks.push('combined save: distinct private payloads, immediate confirmed data, no duplicate mutations');
   await page.locator('[data-action="edit-profile"]').click();await page.locator('#edit-phone').fill('09170000002');
   await timed(f,page,'member contact form save',()=>page.locator('#profile-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.waitForFunction(()=>!document.querySelector('#profile-form')),{busy:'button[form="profile-form"]:disabled'});
   await timed(f,page,'member attendance tracker navigation',()=>page.evaluate(()=>navigate('attendance')),()=>page.locator('#attendance-tracker-summary').waitFor());
   await timed(f,page,'member attendance refresh',()=>page.locator('[data-action="attendance-tracker-refresh"]').click(),()=>page.waitForFunction(()=>document.querySelector('#member-attendance')&&!document.querySelector('#member-attendance').hasAttribute('aria-busy')),{busy:'[data-action="attendance-tracker-refresh"]:disabled'});
   await timed(f,page,'member My goal navigation',()=>page.evaluate(()=>navigate('goal')),()=>page.locator('#progress-summary').waitFor());
   await page.locator('[data-action="progress-edit-goal"]').click();await page.locator('#progress-goal-form [name="targetWeightKg"]').fill('66');await page.locator('#progress-goal-confirm').check();
   await timed(f,page,'member goal save',()=>page.locator('#progress-goal-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.waitForFunction(()=>!document.querySelector('#progress-goal-form')),{busy:'#member-progress[aria-busy="true"]'});
   await page.locator('[data-action="progress-record-weight"]').click();await page.locator('#progress-weight-form [name="weightKg"]').fill('61.2');
   await timed(f,page,'member weight save',()=>page.locator('#progress-weight-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.waitForFunction(()=>!document.querySelector('#progress-weight-form')),{busy:'#member-progress[aria-busy="true"]'});
   assert.equal(f.progress.measurements.length,2);checks.push('goal/weight: confirmed response updates, no full-state fetch, duplicate submission protection');
   await page.evaluate(()=>navigate('payments'));await page.locator('[data-action="pay"][data-id="INV-NEXT"]').click();
   await timed(f,page,'member payment method selection',()=>page.locator('#invoice-channel').selectOption('card'),()=>page.waitForFunction(()=>document.querySelector('#invoice-channel')?.value==='card'));
   await timed(f,page,'member checkout initiation',()=>page.locator('#paymongo-member-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();}),()=>page.waitForFunction(()=>document.querySelector('[data-action="paymongo-status"]')),{busy:'button[form="paymongo-member-form"]:disabled'});
   await timed(f,page,'member unchanged payment status refresh',()=>page.locator('[data-action="paymongo-status"]').evaluate(button=>button.click()),()=>page.waitForFunction(()=>document.querySelector('[data-action="paymongo-status"]:not(:disabled)')));
   assert.equal(f.requests.filter(item=>item.path==='/api/paymongo/checkout').length,1);assert.equal(f.invoices[1].paidCents,0);checks.push('checkout: original invoice/card, one mutation, no premature paid/access state');
  }
  clean(f);await page.close();
 }
 const restored=fixture('member');const page=await open(restored,'goal');await page.locator('#progress-summary').waitFor();clean(restored);await page.close();
 }
 await mkdir('artifacts/performance-phase',{recursive:true});const artifact={label,revision:revision||'working tree',sourceAssets:Object.fromEntries([...assets].map(([path,body])=>[path,createHash('sha256').update(body).digest('hex')])),recordedAt:new Date().toISOString(),environment:{browser:'headless Chromium / Edge',apiLatencyMs:API_MS,checkoutLatencyMs:PROVIDER_MS,operationalRoster:200,network:'all API requests intercepted; zero hosted writes',interpretation:'Controlled comparative frontend benchmark. These are not production, database or real provider latency measurements.'},results,checks};
 await writeFile(`artifacts/performance-phase/${label}.json`,JSON.stringify(artifact,null,2)+'\n');
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const summary=[...new Set(results.map(row=>row.name))].map(name=>{const rows=results.filter(row=>row.name===name);return {name,runs:rows.length,wallMs:median(rows.map(row=>row.wallMs)),requestCount:median(rows.map(row=>row.requestCount)),responseBytes:median(rows.map(row=>row.responseBytes)),browserRenderMs:median(rows.map(row=>row.browserRenderMs)),browserJsonDecodeMs:median(rows.map(row=>row.browserJsonDecodeMs)),busyFeedbackMs:rows.every(row=>row.busyFeedbackMs!==null)?median(rows.map(row=>row.busyFeedbackMs)):null};});
 await writeFile(`artifacts/performance-phase/${label}-summary.json`,JSON.stringify({label,summary},null,2)+'\n');
 console.log(JSON.stringify({label,summary,checks:[...new Set(checks)]},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
