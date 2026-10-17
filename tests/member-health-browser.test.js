// Real frontend scripts; every API response is isolated and all writes are simulated.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const TODAY = '2026-10-17', MEMBER_ID = '11111111-2222-3333-4444-555555555555';
const blank = () => ({heightCm:null,weightKg:null,ageBand:null,conditions:[]});
function fixture() {
  const plans = [
    {id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']},
    {id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio','mobility','group_classes']},
    {id:'elite',name:'Performance',price_cents:249900,coaching:'personal',coach_sessions:4,focus_tags:['strength','mobility']}
  ].map(p => planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const terms = {...plans[0],features:['Purchased Essential benefit']};
  const member = {id:MEMBER_ID,name:'Existing Member',email:'existing@example.invalid',phone:'09170000001',goal:'Improve fitness',
    survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat'],updatedAt:'2026-10-17T05:00:00Z'},
    enabled:true,photo:'',plan:'basic',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const invoice = {id:'paid-current',memberId:MEMBER_ID,plan:'basic',terms,amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start};
  return {plans,member,invoices:[invoice],health:{heightCm:175,weightKg:70,ageBand:'20plus',conditions:['none'],updatedAt:'2026-10-17T05:00:00Z'},
    user:{id:MEMBER_ID,memberId:MEMBER_ID,role:'member',name:member.name,can:capabilitiesFor('member')},saves:[],mutations:[],unexpected:[],errors:[]};
}
const snapshot = f => ({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],
  registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:false,methods:[],testMode:true},
  ...(f.user.role === 'member' ? {memberHealth:f.health} : {})});

describe('optional private member health details', {concurrency:false}, () => {
  let browser, server, origin;
  before(async () => {
    const env = {};
    server = createDevServer(env);
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    origin = env.APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
  });
  after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });
  async function open(f, {delayModule=false,width=1440}={}) {
    const page = await browser.newPage({viewport:{width,height:1000}});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error => f.errors.push(error.message));
    await page.addInitScript(() => {
      document.addEventListener('repready-ready', () => {
        window.healthAtReady = {renderer:typeof window.memberHealthPanel,sections:document.querySelectorAll('#member-health').length};
      });
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin || path.startsWith('/_vercel/')) return route.fulfill({status:200,body:''});
      if (!path.startsWith('/api/')) {
        if (delayModule && path === '/member-health.js') await new Promise(resolve => setTimeout(resolve,400));
        return route.continue();
      }
      let body;
      if (request.method() !== 'GET') f.mutations.push(path);
      if (path === '/api/plans' && request.method() === 'GET') body = {plans:f.plans};
      else if (path === '/api/session' && request.method() === 'GET') body = {user:f.user,date:TODAY};
      else if (path === '/api/state' && request.method() === 'GET') body = snapshot(f);
      else if (path === '/api/member-health' && request.method() === 'POST') {
        const answers = request.postDataJSON();
        assert.deepEqual(Object.keys(answers).sort(),['ageBand','conditions','heightCm','weightKg']);
        f.saves.push(answers);
        if (f.rejectSave) return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Optional health details could not be saved.'})});
        f.health = {...answers,updatedAt:'2026-10-17T06:00:00Z'};
        body = {memberHealth:f.health};
      } else {
        f.unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected test request'})});
      }
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(origin+(f.user.role === 'member'?'/#/member/members':'/#/admin/members'));
    await page.waitForFunction(() => window.healthAtReady);
    return page;
  }
  const clean = f => { assert.deepEqual(f.errors,[]); assert.deepEqual(f.unexpected,[]); };
  const edit = page => page.getByRole('button',{name:'Edit answers',exact:true}).click();

  test('restored BMI and combined edit preview respect confirmed adult age and fit phones', async () => {
    const f = fixture(), page = await open(f,{delayModule:true});
    try {
      assert.deepEqual(await page.evaluate(() => window.healthAtReady),{renderer:'function',sections:1});
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 22\.9/);
      assert.equal(await page.locator('.health-bmi-category').isVisible(),true);
      assert.match(await page.locator('.health-privacy').innerText(),/not shown on gym staff screens/);
      assert.match(await page.locator('#member-health-bmi').innerText(),/not a diagnosis or medical clearance/);
      await edit(page);
      assert.equal(await page.locator('#member-survey-form form,#member-health-form').count(),0);
      assert.equal(await page.locator('#member-health [required]').count(),0);
      await page.locator('#health-weight').fill('80');
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 26\.1/);
      for (const age of ['','under20','prefer_not']) {
        await page.locator('#health-age-band').selectOption(age);
        assert.equal(await page.locator('.health-bmi-category').count(),0);
        assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 26\.1/);
        assert.match(await page.locator('#member-health-bmi').innerText(),/number only/);
      }
      await page.locator('#health-age-band').selectOption('20plus');
      assert.equal(await page.locator('.health-bmi-category').isVisible(),true);
      await mkdir('test-results',{recursive:true});
      await page.locator('#member-health').screenshot({path:'test-results/member-health-desktop.png',animations:'disabled'});
      for (const width of [390,320]) {
        await page.setViewportSize({width,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`${width}px page layout`);
        assert.equal(await page.locator('#member-health').evaluate(panel => panel.scrollWidth <= panel.clientWidth),true,`${width}px panel layout`);
        if (width === 390) await page.locator('#member-health').screenshot({path:'test-results/member-health-phone.png',animations:'disabled'});
      }
      assert.deepEqual(f.mutations,[]);clean(f);
    } finally { await page.close(); }
  });

  test('optional measurement validation and exclusive condition selections work within the combined form', async () => {
    const f = fixture(), page = await open(f);
    try {
      await edit(page);
      for (const value of ['49','251','175.25']) {
        await page.locator('#health-height').fill(value);
        await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
        assert.equal(await page.locator('#member-health-error').isVisible(),true);
      }
      await page.locator('#health-height').fill('175');
      for (const value of ['9','501','70.25']) {
        await page.locator('#health-weight').fill(value);
        await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
        assert.equal(await page.locator('#member-health-error').isVisible(),true);
      }
      assert.deepEqual(f.mutations,[]);
      await page.locator('#health-weight').fill('70');
      await page.locator('#health-heart_condition').check();await page.locator('#health-diabetes').check();
      assert.deepEqual(await page.locator('[name="conditions"]:checked').evaluateAll(inputs => inputs.map(input=>input.value)),['heart_condition','diabetes']);
      await page.locator('#health-prefer_not').check();
      assert.deepEqual(await page.locator('[name="conditions"]:checked').evaluateAll(inputs => inputs.map(input=>input.value)),['prefer_not']);
      await page.locator('#health-injury_limitation').check();
      assert.deepEqual(await page.locator('[name="conditions"]:checked').evaluateAll(inputs => inputs.map(input=>input.value)),['injury_limitation']);
      await page.locator('#health-none').check();
      assert.deepEqual(await page.locator('[name="conditions"]:checked').evaluateAll(inputs => inputs.map(input=>input.value)),['none']);
      assert.deepEqual(f.mutations,[]);clean(f);
    } finally { await page.close(); }
  });

  test('staff roster and profile never contain private health information or a combined editor', async () => {
    const f = fixture();
    f.user = {id:'staff-account',memberId:'staff-account',role:'staff',name:'Staff Member',can:capabilitiesFor('staff')};
    const page = await open(f);
    try {
      assert.equal(await page.locator('#member-health').count(),0);
      assert.equal(await page.evaluate(() => Object.hasOwn(state,'memberHealth')),false);
      await page.locator('[data-action="profile"]').first().click();
      assert.equal(await page.locator('.modal-body').isVisible(),true);
      assert.equal(await page.locator('#member-health,#member-survey-form').count(),0);
      assert.doesNotMatch(await page.locator('.modal-body').innerText(),/BMI|Optional health|175|70 kg|asthma/i);
      assert.equal(await page.evaluate(() => window.memberHealthPanel(state.members[0])), '');
      assert.deepEqual(f.mutations,[]);clean(f);
    } finally { await page.close(); }
  });
});
