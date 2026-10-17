// The member tracker with real frontend assets and isolated owner-only API responses.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after,before,describe,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor,planView} from '../src/state.js';
import {createAttendanceTracker} from '../public/attendance-tracker.js';

const TODAY='2026-10-17',MEMBER='11111111-2222-3333-4444-555555555555',OTHER='22222222-3333-4444-5555-666666666666';
function fixture(id=MEMBER) {
 const plans=[planView({id:'basic',name:'Essential',coaching:'none',coach_sessions:0,price_cents:89900,available:true,days:30,description:'Membership plan',features:['Purchased gym access']})];
 const member={id,name:id===MEMBER?'Existing Member':'Second Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',
  survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed'],updatedAt:'2026-10-12T00:00:00Z'}};
 return {member,plans,user:{id,memberId:id,role:'member',name:member.name,workspace:'production',can:capabilitiesFor('member')},
  events:[{id:'visit-mon',at:'2026-10-12T01:00:00Z'},{id:'visit-wed',at:'2026-10-14T01:00:00Z'},{id:'visit-wed-extra',at:'2026-10-14T02:00:00Z'}],
  schedules:[{effectiveFrom:'2026-10-12',days:['mon','wed']}],coverage:[{start:'2026-10-01',end:'2026-10-30'}],reads:[],posts:[],trackerRequests:[],errors:[],unexpected:[],status:200,today:TODAY};
}
const snapshot=f=>({user:f.user,date:f.today,members:[f.member],plans:f.plans,invoices:[{id:'paid-current',memberId:f.member.id,plan:'basic',terms:f.plans[0],amount:899,amountCents:89900,paidCents:89900,start:f.member.start,end:f.member.end,due:f.member.start,created:f.member.start}],
 memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],staff:[],unpaidAccounts:[],settings:{payments:{},email:null},
 visits:{recent:[],last:null,thisMonth:0},memberHealth:{heightCm:175,weightKg:70,ageBand:'20plus',conditions:['asthma']},paymongo:{configured:false,methods:[],testMode:true}});

