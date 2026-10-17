// Dedicated attendance navigation with real assets and completely isolated sessions/API responses.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {after,before,describe,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor,planView} from '../src/state.js';

const TODAY='2026-10-17',MEMBER='11111111-2222-3333-4444-555555555555',OTHER='22222222-3333-4444-5555-666666666666';
function fixture(role='staff') {
 const plans=[{id:'basic',name:'Essential',coaching:'none',coach_sessions:0,price_cents:89900},{id:'plus',name:'Momentum',coaching:'group',coach_sessions:0,price_cents:149900}]
  .map(p=>planView({...p,available:true,days:30,description:'Membership plan',features:['Purchased gym access']}));
 const member={id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:'basic',terms:plans[0],start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01',
  survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:TODAY+'T00:00:00Z'}};
 const second={...member,id:OTHER,name:'Second Member',email:'other@example.invalid',plan:'plus',terms:plans[1]};
 const user={id:role==='member'?MEMBER:role+'-user',memberId:role==='member'?MEMBER:role+'-user',role,name:role==='member'?member.name:'Gym '+role,can:capabilitiesFor(role),workspace:'production'};
 const invoice={id:'INV-EXISTING',memberId:MEMBER,plan:'basic',terms:plans[0],amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start};
 return {role,user,plans,members:role==='member'?[member]:[member,second],invoices:[invoice],requests:[],reads:[],unexpected:[],errors:[],checked:false,
  visits:[{id:'visit1',date:'2026-10-16',time:'09:30',memberId:MEMBER,name:member.name,plan:'Essential',confirmedBy:'Gym staff'},
   {id:'visit2',date:'2026-10-15',time:'10:00',memberId:OTHER,name:second.name,plan:'Momentum',confirmedBy:'Gym staff'}]};
}
const snapshot=f=>({user:f.user,date:TODAY,members:f.members,plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],
 registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},stats:f.role==='member'?undefined:{visitsToday:f.checked?1:0},staff:[],unpaidAccounts:[],memberHealth:null,
 visits:f.role==='member'?{recent:[{date:'2026-10-16',time:'9:30 AM'}],last:{date:'2026-10-16',time:'9:30 AM'},thisMonth:1}:undefined,paymongo:{configured:false,methods:[],testMode:true}});

