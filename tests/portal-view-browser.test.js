// Real portal scripts with isolated sessions/state. No live account, database or payment writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const TODAY = '2026-10-17';
const MEMBER = '11111111-2222-3333-4444-555555555555';
const OTHER = '22222222-3333-4444-5555-666666666666';

function fixture(role) {
  const plans = [{id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']}]
    .map(p=>planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const terms = {...plans[0],features:['Purchased Essential benefit']};
  const member = {id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',
    survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:TODAY+'T00:00:00Z'},
    enabled:true,photo:'',plan:'basic',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const second = {...member,id:OTHER,name:'Second Member',email:'second@example.invalid'};
  const invoice = {id:'INV-EXISTING-001',memberId:MEMBER,plan:'basic',terms,amount:899,amountCents:89900,paidCents:role==='member'?89900:25000,
    start:member.start,end:member.end,due:member.start,created:member.start};
  const user = {id:role==='member'?MEMBER:role+'-user',memberId:role==='member'?MEMBER:role+'-user',role,
    name:role==='member'?member.name:'Gym '+role,can:capabilitiesFor(role)};
  return {role,user,plans,members:role==='member'?[member]:[member,second],
    invoices:role==='member'?[invoice]:[invoice,{...invoice,id:'INV-SECOND-002',memberId:OTHER,paidCents:89900}],
    requests:[],reads:[],unexpected:[],errors:[]};
}

function snapshot(f) {
  return {user:f.user,date:TODAY,members:f.members,plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],
    activity:[],registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},stats:f.role==='member'?undefined:{visitsToday:1},
    staff:[],unpaidAccounts:[],memberHealth:null,visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:true,methods:['gcash','card'],testMode:true}};
}

