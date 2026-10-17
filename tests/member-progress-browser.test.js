// Real member-progress assets, isolated owner fixtures and an ephemeral server. No live writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after,before,describe,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor,planView} from '../src/state.js';
import {createAttendanceTracker} from '../public/attendance-tracker.js';

const TODAY='2026-10-17',MEMBER='11111111-2222-3333-4444-555555555555';
const recordedAt='2026-10-12T01:00:00Z';
const id=value=>`aaaaaaaa-bbbb-cccc-dddd-${String(value).padStart(12,'0')}`;
function fixture(role='member') {
 const plans=[planView({id:'basic',name:'Essential',coaching:'none',coach_sessions:0,price_cents:89900,available:true,days:30,description:'Membership plan',features:['Purchased gym access']})];
 const member={id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:recordedAt}};
 return {role,member,plans,user:{id:role==='member'?MEMBER:role+'-user',memberId:role==='member'?MEMBER:role+'-user',role,name:role==='member'?'Existing Member':'Gym '+role,workspace:'production',can:capabilitiesFor(role)},
  progress:{today:TODAY,goals:[],currentGoal:null,measurements:[],healthWeight:{weightKg:70,recordedAt}},reads:[],posts:[],errors:[],unexpected:[],fail:{},sequence:0};
}
function goal(f,fields={}) {
 const item={id:id(100),periodId:id(101),goalType:'gain',status:'active',startDate:'2026-10-12',startingWeightKg:60,measurementDate:'2026-10-12',targetWeightKg:65,recordedAt,endedAt:null,...fields};
 f.progress.goals=[item];f.progress.currentGoal=item;return item;
}
function weights(f,entries=[['2026-10-12',60],['2026-10-16',61]]) {
 f.progress.measurements=entries.map(([date,weightKg],index)=>({id:id(200+index),date,weightKg,recordedAt,updatedAt:recordedAt}));
}
const snapshot=f=>({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:[{id:'paid-current',memberId:MEMBER,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:89900,start:f.member.start,end:f.member.end,due:f.member.start,created:f.member.start}],memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},stats:f.role==='member'?undefined:{visitsToday:0},memberHealth:f.role==='member'?{heightCm:175,weightKg:70,ageBand:'20plus',conditions:['asthma'],updatedAt:recordedAt}:null,paymongo:{configured:false,methods:[],testMode:true}});
function attendance() {
 return createAttendanceTracker({period:'week',date:TODAY,today:TODAY,events:[{id:'mon',at:'2026-10-12T01:00:00Z'},{id:'wed',at:'2026-10-14T01:00:00Z'}],schedules:[{effectiveFrom:'2026-10-12',days:['mon','wed','fri']}],coverage:[{start:'2026-10-01',end:'2026-10-30'}]});
}
function apply(f,body) {
 const p=f.progress;
 if(body.action==='save_goal'||body.action==='new_goal') {
  const existing=p.measurements.find(entry=>entry.date===body.measurementDate);
  if(body.goalType!=='attendance'&&existing&&existing.weightKg!==body.startingWeightKg)return {status:409,error:'A different weight is already recorded for that date. Correct it explicitly before confirming your goal.'};
  const previous=p.currentGoal;
  if(previous)previous.endedAt='2026-10-17T03:00:00Z';
  const created={...body,id:id(++f.sequence),periodId:body.action==='new_goal'||!previous?id(500+f.sequence):previous.periodId,status:previous&&body.action==='save_goal'?previous.status:'active',recordedAt:'2026-10-17T03:00:00Z',endedAt:null};
  delete created.action;delete created.goalId;delete created.requestId;p.goals.push(created);p.currentGoal=created;
  if(body.goalType!=='attendance'&&!p.measurements.some(entry=>entry.date===body.measurementDate))p.measurements.push({id:id(700+f.sequence),date:body.measurementDate,weightKg:body.startingWeightKg,recordedAt,updatedAt:recordedAt});
 }else if(body.action==='pause_goal'||body.action==='resume_goal') {
  p.currentGoal.status=body.action==='pause_goal'?'paused':'active';
 }else if(body.action==='add_weight') {
  if(p.measurements.some(entry=>entry.date===body.date))return {status:409,error:'A measurement already exists for this date. Edit the saved entry to replace it.'};
  p.measurements.push({id:id(800+(++f.sequence)),date:body.date,weightKg:body.weightKg,recordedAt:'2026-10-17T03:00:00Z',updatedAt:'2026-10-17T03:00:00Z'});
 }else if(body.action==='update_weight')Object.assign(p.measurements.find(entry=>entry.id===body.id),{date:body.date,weightKg:body.weightKg,updatedAt:'2026-10-17T03:00:00Z'});
 else if(body.action==='delete_weight')p.measurements=p.measurements.filter(entry=>entry.id!==body.id);
 else throw Error('Unexpected member-progress action '+body.action);
 return {memberProgress:structuredClone(p)};
}