describe('member attendance tracker',{concurrency:false},()=>{
 let browser,server,origin;
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
 async function open(f,{section='attendance',clock=false}={}) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
  if(clock)await page.clock.install({time:new Date('2026-10-17T04:00:00Z')});
  page.on('pageerror',e=>f.errors.push(e.message));
  await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.memberAttendanceReady=true;}));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
   if(!path.startsWith('/api/'))return route.continue();
   if(method==='GET')f.reads.push(path+url.search);else f.posts.push({path,body:request.postDataJSON()});
   let body;
   if(method==='GET'&&path==='/api/plans')body={plans:f.plans};
   else if(method==='GET'&&path==='/api/session')body={user:f.user,date:f.today};
   else if(method==='GET'&&path==='/api/state')body=snapshot(f);
   else if(method==='GET'&&path==='/api/member-attendance') {
    assert.deepEqual([...url.searchParams.keys()].sort(),['date','period'],'no member selector or private health payload');
    const period=url.searchParams.get('period'),date=url.searchParams.get('date'),status=f.status;
    body=createAttendanceTracker({period,date,today:f.today,events:structuredClone(f.events),schedules:structuredClone(f.schedules),coverage:structuredClone(f.coverage)});
    const item={period,date,owner:f.user.id};f.trackerRequests.push(item);
    const gate=f.gate;
    if(gate&&!gate.used){gate.used=true;gate.begin();await gate.promise;}
    if(status!==200)return route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:status===401?'Session expired.':'Attendance service unavailable.'})});
   }else if(method==='POST'&&path==='/api/logout'){f.user=null;body={ok:true};}
   else {f.unexpected.push(`${method} ${path}`);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected isolated request'})});}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${origin}/#/member/${section}`);await page.waitForFunction(()=>window.memberAttendanceReady);return page;
 }
 const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);assert.equal(f.reads.some(path=>path.startsWith('/api/member-health')||path.startsWith('/api/reports/attendance')),false);};
 const ready=page=>page.locator('#attendance-tracker-summary').waitFor();
 const completed=page=>page.locator('#attendance-tracker-summary').innerText();
 function gate(f) {let release,begin;f.gate={used:false,promise:new Promise(resolve=>{release=resolve;}),started:new Promise(resolve=>{begin=resolve;}),begin:()=>begin()};return release;}
 const visibility=(page,hidden)=>page.evaluate(value=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>value});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>value?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));},hidden);

 test('restored session shows distinct days, separate event totals and two-of-two consistency; week and month controls update one calendar',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await ready(page);assert.equal(await page.locator('#member-attendance').count(),1);
   assert.match(await completed(page),/Consistent/);assert.match(await completed(page),/100%/);assert.match(await completed(page),/2\s*(?:\/|of)\s*2/);
   assert.equal(await page.locator('.attendance-calendar-day').count(),7);
   assert.equal(await page.locator('.attendance-calendar-day[data-status="attended"]').count(),2);
   assert.equal(await page.locator('#member-attendance-history tbody tr').count(),3);
   assert.match(await page.locator('#member-attendance').innerText(),/Asia\/Manila|Manila/);
   assert.doesNotMatch(await page.locator('#member-attendance').innerText(),/Asthma|BMI|175|70 kg/);
   await page.locator('#member-attendance-period').selectOption('month');await page.locator('#member-attendance-form').getByRole('button',{name:'Apply',exact:true}).click();
   await page.waitForFunction(()=>document.querySelectorAll('.attendance-calendar-day').length===31);
   assert.equal(f.trackerRequests.at(-1).period,'month');
   assert.equal(await page.locator('#member-attendance').count(),1);assert.equal(await page.locator('#member-attendance-form form').count(),0);
   await page.reload();await page.waitForFunction(()=>window.memberAttendanceReady);await ready(page);
   assert.equal(await page.locator('#member-attendance').count(),1);assert.deepEqual(f.posts,[]);clean(f);
  }finally{await page.close();}
 });

 test('missing history and changed schedules show transparent calendar states without fabricating past planned dates',async()=>{
  const f=fixture();f.schedules=[];f.events=[];const page=await open(f);
  try {
   await ready(page);assert.match(await completed(page),/Not enough history yet/);assert.doesNotMatch(await completed(page),/0%/);
   assert.equal(await page.locator('.attendance-calendar-day[data-status="usual-without-checkin"]').count(),0);
   f.schedules=[{effectiveFrom:'2026-10-12',days:['mon','wed']},{effectiveFrom:'2026-10-15',days:['fri']}];
   await page.locator('[data-action="attendance-tracker-refresh"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.attendance-calendar-day[data-status="usual-without-checkin"]').length===3);
   assert.match(await completed(page),/Building consistency/);assert.match(await completed(page),/0\s*(?:\/|of)\s*3/);
   assert.equal(await page.locator('.attendance-calendar-day[data-date="2026-10-17"][data-status="usual-without-checkin"]').count(),0);
   assert.equal(await page.locator('.attendance-calendar-day[data-date="2026-10-18"][data-status="usual-without-checkin"]').count(),0);clean(f);
  }finally{await page.close();}
 });

 test('visible polling reflects an externally recorded visit; hidden pages and navigation pause it and return refreshes immediately',async()=>{
  const f=fixture(),page=await open(f,{clock:true});
  try {
   await ready(page);const initial=f.trackerRequests.length;
   f.events.push({id:'staff-friday',at:'2026-10-16T02:00:00Z'});
   const refreshed=page.waitForResponse(response=>response.url().includes('/api/member-attendance'));
   await page.clock.fastForward(30001);await refreshed;
   await page.waitForFunction(()=>document.querySelector('.attendance-calendar-day[data-date="2026-10-16"]')?.dataset.status==='attended');
   assert.equal(f.trackerRequests.length,initial+1);
   await visibility(page,true);const hiddenCount=f.trackerRequests.length;await page.clock.fastForward(90001);assert.equal(f.trackerRequests.length,hiddenCount);
   const resumed=page.waitForResponse(response=>response.url().includes('/api/member-attendance'));await visibility(page,false);await resumed;
   await page.evaluate(()=>navigate('members'));const awayCount=f.trackerRequests.length;await page.clock.fastForward(90001);assert.equal(f.trackerRequests.length,awayCount);
   const returned=page.waitForResponse(response=>response.url().includes('/api/member-attendance'));await page.evaluate(()=>navigate('attendance'));await returned;await ready(page);
   assert.equal(f.trackerRequests.length,awayCount+1);assert.deepEqual(f.posts,[]);
   await page.locator('[aria-label="Log out"]').click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();
   const logoutCount=f.trackerRequests.length;await page.clock.fastForward(90001);assert.equal(f.trackerRequests.length,logoutCount,'logout stops tracker polling');
   assert.deepEqual(f.posts.map(item=>item.path),['/api/logout']);clean(f);
  }finally{await page.close();}
 });

 test('pending requests do not overlap across timer, visibility, focus and refresh triggers',async()=>{
  const f=fixture(),page=await open(f,{clock:true});let release;
  try {
   await ready(page);release=gate(f);
   const pending=page.waitForRequest(request=>request.url().includes('/api/member-attendance'));
   await page.locator('[data-action="attendance-tracker-refresh"]').click();await pending;
   const count=f.trackerRequests.length;
   await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
   await page.clock.fastForward(90001);
   assert.equal(f.trackerRequests.length,count,'only one request stays in flight');release();await ready(page);clean(f);
  }finally{release?.();await page.close();}
 });

 test('a successful check-in state refresh immediately updates the tracker and queues one fresh response behind an in-flight read',async()=>{
  const f=fixture(),page=await open(f);let release;
  try {
   await ready(page);let count=f.trackerRequests.length;
   f.events.push({id:'checkin-friday',at:'2026-10-16T02:00:00Z'});
   const immediate=page.waitForResponse(response=>response.url().includes('/api/member-attendance'));
   await page.evaluate(()=>refreshData());await immediate;
   await page.waitForFunction(()=>document.querySelector('.attendance-calendar-day[data-date="2026-10-16"]')?.dataset.status==='attended');
   assert.equal(f.trackerRequests.length,count+1,'state replacement refreshes without waiting for a poll');
   release=gate(f);await page.locator('[data-action="attendance-tracker-refresh"]').click();await f.gate.started;
   count=f.trackerRequests.length;f.events.push({id:'checkin-saturday',at:'2026-10-17T02:00:00Z'});
   await page.evaluate(()=>refreshData());assert.equal(f.trackerRequests.length,count,'the state refresh does not overlap the pending request');
   release();
   await page.waitForFunction(()=>document.querySelector('.attendance-calendar-day[data-date="2026-10-17"]')?.dataset.status==='attended');
   assert.equal(f.trackerRequests.length,count+1,'one queued fresh response replaces the older in-flight snapshot');clean(f);
  }finally{release?.();await page.close();}
 });

 test('an open tracker adopts the server business date after midnight and accepts that newly available date',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await ready(page);assert.equal(await page.locator('#member-attendance-date').getAttribute('max'),'2026-10-17');
   f.today='2026-10-18';
   await page.locator('[data-action="attendance-tracker-refresh"]').click();
   await page.waitForFunction(()=>document.getElementById('member-attendance-date')?.max==='2026-10-18');
   assert.equal(await page.locator('.attendance-calendar-day.is-today[data-date="2026-10-18"]').count(),1);
   assert.equal(await page.locator('.attendance-calendar-day.is-today[data-date="2026-10-17"]').count(),0);
   await page.locator('#member-attendance-date').fill('2026-10-18');
   await page.locator('#member-attendance-form').getByRole('button',{name:'Apply',exact:true}).click();
   await ready(page);assert.equal(f.trackerRequests.at(-1).date,'2026-10-18');
   assert.equal(await page.locator('#member-attendance [role="alert"]').count(),0);clean(f);
  }finally{await page.close();}
 });

 test('failed fetch shows Retry with no invented success and preserves the selected period',async()=>{
  const f=fixture();f.status=502;const page=await open(f);
  try {
   await page.locator('#member-attendance [role="alert"]').filter({hasText:'Attendance service unavailable'}).waitFor();
   assert.equal(await page.locator('#attendance-tracker-summary').count(),0);
   f.status=200;await page.locator('[data-action="attendance-tracker-retry"]').click();await ready(page);
   assert.equal(await page.locator('#member-attendance-period').inputValue(),'week');assert.match(await completed(page),/Consistent/);clean(f);
  }finally{await page.close();}
 });

 test('late account-A data and 401 responses cannot replace account-B tracker or sign B out',async()=>{
  for(const status of [200,401]) {
   const f=fixture();f.status=status;const release=gate(f),page=await open(f);
   try {
    await f.gate.started;
    await page.locator('[aria-label="Log out"]').click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();
    const second=fixture(OTHER);Object.assign(f,{user:second.user,member:second.member,events:[],status:200});
    await page.evaluate(()=>boot());await page.getByRole('link',{name:'Attendance',exact:true}).click();await ready(page);
    assert.match(await completed(page),/Building consistency/);release();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>currentUser.id),OTHER);
    assert.equal(await page.locator('#member-attendance-history tbody tr').count(),0);
    assert.match(await completed(page),/Building consistency/);clean(f);
   }finally{release();await page.close();}
  }
 });

 test('calendar, filters, history and logout fit phones without duplicate panels',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await ready(page);await mkdir('test-results',{recursive:true});
   for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px page`);
    assert.equal(await page.locator('#member-attendance').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.locator('[aria-label="Log out"]').isVisible(),true);
    if(width===390)await page.locator('#member-attendance').screenshot({path:'test-results/member-attendance-phone.png',animations:'disabled'});
   }
   await page.setViewportSize({width:390,height:844});
   await page.locator('#member-attendance-period').selectOption('month');await page.locator('#member-attendance-form').getByRole('button',{name:'Apply',exact:true}).click();
   await page.waitForFunction(()=>document.querySelectorAll('.attendance-calendar-day').length===31);
   assert.equal(await page.locator('#member-attendance').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
   await page.locator('#member-attendance').screenshot({path:'test-results/member-attendance-month-phone.png',animations:'disabled'});
   assert.equal(await page.locator('#member-attendance').count(),1);clean(f);
  }finally{await page.close();}
 });
});