describe('administrator-only portal view switching', {concurrency:false}, () => {
  let server, origin, browser;
  before(async()=>{
    const env={}; server=createDevServer(env);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    origin=env.APP_ORIGIN=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
  });
  after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

  async function open(f, {section='overview',width=1440,view=f.role==='member'?'member':'admin'}={}) {
    const page=await browser.newPage({viewport:{width,height:1000}});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>f.errors.push(error.message));
    await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.portalTestReady=true;}));
    await page.route('**/*',async route=>{
      const request=route.request(), url=new URL(request.url()), path=url.pathname, method=request.method();
      if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
      if(!path.startsWith('/api/'))return route.continue();
      if(method==='GET')f.reads.push(path);else f.requests.push({path,body:request.postDataJSON()});
      let body;
      if(method==='GET'&&path==='/api/plans')body={plans:f.plans};
      else if(method==='GET'&&path==='/api/session')body={user:f.user,date:TODAY};
      else if(method==='GET'&&path==='/api/state')body=snapshot(f);
      else if(method==='GET'&&path==='/api/reports/attendance')body={from:'2026-10-11',to:TODAY,
        totals:{visits:1,uniqueMembers:1,days:7,dailyAverage:1/7},truncated:false,
        visits:[{date:TODAY,time:'09:30',memberId:MEMBER,name:'Existing Member',plan:'Essential',confirmedBy:'Gym staff'}]};
      else if(method==='POST'&&path==='/api/logout'){f.user=null;body={ok:true};}
      else {f.unexpected.push(`${method} ${path}`);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected isolated request'})});}
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(`${origin}/#/${view}/${section}`);
    await page.waitForFunction(()=>window.portalTestReady);
    return page;
  }

  function clean(f) {assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);}
  async function noPreviewControls(page) {
    assert.equal(await page.locator('.mode-switch,[data-action="mode"],[data-action="preview-member"]').count(),0);
  }
  async function stateAt(page) {return page.evaluate(()=>({mode,selectedMember,section,role:currentUser.role}));}
  async function staleClick(page,action,extra={}) {
    await page.evaluate(({action,extra})=>{
      const el=document.createElement('button');el.dataset.action=action;
      Object.assign(el.dataset,extra);document.body.append(el);el.click();el.remove();
    },{action,extra});
  }
  async function fitHeader(page,width) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.locator('[aria-label="Log out"]').isVisible(),true);
    assert.equal(await page.locator('.topbar').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`header fits ${width}px`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`page fits ${width}px`);
  }

  test('admin keeps header switching and profile preview, with a return to the operational workspace',async()=>{
    const f=fixture('admin'),page=await open(f);
    try {
      assert.equal(await page.locator('.mode-switch').count(),1);
      await page.locator('[data-action="mode"][data-mode="member"]').click();
      assert.equal((await stateAt(page)).mode,'member');
      assert.equal(await page.locator('.breadcrumb b').innerText(),'My overview');
      assert.equal(await page.locator('.member-selector').count(),1,'administrator can choose a preview member');
      assert.equal((await stateAt(page)).role,'admin','view does not change authenticated permissions');
      await page.locator('[data-action="mode"][data-mode="admin"]').click();
      assert.equal((await stateAt(page)).mode,'admin');
      assert.equal(await page.locator('.breadcrumb b').innerText(),'Overview');
      await page.evaluate(()=>profile('22222222-3333-4444-5555-666666666666'));
      await page.locator('[data-action="preview-member"]').click();
      assert.deepEqual(await stateAt(page),{mode:'member',selectedMember:OTHER,section:'overview',role:'admin'});
      await page.locator('[data-action="mode"][data-mode="admin"]').click();
      assert.equal((await stateAt(page)).mode,'admin');
      assert.deepEqual(f.requests,[]);clean(f);
    } finally {await page.close();}
  });

  test('staff has no switcher after restored load, operational navigation, reload and phone navigation',async()=>{
    const f=fixture('staff'),page=await open(f);
    try {
      await noPreviewControls(page);
      assert.equal((await stateAt(page)).mode,'admin','admin mode remains the normal staff workspace');
      assert.match(await page.locator('.account').innerText(),/Gym staff[\s\S]*Staff workspace/);
      assert.equal(await page.locator('[data-action="scanner"]').isVisible(),true);
      assert.match(await page.locator('[aria-label="Gym statistics"]').innerText(),/Visits today/);
      await page.evaluate(()=>navigate('members'));
      await noPreviewControls(page);
      assert.equal(await page.locator('[data-action="register"]').first().isVisible(),true);
      await page.getByRole('link',{name:'Attendance',exact:true}).click();
      await page.locator('.attendance-panel td').filter({hasText:'Existing Member'}).waitFor();
      assert.ok(f.reads.includes('/api/reports/attendance'));
      await noPreviewControls(page);
      await page.evaluate(()=>profile('11111111-2222-3333-4444-555555555555'));
      assert.equal(await page.locator('[data-action="preview-member"]').count(),0);
      assert.equal(await page.locator('[data-action="renew-member"]').count(),1,'legitimate staff renewal stays available');
      await page.getByRole('button',{name:'Close dialog',exact:true}).click();
      await page.evaluate(()=>navigate('payments'));
      await noPreviewControls(page);
      await page.locator('[data-action="pay"][data-id="INV-EXISTING-001"]').click();
      assert.equal(await page.locator('#modal-title').innerText(),'Record a confirmed payment');
      assert.equal(await page.locator('#method').inputValue(),'Cash');
      await page.getByRole('button',{name:'Close dialog',exact:true}).click();
      await page.reload();await page.waitForFunction(()=>window.portalTestReady);
      await noPreviewControls(page);assert.equal((await stateAt(page)).mode,'admin');
      await page.evaluate(()=>navigate('overview'));
      for(const width of [1440,390,320]){
        await fitHeader(page,width);await noPreviewControls(page);
        if(width===1440||width===390){
          await mkdir('test-results',{recursive:true});
          await page.locator('.topbar').screenshot({path:`test-results/portal-staff-header-${width}.png`});
        }
        if(width<680){
          await page.getByRole('button',{name:'Open navigation',exact:true}).click();
          assert.equal(await page.locator('.sidebar').evaluate(el=>el.classList.contains('open')),true);
          await page.locator('.sidebar a.nav-link').filter({hasText:'Members & plans'}).click();
          assert.equal((await stateAt(page)).section,'members');
          assert.equal((await stateAt(page)).mode,'admin');
          await page.keyboard.press('Escape');await noPreviewControls(page);
          await page.evaluate(()=>navigate('overview'));
        }
      }
      assert.deepEqual(f.requests,[]);clean(f);
    } finally {await page.close();}
  });

  test('staff cannot activate a stale mode/profile action or direct switching function, including member hash and stale displayed mode',async()=>{
    const f=fixture('staff'),page=await open(f,{view:'member'});
    try {
      assert.equal((await stateAt(page)).mode,'admin');await noPreviewControls(page);
      const before=await stateAt(page);
      await staleClick(page,'mode',{mode:'member'});
      assert.deepEqual(await stateAt(page),before);
      await staleClick(page,'preview-member',{id:OTHER});
      assert.deepEqual(await stateAt(page),before);
      assert.equal(await page.evaluate(()=>switchPortalView('member','22222222-3333-4444-5555-666666666666')),false);
      assert.deepEqual(await stateAt(page),before);
      await page.evaluate(()=>{mode='member';render();});
      assert.equal((await stateAt(page)).mode,'admin','render normalizes stale non-admin mode');
      await page.evaluate(()=>{location.hash='#/member/members';});
      await page.waitForFunction(()=>section==='members');
      assert.equal((await stateAt(page)).mode,'admin');await noPreviewControls(page);
      assert.equal(await page.locator('[data-action="scanner"]').isVisible(),true);
      assert.deepEqual(f.requests,[]);clean(f);
    } finally {await page.close();}
  });

  test('members retain only their own experience and cannot invoke administrator switching',async()=>{
    const f=fixture('member'),page=await open(f,{view:'admin'});
    try {
      await noPreviewControls(page);
      assert.deepEqual(await stateAt(page),{mode:'member',selectedMember:MEMBER,section:'overview',role:'member'});
      assert.equal(await page.locator('.member-selector').count(),0);
      assert.equal(await page.locator('[data-action="scanner"],[data-action="register"]').count(),0);
      assert.equal(await page.locator('[data-action="member-qr"]').isVisible(),true);
      await staleClick(page,'mode',{mode:'admin'});
      await staleClick(page,'preview-member',{id:OTHER});
      assert.equal(await page.evaluate(()=>switchPortalView('admin')),false);
      assert.equal(await page.evaluate(()=>switchPortalView('member','22222222-3333-4444-5555-666666666666')),false);
      assert.deepEqual(await stateAt(page),{mode:'member',selectedMember:MEMBER,section:'overview',role:'member'});
      await page.evaluate(()=>navigate('members'));
      assert.match(await page.locator('.membership-privileges').innerText(),/Purchased Essential benefit/);
      await noPreviewControls(page);
      await page.reload();await page.waitForFunction(()=>window.portalTestReady);
      await noPreviewControls(page);assert.equal((await stateAt(page)).selectedMember,MEMBER);
      await page.evaluate(()=>navigate('overview'));
      for(const width of [1440,390,320])await fitHeader(page,width);
      assert.deepEqual(f.requests,[]);clean(f);
    } finally {await page.close();}
  });

  test('password/account controls and logout remain usable for every role, including phone headers',async()=>{
    for(const role of ['admin','staff','member']){
      const f=fixture(role),page=await open(f,{width:390});
      try {
        await fitHeader(page,390);
        if(role!=='admin'){
          await page.locator('.top-actions [data-action="password"]').click();
          assert.equal(await page.locator('#modal-title').innerText(),'Change your password');
          await page.getByRole('button',{name:'Cancel',exact:true}).click();
        } else assert.equal(await page.locator('.top-actions [data-action="settings"]').isVisible(),true);
        await page.getByRole('button',{name:'Open navigation',exact:true}).click();
        assert.equal(await page.locator('.account').isVisible(),true);
        await page.keyboard.press('Escape');
        await page.getByRole('button',{name:'Log out',exact:true}).click();
        await page.locator('#login-form').waitFor();
        assert.deepEqual(f.requests,[{path:'/api/logout',body:{}}]);
        assert.equal(await page.locator('.mode-switch').count(),0);clean(f);
      } finally {await page.close();}
    }
  });
});