describe('dedicated Attendance sections',{concurrency:false},()=>{
 let server,browser,origin;
 before(async()=>{const env={};server=createDevServer(env);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});});
 after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
 async function open(f,{section='attendance',width=1440}={}) {
  const page=await browser.newPage({viewport:{width,height:1000},acceptDownloads:true});page.setDefaultTimeout(5000);
  page.on('pageerror',e=>f.errors.push(e.message));
  await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.attendanceNavReady=true;}));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
   if(!path.startsWith('/api/'))return route.continue();
   if(method==='GET')f.reads.push(path+url.search);else f.requests.push({path,body:request.postDataJSON()});
   let body;
   if(method==='GET'&&path==='/api/plans')body={plans:f.plans};
   else if(method==='GET'&&path==='/api/session')body={user:f.user,date:TODAY};
   else if(method==='GET'&&path==='/api/state')body=snapshot(f);
   else if(method==='GET'&&path==='/api/reports/attendance') {
    const rows=structuredClone(f.visits),gate=f.reportGate;
    if(gate)await gate;
    if(f.reportError)return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Attendance could not be loaded.'})});
    const from=url.searchParams.get('from'),to=url.searchParams.get('to'),plan=url.searchParams.get('plan');
    const visits=rows.filter(v=>v.date>=from&&v.date<=to&&(plan==='all'||v.plan===f.plans.find(p=>p.id===plan)?.name));
    const days=(Date.parse(to)-Date.parse(from))/86400000+1;
    body={from,to,plan,visits,totals:{visits:visits.length,uniqueMembers:new Set(visits.map(v=>v.memberId)).size,days,dailyAverage:Math.round(visits.length/days*10)/10},truncated:false};
   }else if(method==='POST'&&path==='/api/logout'){f.user=null;body={ok:true};}
   else if(method==='POST'&&path==='/api/scan') {
    assert.deepEqual(request.postDataJSON(),{code:'7kq2 m9xd'});
    body={member:f.members[0],token:'FORM2.valid-isolated-pass',alreadyCheckedInAt:f.checked?TODAY+'T02:00:00Z':null};
   }else if(method==='POST'&&path==='/api/check-in') {
    assert.deepEqual(request.postDataJSON(),{token:'FORM2.valid-isolated-pass',confirmed:true});
    f.checked=true;f.visits.unshift({id:'new-visit',date:TODAY,time:'10:00',memberId:MEMBER,name:'Existing Member',plan:'Essential',confirmedBy:'Gym staff'});body={ok:true};
   }else {f.unexpected.push(`${method} ${path}`);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected isolated request'})});}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${origin}/#/${f.role==='member'?'member':'admin'}/${section}`);await page.waitForFunction(()=>window.attendanceNavReady);return page;
 }
 const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);};
 const reportReady=page=>page.locator('.attendance-panel .stats-grid.three').waitFor();

 test('admin and staff reach Attendance directly and on reload while Members & plans retains only its own tabs',async()=>{
  for(const role of ['admin','staff']) {
   const f=fixture(role),page=await open(f);
   try {
    await reportReady(page);assert.equal(await page.locator('a.nav-link[href="#/admin/attendance"]').count(),1);
    assert.equal(await page.locator('a.nav-link[aria-current="page"]').innerText(),'Attendance');
    assert.equal(await page.locator('.breadcrumb b').innerText(),'Attendance');
    assert.equal(await page.locator('.attendance-page').count(),1);
    assert.equal(await page.locator('.attendance-page [data-action="scanner"]').isVisible(),true);
    await page.evaluate(()=>navigate('members'));assert.equal(await page.locator('[data-tab="attendance"],.attendance-panel').count(),0);
    assert.equal(await page.locator('[data-action="register"]').first().isVisible(),true);
    await page.getByRole('link',{name:'Attendance',exact:true}).click();await reportReady(page);
    await page.reload();await page.waitForFunction(()=>window.attendanceNavReady);await reportReady(page);
    assert.equal(await page.locator('.attendance-page').count(),1);clean(f);
   }finally{await page.close();}
  }
 });

 test('staff keeps date/plan filtering, member search and the filtered CSV export',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await reportReady(page);assert.equal(await page.locator('.attendance-panel tbody tr').count(),2);
   await page.locator('#attendance-search').fill('second');assert.equal(await page.locator('.attendance-panel tbody tr').count(),1);
   assert.match(await page.locator('.attendance-panel tbody').innerText(),/Second Member/);
   const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();
   const download=await downloading,text=await readFile(await download.path(),'utf8');
   assert.equal(download.suggestedFilename(),'RepReady-attendance-2026-10-11-to-2026-10-17.csv');
   assert.match(text,/Second Member/);assert.doesNotMatch(text,/Existing Member/);
   await page.locator('#attendance-search').fill('');await page.locator('#attendance-plan').selectOption('basic');await page.getByRole('button',{name:'Apply',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.attendance-panel tbody')?.textContent.includes('Existing Member')&&!document.querySelector('.attendance-panel tbody')?.textContent.includes('Second Member'));
   assert.ok(f.reads.some(p=>p.endsWith('plan=basic')));
   await page.locator('#attendance-search').fill(MEMBER);assert.equal(await page.locator('.attendance-panel tbody tr').count(),1);
   assert.deepEqual(f.requests,[]);clean(f);
  }finally{await page.close();}
 });

 test('typed pass verification and identity confirmation retain the existing check-in workflow and refresh the report immediately',async()=>{
  const f=fixture(),page=await open(f);
  try {
   await reportReady(page);await page.locator('.attendance-page [data-action="scanner"]').click();
   await page.locator('.scan-alternatives summary').click();await page.locator('#scan-text').fill('7kq2 m9xd');await page.getByRole('button',{name:'Verify pass',exact:true}).click();
   await page.locator('#identity-confirmed').waitFor();assert.equal(await page.locator('#identity-confirmed').isChecked(),false);
   assert.equal(await page.locator('#checkin-form [required]').count(),1);
   await page.locator('#identity-confirmed').check();await page.getByRole('button',{name:'Confirm check-in',exact:true}).click();
   await page.locator('#toast').filter({hasText:'Check-in confirmed'}).waitFor();await reportReady(page);
   await page.waitForFunction(()=>document.querySelectorAll('.attendance-panel tbody tr').length===3);
   assert.deepEqual(f.requests.map(r=>r.path),['/api/scan','/api/check-in']);
   assert.match(await page.locator('.attendance-panel tbody tr').first().innerText(),/Existing Member/);clean(f);
  }finally{await page.close();}
 });

 test('members have their own separate history, retain the pass action and receive no staff report or other member data',async()=>{
  const f=fixture('member'),page=await open(f);
  try {
   assert.equal(await page.locator('a.nav-link[href="#/member/attendance"]').count(),1);
   assert.equal(await page.locator('.attendance-page .my-visits').count(),1);
   assert.match(await page.locator('.my-visits').innerText(),/This month: 1 visit/);
   assert.match(await page.locator('.my-visits').innerText(),/9:30 AM/);
   assert.doesNotMatch(await page.locator('.attendance-page').innerText(),/Second Member|Gym staff/);
   assert.equal(await page.locator('.attendance-page [data-action="member-qr"]').count(),1);
   assert.equal(await page.locator('[data-action="scanner"],#attendance-form').count(),0);
   await page.evaluate(()=>navigate('members'));assert.equal(await page.locator('.my-visits,.attendance-panel').count(),0);
   await page.evaluate(()=>navigate('overview'));assert.equal(await page.locator('.my-visits').count(),0);
   await page.locator('.member-attendance-link a').click();await page.locator('.my-visits').waitFor();assert.equal(await page.locator('.my-visits').count(),1);
   assert.equal(f.reads.some(p=>p.startsWith('/api/reports/attendance')),false);
   assert.deepEqual(f.requests,[]);clean(f);
  }finally{await page.close();}
 });

 test('failed report has a retry state and repeated loads do not overlap',async()=>{
  const f=fixture();f.reportError=true;const page=await open(f);
  try {
   await page.locator('.attendance-panel [role="alert"]').filter({hasText:'Attendance could not be loaded'}).waitFor();
   assert.equal(await page.locator('.attendance-panel .stat-value').count(),0);
   let release;f.reportGate=new Promise(resolve=>{release=resolve;});f.reportError=false;
   await page.locator('[data-action="attendance-retry"]').click();
   await page.evaluate(()=>{loadAttendance();loadAttendance();});
   const count=f.reads.filter(p=>p.startsWith('/api/reports/attendance')).length;
   assert.equal(count,2,'only the first failed request and one retry');release();await reportReady(page);
   assert.equal(await page.locator('.attendance-panel tbody tr').count(),2);clean(f);
  }finally{await page.close();}
 });

 test('Attendance does not grant a pass to unpaid, expired or inactive members',async()=>{
  for(const scenario of ['unpaid','expired','inactive']) {
   const f=fixture('member');
   if(scenario==='unpaid')f.invoices[0].paidCents=0;
   if(scenario==='expired'){f.members[0].end='2026-10-16';f.invoices[0].end='2026-10-16';}
   if(scenario==='inactive')f.members[0].enabled=false;
   const page=await open(f);
   try {
    assert.equal(await page.locator('.attendance-page .my-visits').count(),1);
    assert.equal(await page.locator('.attendance-page [data-action="member-qr"]:enabled').count(),0,scenario);
    await page.evaluate(()=>memberQR());
    await page.locator('#modal-title').filter({hasText:'Your member pass'}).waitFor();
    assert.match(await page.locator('.modal-body').innerText(),/membership|payment|gym/i);
    assert.equal(f.reads.some(p=>p==='/api/qr'),false);
    assert.deepEqual(f.requests,[]);clean(f);
   }finally{await page.close();}
  }
 });

 test('late staff report responses are discarded after logout and member sign-in',async()=>{
  const f=fixture();let release;f.reportGate=new Promise(resolve=>{release=resolve;});const page=await open(f);
  try {
   await page.locator('[aria-label="Log out"]').click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();
   const member=fixture('member');Object.assign(f,{role:member.role,user:member.user,members:member.members});
   await page.evaluate(()=>boot());await page.getByRole('link',{name:'Attendance',exact:true}).click();
   release();await page.waitForFunction(()=>currentUser?.role==='member'&&section==='attendance');
   assert.equal(await page.locator('.attendance-panel').count(),0);
   assert.equal(await page.locator('.my-visits').count(),1);
   assert.doesNotMatch(await page.locator('.attendance-page').innerText(),/Second Member/);
   assert.equal(await page.evaluate(()=>currentUser.role),'member');clean(f);
  }finally{release();await page.close();}
 });

 test('dedicated attendance and normal header/logout fit desktop and phone layouts for every role',async()=>{
  for(const role of ['admin','staff','member']) {
   const f=fixture(role),page=await open(f);
   try {
    if(role!=='member')await reportReady(page);
    await mkdir('test-results',{recursive:true});
    for(const width of [1440,390,320]) {
     await page.setViewportSize({width,height:844});
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${role} ${width}px page`);
     assert.equal(await page.locator('.topbar').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
     assert.equal(await page.locator('[aria-label="Log out"]').isVisible(),true);
     if(width===390)await page.locator('.attendance-page').screenshot({path:`test-results/attendance-navigation-${role}-phone.png`,animations:'disabled'});
    }
    await page.locator('[aria-label="Log out"]').click();await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();clean(f);
   }finally{await page.close();}
  }
 });
});