describe('member goals and progress browser',{concurrency:false},()=>{
 let server,origin,browser;
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
 async function open(f,{view=f.role==='member'?'member':'admin',section='attendance',delayedModule=false}={}) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
  page.on('pageerror',error=>f.errors.push(error.message));
  await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.progressBrowserReady=true;}));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
   if(!path.startsWith('/api/')) {if(delayedModule&&path==='/member-progress.js')await new Promise(resolve=>setTimeout(resolve,400));return route.continue();}
   if(method==='GET')f.reads.push(path+url.search);else f.posts.push({path,body:request.postDataJSON()});
   let body,status=200;
   if(method==='GET'&&path==='/api/plans')body={plans:f.plans};
   else if(method==='GET'&&path==='/api/session')body={user:f.user,date:TODAY};
   else if(method==='GET'&&path==='/api/state')body=snapshot(f);
   else if(method==='GET'&&path==='/api/member-progress') {status=f.progressStatus||200;body=status===200?{memberProgress:structuredClone(f.progress)}:{error:'Your private progress session is no longer authorized.'};}
   else if(method==='GET'&&path==='/api/member-attendance')body=attendance();
   else if(method==='GET'&&path==='/api/reports/attendance')body={from:'2026-10-11',to:TODAY,totals:{visits:0,uniqueMembers:0,days:7,dailyAverage:0},truncated:false,visits:[]};
   else if(method==='POST'&&path==='/api/member-progress') {
    const data=request.postDataJSON();assert.equal(Object.keys(data).some(key=>/member|user|workspace/i.test(key)),false,'identity is never sent by the editor');
    if(f.hold)await f.hold;if(f.delay)await new Promise(resolve=>setTimeout(resolve,f.delay));
    if(f.fail[data.action]){status=502;body={error:f.fail[data.action]};}
    else {body=apply(f,data);if(body.status){status=body.status;body={error:body.error};}else if(f.lostResponse===data.action){status=502;body={error:'The confirmation response was interrupted.'};f.lostResponse=null;}}
   }else if(method==='POST'&&path==='/api/logout'){f.user=null;body={ok:true};}
   else {f.unexpected.push(`${method} ${path}`);status=500;body={error:'Unexpected isolated request'};}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${origin}/#/${view}/${section}`);await page.waitForFunction(()=>window.progressBrowserReady);return page;
 }
 const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);};
 const progress=async page=>{await page.getByRole('tab',{name:'My progress',exact:true}).click();await page.locator('#member-progress').waitFor();await page.waitForFunction(()=>document.querySelector('#member-progress')&&!document.querySelector('#member-progress').hasAttribute('aria-busy'));};
 const goalType=page=>page.locator('#progress-goal-form [name="goalType"]');
 const start=page=>page.locator('#progress-goal-form [name="startDate"]');
 const starting=page=>page.locator('#progress-goal-form [name="startingWeightKg"]');
 const measured=page=>page.locator('#progress-goal-form [name="measurementDate"]');
 const target=page=>page.locator('#progress-goal-form [name="targetWeightKg"]');
 const saveGoal=async page=>{await page.locator('#progress-goal-confirm').check();await page.locator('#progress-goal-form [type="submit"]').click();};
 const editNew=page=>page.locator('[data-action="progress-start-goal"]').click();
 async function setup(page,type='gain',{weight='60',targetWeight='65'}={}) {
  await goalType(page).selectOption(type);
  await start(page).fill('2026-10-12');
  if(type!=='attendance') {await starting(page).fill(weight);await measured(page).fill('2026-10-12');if(type!=='maintain')await target(page).fill(targetWeight);}
 }

 test('restored session preserves attendance and opens one private progress panel without auto-creating a suggested goal',async()=>{
  const f=fixture(),page=await open(f,{delayedModule:true});
  try {
   assert.equal(await page.getByRole('link',{name:'Attendance & Progress',exact:true}).count(),1);
   await page.locator('#attendance-tracker-summary').waitFor();
   assert.match(await page.locator('#attendance-tracker-summary').innerText(),/2\s*\/\s*3/);
   assert.match(await page.locator('#attendance-tracker-summary').innerText(),/66\.7%/);
   await progress(page);assert.equal(await page.locator('#member-progress').count(),1);
   assert.match(await page.locator('#member-progress').innerText(),/attendance consistency/i);
   assert.equal(f.posts.length,0,'survey suggestion does not create a goal');
   await page.getByRole('tab',{name:'Attendance',exact:true}).click();await page.locator('#attendance-tracker-summary').waitFor();
   assert.match(await page.locator('#attendance-tracker-summary').innerText(),/2\s*\/\s*3/);
   await page.reload();await page.waitForFunction(()=>window.progressBrowserReady);await progress(page);assert.equal(await page.locator('#member-progress').count(),1);assert.equal(f.posts.length,0);clean(f);
  }finally{await page.close();}
 });

 test('all four goals require confirmation, weight direction is validated and attendance requires no measurements',async()=>{
  for(const type of ['lose','gain','maintain','attendance']) {
   const f=fixture();f.member.goal='Manage weight';const page=await open(f);
   try {
    await progress(page);await editNew(page);assert.equal(await goalType(page).inputValue(),'','manage weight must not guess a direction');
    await setup(page,type,{weight:'60',targetWeight:type==='lose'?'55':'65'});
    await page.locator('#progress-goal-form [type="submit"]').click();assert.equal(f.posts.length,0,'explicit confirmation is required');
    await saveGoal(page);await page.locator('[data-action="progress-edit-goal"]').waitFor();
    assert.equal(f.posts.length,1);const body=f.posts[0].body;assert.equal(body.action,'save_goal');assert.equal(body.goalType,type);
    assert.equal(body.startingWeightKg,type==='attendance'?null:60);assert.equal(body.targetWeightKg,['maintain','attendance'].includes(type)?null:type==='lose'?55:65);
    assert.equal(f.progress.currentGoal.goalType,type);clean(f);
   }finally{await page.close();}
  }
 });

 test('saved health weight is a labeled prefill but its date must be confirmed and validation submits nothing',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await progress(page);await editNew(page);await goalType(page).selectOption('lose');
   assert.equal(await starting(page).inputValue(),'70');assert.equal(await measured(page).inputValue(),'');
   assert.match(await page.locator('#member-progress').innerText(),/health profile|health-profile/i);
   assert.match(await page.locator('#member-progress').innerText(),/12 Oct 2026|12 October 2026/);
   await target(page).fill('75');await saveGoal(page);assert.equal(f.posts.length,0);
   await measured(page).fill('2026-10-12');await saveGoal(page);assert.equal(f.posts.length,0,'wrong loss direction rejected');
   await target(page).fill('55');await starting(page).fill('0');await saveGoal(page);assert.equal(f.posts.length,0);
   await starting(page).fill('70');await start(page).fill('2026-10-18');await saveGoal(page);assert.equal(f.posts.length,0);
   await start(page).fill('2026-10-12');await saveGoal(page);await page.locator('[data-action="progress-edit-goal"]').waitFor();
   assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.measurementDate,'2026-10-12');clean(f);
  }finally{await page.close();}
 });

 test('goal edits, pause/resume and new goal preserve earlier periods and saved weigh-ins',async()=>{
  const f=fixture();goal(f);weights(f);const page=await open(f);
  try {
   await progress(page);const original=structuredClone(f.progress.currentGoal),measurements=structuredClone(f.progress.measurements);
   await page.locator('[data-action="progress-edit-goal"]').click();await target(page).fill('66');await saveGoal(page);await page.locator('[data-action="progress-pause-goal"]').waitFor();
   assert.equal(f.progress.goals.length,2);assert.equal(f.progress.currentGoal.periodId,original.periodId);assert.equal(f.progress.goals[0].targetWeightKg,65);
   await page.locator('[data-action="progress-pause-goal"]').click();await page.locator('[data-action="progress-resume-goal"]').waitFor();assert.equal(f.progress.currentGoal.status,'paused');
   await page.locator('[data-action="progress-resume-goal"]').click();await page.locator('[data-action="progress-pause-goal"]').waitFor();assert.equal(f.progress.currentGoal.status,'active');
   await page.locator('[data-action="progress-new-goal"]').click();await setup(page,'maintain',{weight:'61'});await measured(page).fill('2026-10-16');await start(page).fill('2026-10-17');await saveGoal(page);await page.locator('[data-action="progress-edit-goal"]').waitFor();
   assert.notEqual(f.progress.currentGoal.periodId,original.periodId);assert.equal(f.progress.currentGoal.goalType,'maintain');assert.deepEqual(f.progress.measurements,measurements);clean(f);
  }finally{await page.close();}
 });

 test('dated records add, explicitly correct an existing date and confirm deletion without mutating health details',async()=>{
  const f=fixture();goal(f);const page=await open(f);
  try {
   await progress(page);assert.equal(await page.locator('#progress-weight-form [name="date"]').inputValue(),TODAY);
   await page.locator('#progress-weight-form [name="weightKg"]').fill('61.2');await page.locator('#progress-weight-form [type="submit"]').click();
   await page.locator('[data-action="progress-edit-weight"]').waitFor();assert.equal(f.progress.measurements.length,1);
   await page.locator('#progress-weight-form [name="weightKg"]').fill('62');await page.locator('#progress-weight-form [type="submit"]').click();
   assert.equal(f.progress.measurements.length,1,'duplicate dates never silently replace');
   await page.locator('[data-action="progress-replace-weight"]').click();await page.locator('#progress-weight-form [name="weightKg"]').fill('62');await page.locator('#progress-weight-form [type="submit"]').click();
   await page.waitForFunction(()=>document.querySelector('#member-progress').innerText.includes('62'));assert.equal(f.progress.measurements.length,1);assert.equal(f.progress.measurements[0].weightKg,62);
   await page.locator('[data-action="progress-delete-weight"]').click();assert.match(await page.locator('#progress-delete-confirm').innerText(),/progress|chart|measurement/i);assert.equal(f.progress.measurements.length,1);
   await page.locator('[data-action="progress-confirm-delete"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-action="progress-edit-weight"]').length===0);assert.deepEqual(f.progress.measurements,[]);
   assert.ok(f.posts.every(item=>item.path==='/api/member-progress'),'never overwrites private health or attendance');clean(f);
  }finally{await page.close();}
 });

 test('failed goal and measurement writes retain drafts, reject duplicate submits and show only confirmed results until retry',async()=>{
  const f=fixture();f.fail.save_goal='Goal could not be saved.';const page=await open(f);let release;
  try {
   await progress(page);await editNew(page);await setup(page);await saveGoal(page);await page.locator('#progress-goal-error').waitFor();
   assert.equal(await target(page).inputValue(),'65');assert.equal(f.progress.currentGoal,null);
   delete f.fail.save_goal;await saveGoal(page);await page.locator('[data-action="progress-edit-goal"]').waitFor();
   assert.equal(f.posts[0].body.requestId,f.posts[1].body.requestId,'an unchanged goal retry keeps its idempotent request identity');
   const confirmed=structuredClone(f.progress.measurements);f.fail.add_weight='Measurement could not be saved.';await page.locator('#progress-weight-form [name="weightKg"]').fill('61.3');await page.locator('#progress-weight-form [type="submit"]').click();
   await page.locator('#progress-weight-error').waitFor();assert.equal(await page.locator('#progress-weight-form [name="weightKg"]').inputValue(),'61.3');assert.deepEqual(f.progress.measurements,confirmed);
   delete f.fail.add_weight;f.hold=new Promise(resolve=>{release=resolve;});
   const before=f.posts.length;await page.locator('#progress-weight-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
   await page.waitForFunction(()=>document.querySelector('#progress-weight-form [type="submit"]').matches(':disabled'));
   assert.equal(f.posts.length,before+1);assert.deepEqual(f.progress.measurements,confirmed);release();f.hold=null;
   await page.waitForFunction(()=>document.querySelectorAll('[data-action="progress-edit-weight"]').length===2);assert.equal(f.progress.measurements.length,2);assert.equal(f.progress.measurements.at(-1).weightKg,61.3);clean(f);
  }finally{release?.();await page.close();}
 });

 test('future, empty and non-finite measurements are rejected before submission',async()=>{
  const f=fixture();goal(f);const page=await open(f);
  try {
   await progress(page);
   for(const value of ['', '0','501','61.23']) {await page.locator('#progress-weight-form [name="weightKg"]').fill(value);await page.locator('#progress-weight-form [type="submit"]').click();assert.equal(f.posts.length,0);}
   await page.locator('#progress-weight-form [name="weightKg"]').fill('61');await page.locator('#progress-weight-form [name="date"]').fill('2026-10-18');await page.locator('#progress-weight-form [type="submit"]').click();assert.equal(f.posts.length,0);clean(f);
  }finally{await page.close();}
 });

 test('confirmed latest values use date order; target bars clamp toward, away and beyond without invented health claims',async()=>{
  for(const [latest,percent] of [[61,20],[59,0],[67,100]]) {
   const f=fixture();goal(f);weights(f,[['2026-10-16',latest],['2026-10-12',60],['2026-10-14',60.5]]);const page=await open(f);
   try {
    await progress(page);assert.equal(await page.locator('#progress-chart').count(),1);
    assert.equal(Number(await page.getByRole('progressbar').getAttribute('value')),percent);
    assert.match(await page.locator('#progress-summary .progress-values > div').filter({has:page.locator('dt',{hasText:'Latest logged weight'})}).innerText(),new RegExp(`${latest}(?:\\.0)?\\s*kg`));
    const chart=page.locator('#progress-chart');assert.match(await chart.getAttribute('aria-label')||await chart.textContent(),/weight|measurement/i);
    const points=await chart.locator('circle title').allTextContents();assert.equal(points.length,3);assert.match(points[0],/12 Oct 2026/);assert.match(points[1],/14 Oct 2026/);assert.match(points[2],/16 Oct 2026/);
    assert.doesNotMatch(await page.locator('#member-progress').innerText(),/medically cleared|improved health|attendance caused/i);clean(f);
   }finally{await page.close();}
  }
 });

 test('empty, single-measurement and target-free states never fabricate a chart or percentage',async()=>{
  for(const entries of [[],[['2026-10-16',61]]]) {
   const f=fixture();goal(f,{targetWeightKg:null});weights(f,entries);const page=await open(f);
   try {
    await progress(page);assert.equal(await page.locator('#progress-chart').count(),0);assert.equal(await page.getByRole('progressbar').count(),0);
    assert.match(await page.locator('#member-progress').innerText(),/measurement|record|target/i);assert.deepEqual(f.posts,[]);clean(f);
   }finally{await page.close();}
  }
 });

 test('cancelling goal and weight edits discards drafts, and coached members retain their private tracking',async()=>{
  const f=fixture();goal(f);weights(f);f.member.terms={...f.member.terms,coaching:'personal',coachSessions:4};const page=await open(f);
  try {
   await progress(page);const confirmed=structuredClone(f.progress);
   await page.locator('[data-action="progress-edit-goal"]').click();await target(page).fill('68');
   await page.locator('[data-action="progress-cancel-goal"]').click();assert.deepEqual(f.posts,[]);
   await page.locator('[data-action="progress-edit-goal"]').click();assert.equal(await target(page).inputValue(),'65');
   await page.locator('[data-action="progress-cancel-goal"]').click();
   await page.locator('[data-action="progress-edit-weight"]').first().click();await page.locator('#progress-weight-form [name="weightKg"]').fill('66');
   await page.locator('[data-action="progress-cancel-weight"]').click();
   assert.deepEqual(f.progress,confirmed);assert.deepEqual(f.posts,[]);clean(f);
  }finally{await page.close();}
 });

 test('two overall measurements show honestly labeled history with no current goal or an attendance goal',async()=>{
  for(const kind of ['none','attendance']) {
   const f=fixture();weights(f);if(kind==='attendance')goal(f,{goalType:'attendance',startingWeightKg:null,measurementDate:null,targetWeightKg:null});const page=await open(f);
   try {
    await progress(page);assert.equal(await page.locator('#progress-chart').count(),1);
    assert.match(await page.locator('.progress-measurements').innerText(),/All recorded weights/);
    assert.equal(await page.getByRole('progressbar').count(),0);assert.deepEqual(f.posts,[]);clean(f);
   }finally{await page.close();}
  }
 });

 test('a lost confirmation keeps unconfirmed results out until explicit saved-record refresh reconciles them',async()=>{
  const f=fixture();goal(f);weights(f);f.lostResponse='add_weight';const page=await open(f);
  try {
   await progress(page);await page.locator('#progress-weight-form [name="weightKg"]').fill('62');await page.locator('#progress-weight-form [type="submit"]').click();
   await page.locator('#progress-weight-error').waitFor();assert.equal(f.progress.measurements.length,3,'isolated server accepted the record before the lost response');
   assert.match(await page.locator('#progress-summary .progress-values > div').filter({has:page.locator('dt',{hasText:'Latest logged weight'})}).innerText(),/61\.0 kg/);
   assert.equal(await page.locator('#progress-weight-form [name="weightKg"]').inputValue(),'62');
   await page.getByRole('button',{name:'Refresh saved records',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#progress-summary .progress-values')?.innerText.includes('62.0 kg'));
   assert.equal(await page.locator('#progress-weight-form [name="weightKg"]').inputValue(),'62','refresh preserves the member draft');
   assert.equal(f.posts.length,1);clean(f);
  }finally{await page.close();}
 });

 test('revoked or denied progress refresh clears previously displayed private measurements',async()=>{
  for(const status of [401,403]) {
   const f=fixture();goal(f);weights(f);const page=await open(f);
   try {
    await progress(page);assert.equal(await page.locator('#progress-summary').count(),1);f.progressStatus=status;
    await page.getByRole('button',{name:'Refresh saved records',exact:true}).click();await page.locator('#progress-error').waitFor();
    assert.equal(await page.locator('#progress-summary,#progress-chart,#progress-weight-form').count(),0);assert.doesNotMatch(await page.locator('#member-progress').innerText(),/60\.0 kg|61\.0 kg|65\.0 kg/);assert.deepEqual(f.posts,[]);clean(f);
   }finally{await page.close();}
  }
 });

 test('staff/admin attendance and administrator member preview never fetch owner progress or expose measurements',async()=>{
  for(const role of ['staff','admin']) {
   const f=fixture(role),page=await open(f);
   try {
    assert.equal(await page.getByRole('link',{name:'Attendance',exact:true}).count(),1);assert.equal(await page.getByRole('link',{name:'Attendance & Progress',exact:true}).count(),0);
    assert.equal(await page.getByRole('tab',{name:'My progress',exact:true}).count(),0);
    if(role==='admin') {await page.locator('[data-action="mode"][data-mode="member"]').click();await page.evaluate(()=>navigate('attendance'));assert.equal(await page.locator('#member-progress').count(),0);}
    assert.equal(f.reads.some(path=>path.startsWith('/api/member-progress')),false);assert.equal(f.reads.some(path=>path.startsWith('/api/member-health')),false);assert.deepEqual(f.posts,[]);clean(f);
   }finally{await page.close();}
  }
 });

 test('desktop and phone progress fit without duplicate forms or panels and logout stays usable',async()=>{
  const f=fixture();goal(f);weights(f);const page=await open(f);
  try {
   await progress(page);await mkdir('test-results',{recursive:true});
   for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px page`);
    assert.equal(await page.locator('#member-progress').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`${width}px panel`);
    assert.equal(await page.locator('#member-progress').count(),1);assert.equal(await page.locator('#progress-weight-form').count(),1);assert.equal(await page.locator('#member-progress form form').count(),0);
    assert.equal(await page.locator('[aria-label="Log out"]').isVisible(),true);
    await page.locator('#member-progress').screenshot({path:`test-results/member-progress-${width}.png`,animations:'disabled'});
   }
   await page.locator('[aria-label="Log out"]').click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();clean(f);
  }finally{await page.close();}
 });
});
