import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
import {manilaTime,manilaClock} from '../src/attendance.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 13, end to end on the local stack: the attendance report (API and screen), CSV export, a member's own
// visit history beyond the global 50, "Visits today", and (13A) the pass screen's check-in status. Every fixture is removed afterwards.
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const db=serviceClient(env),users=[],passed=[];
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const root=path.resolve('public');
function serve(workspace,files=false){
 let origin;
 const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/api/'))return handle(req,res,{...env,APP_WORKSPACE:workspace,APP_ORIGIN:origin});
  try{
   assert(files);const file=path.resolve(root,'.'+new URL(req.url,origin).pathname),target=file===root?path.join(root,'index.html'):file;assert(target.startsWith(root+path.sep));
   res.setHeader('Content-Type',target.endsWith('.js')?'application/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(target));
  }catch{res.statusCode=404;res.end();}
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve({server,origin});}));
}
function client(origin){
 let cookies='';
 const send=async(method,endpoint,body,status)=>{
  const response=await fetch(origin+'/api'+endpoint,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookies?{Cookie:cookies}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const data=await response.json().catch(()=>({}));assert.equal(response.status,status,`${method} ${endpoint}: ${data.error||response.status}`);return data;
 };
 return {post:(e,b,s=200)=>send('POST',e,b,s),get:(e,s=200)=>send('GET',e,undefined,s)};
}
// Task 11: fixture members come with their fitness survey (as if filled in at the desk), so they skip the first-login survey.
const SURVEY={experience:'regular',exercises:['strength'],availableDays:['mon']};
async function account(workspace,role,name,plan){
 const email=`attendance-${role}-${randomUUID().slice(0,8)}@example.invalid`,password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:workspace,...(role==='member'?{}:{ff_role:role})},
  user_metadata:{form_fitness:true,name,phone:'09170000080',...(plan?{plan,start:today()}:{}),...(role==='member'?{survey:SURVEY}:{})}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email,password,name};
}
const day=offset=>{const d=new Date(today()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-offset);return d.toISOString().slice(0,10);};
async function visits(workspace,member,staffId,offsets){
 const membership=result(await db.from('ff_memberships').select('id').eq('member_id',member.id).limit(1).single()).id;
 const rows=offsets.map((offset,i)=>({workspace,member_id:member.id,membership_id:membership,nonce:randomUUID(),confirmed_by:staffId,checkin_date:day(offset),
  created_at:`${day(offset)}T0${2+i%7}:${String(10+i%50).padStart(2,'0')}:00Z`}));
 result(await db.from('ff_checkins').insert(rows));
 return rows;
}
const qs=params=>'?'+new URLSearchParams(params);
let browser,prod,demo;
try{
 await mkdir('test-results',{recursive:true});
 prod=await serve('production',true);demo=await serve('demo');
 const admin=await account('production','admin','LOCAL TEST Attendance Admin'),staff=await account('production','staff','LOCAL TEST Front Desk');
 const history=await account('production','member','LOCAL TEST History','basic');
 const others=[];
 for(let i=0;i<11;i++)others.push(await account('production','member',i===0?'=SUM(A1) Test':`LOCAL TEST Visitor ${i}`,i%2?'plus':'basic'));
 const demoAdmin=await account('demo','admin','LOCAL TEST Demo Admin'),demoMember=await account('demo','member','LOCAL TEST Demo Visitor','basic');
 // 55 recent visits by others; the history member's 35 are all older, so none is in the global latest 50.
 const otherRows=[];for(const member of others)otherRows.push(...await visits('production',member,staff.id,[0,1,2,3,4]));
 const historyRows=await visits('production',history,staff.id,Array.from({length:35},(_,i)=>5+i));
 const demoRows=await visits('demo',demoMember,demoAdmin.id,[1,2,3]);

 const staffApi=client(prod.origin),adminApi=client(prod.origin),memberApi=client(prod.origin),demoApi=client(demo.origin);
 await staffApi.post('/login',{email:staff.email,password:staff.password});await adminApi.post('/login',{email:admin.email,password:admin.password});
 await memberApi.post('/login',{email:history.email,password:history.password});await demoApi.post('/login',{email:demoAdmin.email,password:demoAdmin.password});
 const week={from:day(6),to:day(0)};
 const expected=result(await db.from('ff_checkins').select('member_id').eq('workspace','production').gte('checkin_date',week.from).lte('checkin_date',week.to));

 assert.equal((await fetch(prod.origin+'/api/reports/attendance'+qs(week))).status,401,'signed out');
 assert.equal((await memberApi.get('/reports/attendance'+qs(week),403)).error,'Gym staff access is required.');
 const report=await staffApi.get('/reports/attendance'+qs(week));
 assert.deepEqual(report.totals,{visits:expected.length,uniqueMembers:new Set(expected.map(r=>r.member_id)).size,days:7,dailyAverage:Math.round(expected.length/7*10)/10});
 assert.equal(report.truncated,false);
 for(let i=1;i<report.visits.length;i++)assert(report.visits[i-1].date>=report.visits[i].date,'newest first');
 const sample=otherRows.find(r=>r.member_id===others[1].id&&r.checkin_date===day(0));
 assert.deepEqual(report.visits.find(v=>v.memberId===others[1].id&&v.date===day(0)),
  {id:report.visits.find(v=>v.memberId===others[1].id&&v.date===day(0)).id,date:day(0),time:manilaTime(sample.created_at),memberId:others[1].id,name:'LOCAL TEST Visitor 1',plan:'Momentum',confirmedBy:'LOCAL TEST Front Desk'});
 assert.equal(report.visits.filter(v=>v.memberId===history.id).length,2,'the history member visited twice this week (5 and 6 days ago)');
 assert.deepEqual((await adminApi.get('/reports/attendance'+qs(week))).totals,report.totals,'administrators see the same');
 pass('The attendance report: 401 signed out, 403 for a member, 200 for staff and administrators, with totals, plan names, confirming staff, Manila times and newest first');

 const plus=await staffApi.get('/reports/attendance'+qs({...week,plan:'plus'}));
 assert(plus.visits.length>0&&plus.visits.every(v=>v.plan==='Momentum'));
 assert.equal(plus.visits.filter(v=>others.some(o=>o.id===v.memberId)).length,otherRows.filter(r=>others.findIndex(o=>o.id===r.member_id)%2===1).length);
 for(const [label,params] of [['a bad date',{from:'2026-02-30',to:day(0)}],['From after To',{from:day(0),to:day(1)}],['367 days',{from:day(366),to:day(0)}],
   ['a future To',{from:day(1),to:day(-1)}],['an unknown plan',{...week,plan:'gold'}],['missing dates',{}]])
  await staffApi.get('/reports/attendance'+qs(params),400).catch(e=>{throw Error(label+': '+e.message);});
 pass('The plan filter returns only that plan; an invalid range or an unknown plan gets 400');

 const wide={from:day(60),to:day(0)};
 const prodWide=await staffApi.get('/reports/attendance'+qs(wide)),demoWide=await demoApi.get('/reports/attendance'+qs(wide));
 assert(!prodWide.visits.some(v=>v.memberId===demoMember.id),'production staff never see the demo workspace');
 assert.deepEqual(demoWide.visits.filter(v=>v.memberId===demoMember.id).map(v=>v.date).sort(),demoRows.map(r=>r.checkin_date).sort());
 assert(!demoWide.visits.some(v=>v.memberId===history.id||others.some(o=>o.id===v.memberId)),'and the demo workspace never sees production');
 pass('Workspace isolation: each workspace\'s staff see only their own visits');

 const memberState=await memberApi.get('/state'),staffState=await staffApi.get('/state');
 assert(!staffState.checkins.some(c=>c.memberId===history.id),'the global latest 50 hold none of this member\'s visits');
 const own=[...historyRows].sort((a,b)=>b.created_at.localeCompare(a.created_at));
 assert.deepEqual(memberState.visits.recent,own.slice(0,30).map(r=>({date:r.checkin_date,time:manilaClock(r.created_at)})),'their own last 30, newest first, on the 12-hour clock');
 assert.deepEqual(memberState.visits.last,{date:own[0].checkin_date,time:manilaClock(own[0].created_at)},'the last visit');
 assert.equal(memberState.visits.thisMonth,historyRows.filter(r=>r.checkin_date.startsWith(today().slice(0,7))).length);
 assert(memberState.checkins.every(c=>c.memberId===history.id),'a member only ever reads their own check-ins');
 assert.equal(memberState.stats,undefined);
 pass('My visits: the member\'s own last 30 visits, the last visit and this month\'s count, correct beyond the global 50, and nobody else\'s');

 // 13A: the pass screen asks whether the caller has checked in today. Only their own row counts.
 const visitor=others[1],visitorApi=client(prod.origin);await visitorApi.post('/login',{email:visitor.email,password:visitor.password});
 const visitorToday=otherRows.find(r=>r.member_id===visitor.id&&r.checkin_date===day(0));
 const seen=await visitorApi.get('/checkin-status');
 assert.deepEqual({...seen,at:new Date(seen.at).toISOString()},{checkedIn:true,date:day(0),time:manilaClock(visitorToday.created_at),at:new Date(visitorToday.created_at).toISOString(),plan:'plus',planName:'Momentum'},'Task 12A: with the plan name the cycle was bought as');
 assert.deepEqual(await memberApi.get('/checkin-status'),{checkedIn:false,date:day(0)},'eleven other members visited today, but not this one');
 const demoVisitorApi=client(demo.origin);await demoVisitorApi.post('/login',{email:demoMember.email,password:demoMember.password});
 assert.deepEqual(await demoVisitorApi.get('/checkin-status'),{checkedIn:false,date:day(0)},'the demo member\'s older visits don\'t count as today');
 assert.equal((await staffApi.get('/checkin-status',403)).error,'Sign in as a member.');
 assert.equal((await fetch(prod.origin+'/api/checkin-status')).status,401,'signed out');
 pass('Check-in status: a member sees only their own check-in today (time, date and plan); staff get 403 and signed-out callers 401');

 const todayCount=result(await db.from('ff_checkins').select('id').eq('workspace','production').eq('checkin_date',today())).length;
 assert.equal(staffState.stats.visitsToday,todayCount);assert.equal((await adminApi.get('/state')).stats.visitsToday,todayCount);
 assert.equal((await demoApi.get('/state')).stats.visitsToday,result(await db.from('ff_checkins').select('id').eq('workspace','demo').eq('checkin_date',today())).length);
 pass('Visits today: an exact count of today\'s check-ins for staff and administrators, per workspace');

 // In the browser.
 browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[];
 const signIn=async(person,viewport={width:1440,height:1000},options={})=>{
  const page=await (await browser.newContext({viewport,acceptDownloads:true,...options})).newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(prod.origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);return page;
 };
 const shot=async(page,name,fullPage=true)=>{await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`test-results/${name}.png`,fullPage});};
 const desk=await signIn(staff);
 const visitsCard=desk.locator('.stats-grid.with-visits .stat').filter({hasText:'Visits today'});
 await visitsCard.waitFor();assert.match(await visitsCard.innerText(),new RegExp(`\\b${todayCount}\\b`));
 await shot(desk,'attendance-dashboard',false);
 await desk.evaluate(()=>navigate('attendance'));
 await desk.locator('.attendance-panel .stats-grid.three').waitFor();
 const shownTotals=await desk.locator('.attendance-panel .stat-value').allInnerTexts();
 assert.deepEqual(shownTotals,[String(report.totals.visits),String(report.totals.uniqueMembers),report.totals.dailyAverage.toFixed(1)]);
 assert.equal(await desk.locator('.attendance-panel tbody tr').count(),report.visits.length);
 assert.equal(await desk.locator('#attendance-from').inputValue(),week.from);assert.equal(await desk.locator('#attendance-to').inputValue(),week.to);
 await shot(desk,'attendance-report');
 const downloading=desk.waitForEvent('download');
 await desk.getByRole('button',{name:'Export CSV',exact:true}).click();
 const download=await downloading;
 assert.equal(download.suggestedFilename(),`RepReady-attendance-${week.from}-to-${week.to}.csv`);
 const csvText=await readFile(await download.path(),'utf8');const lines=csvText.replace(/^﻿/,'').split('\r\n');
 assert.equal(lines[0],'"Date","Time (Manila)","Member ID","Member","Plan","Confirmed by"');assert.equal(lines.length,report.visits.length+1);
 assert(lines.some(l=>l.includes(`"'=SUM(A1) Test"`)),'a member name starting with = is neutralised (formula-injection guard)');
 await desk.locator('#attendance-plan').selectOption('plus');await desk.getByRole('button',{name:'Apply',exact:true}).click();
 await desk.locator('.attendance-panel tbody tr').first().waitFor();
 await desk.waitForFunction(n=>document.querySelectorAll('.attendance-panel tbody tr').length===n,plus.visits.length);
 assert((await desk.locator('.attendance-panel tbody tr td:nth-child(4)').allInnerTexts()).every(t=>t==='Momentum'));
 await desk.locator('#attendance-from').fill(day(1));await desk.locator('#attendance-to').fill(day(0));await desk.locator('#attendance-plan').selectOption('all');
 await desk.getByRole('button',{name:'Apply',exact:true}).click();await desk.waitForFunction(()=>document.querySelector('.attendance-panel .stat-foot')?.textContent.includes('2 days'));
 const phone=await signIn(staff,{width:390,height:844});await phone.evaluate(()=>navigate('attendance'));
 await phone.locator('.attendance-panel .stats-grid.three').waitFor();
 assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'no sideways page scroll on a phone');
 await shot(phone,'attendance-report-phone');
 // Attendance has its own navigation; Members retains its four operational tabs.
 const adminPhone=await signIn(admin,{width:390,height:844});await adminPhone.evaluate(()=>navigate('members'));
 const tabs=adminPhone.locator('[aria-label="Membership sections"] .tab');assert.equal(await tabs.count(),4,'roster, plans, staff and unpaid accounts');
 const fits=()=>adminPhone.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1);
 const inView=()=>adminPhone.evaluate(()=>{const b=document.querySelector('[aria-label="Membership sections"]').getBoundingClientRect(),t=document.querySelector('[aria-label="Membership sections"] .tab.active').getBoundingClientRect();return t.left>=b.left-1&&t.right<=b.right+1;});
 for(const tab of ['roster','plans','staff','unpaid']){
  await adminPhone.locator(`[data-action="member-tab"][data-tab="${tab}"]`).click();
  await adminPhone.waitForFunction(id=>document.querySelector('[aria-label="Membership sections"] .tab.active')?.dataset.tab===id,tab);
  assert(await fits(),`no sideways page scroll on a phone with the ${tab} tab open`);assert(await inView(),`the ${tab} tab is in view once open`);
 }
 await adminPhone.evaluate(()=>navigate('attendance'));await adminPhone.locator('.attendance-panel .stats-grid.three').waitFor();
 assert.equal(await adminPhone.locator('[data-tab="attendance"]').count(),0,'attendance is no longer a member-management tab');
 await shot(adminPhone,'attendance-admin-phone',false);
 pass('Browser: dedicated Attendance (last 7 days by default, totals, newest-first table, plan filter, Apply), CSV export with its file name and formula guard, dashboard visits and phone layouts');

 const me=await signIn(history);await me.evaluate(()=>navigate('attendance'));
 await me.locator('#attendance-tracker-summary').waitFor();
 await me.locator('#member-attendance-period').selectOption('month');
 await me.locator('#member-attendance-form').getByRole('button',{name:'Apply',exact:true}).click();
 await me.waitForFunction(()=>document.querySelector('#attendance-calendar .attendance-calendar')?.classList.contains('month'));
 const expectedTracker=await memberApi.get('/member-attendance'+qs({period:'month',date:today()}));
 const panel=me.locator('#member-attendance');
 assert.deepEqual(await panel.locator('#attendance-tracker-summary strong').allInnerTexts(),[
  String(expectedTracker.summary.attendedDays),String(expectedTracker.summary.events),
  expectedTracker.summary.percentage===null?'Not enough history yet':`${expectedTracker.summary.percentage}%`
 ]);
 assert.equal(await panel.locator('#member-attendance-history tbody tr').count(),expectedTracker.history.length,'the selected calendar month, rather than a truncated last-30 list');
 if(expectedTracker.history.length)assert.match(await panel.locator('tbody tr').first().innerText(),/\d{1,2}:\d\d\s*[AP]M/i,'12-hour times');
 assert.equal(await panel.locator('.attendance-calendar-day').count(),expectedTracker.days.length);
 await shot(me,'attendance-my-visits');
 assert.equal(await me.locator('[data-tab="attendance"]').count(),0);
 assert.deepEqual(errors,[],'no JavaScript errors');
 pass('Browser: the owner-only Attendance tracker shows the selected calendar month, distinct days, event totals and its history; members get dedicated Attendance navigation');
 console.log(`PASS: ${passed.length} attendance checks`);
}finally{
 if(browser)await browser.close();prod?.server.close();demo?.server.close();
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
}
