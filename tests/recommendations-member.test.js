// Task 12B: an existing paid member opens My membership with answers already saved.
// Uses the real page and scripts with isolated API responses; no database or account writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

test('paid Momentum member sees Performance on initial My membership load and after saving the survey', async () => {
  const catalog = [
    {id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']},
    {id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio','mobility','group_classes']},
    {id:'elite',name:'Performance',price_cents:249900,coaching:'personal',coach_sessions:4,focus_tags:['strength','mobility']}
  ].map(p => planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const answers = {goal:'Improve fitness',experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat']};
  const terms = {...catalog[1],features:['Purchased Momentum benefit']};
  const member = {id:'11111111-2222-3333-4444-555555555555',name:'Existing Member',email:'existing@example.invalid',phone:'09170000001',
    goal:answers.goal,survey:{experience:answers.experience,exercises:answers.exercises,availableDays:answers.availableDays,updatedAt:'2026-10-17T05:00:00Z'},
    enabled:true,photo:'',plan:'plus',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const invoice = {id:'paid-invoice',memberId:member.id,plan:'plus',terms,amount:1499,amountCents:149900,paidCents:149900,start:member.start,end:member.end,due:member.start,created:member.start};
  const user = {id:member.id,memberId:member.id,role:'member',name:member.name,can:capabilitiesFor('member')};
  const snapshot = () => ({user,date:'2026-10-17',members:[member],plans:catalog,invoices:[invoice],memberships:[],payments:[],submissions:[],checkins:[],activity:[],
    registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:false,methods:[],testMode:true}});
  const purchasedBefore = JSON.stringify({terms,invoice});
  let saves = 0;
  const mutations = [], errors = [];
  const env = {}, server = createDevServer(env);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = env.APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error => errors.push(error.message));
    await page.addInitScript(() => {
      document.addEventListener('repready-ready', () => {
        window.recommendationAtReady = {
          scorer:typeof window.planRecommender?.recommendPlans,
          cards:document.querySelectorAll('.plan-card.recommended-plan').length
        };
      });
    });
    // A restored member session can finish loading before the deferred scorer module.
    await page.route('**/plan-recommender.js', async route => {
      await new Promise(resolve => setTimeout(resolve,500));
      await route.continue();
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      let body;
      if (request.method() === 'POST') mutations.push(path);
      if (path === '/api/plans') body = {plans:catalog};
      else if (path === '/api/session') body = {user,date:'2026-10-17'};
      else if (path === '/api/state') body = snapshot();
      else if (path === '/api/member-survey' && request.method() === 'POST') {
        assert.deepEqual(request.postDataJSON(),answers);
        saves++;
        member.survey = {...member.survey,updatedAt:'2026-10-17T06:00:00Z'};
        body = {goal:answers.goal,survey:member.survey};
      } else throw Error(`Unexpected API request: ${request.method()} ${path}`);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(origin+'/#/member/members');
    await page.locator('.plans-grid').waitFor();
    const assertRecommendation = async () => {
      const card = page.locator('.plan-card.recommended-plan');
      assert.equal(await card.count(),1);
      assert.equal(await card.locator('h2').innerText(),'Performance');
      assert.equal(await card.locator('.tag.recommended').innerText(),'Recommended for you');
      assert.equal(await card.locator('.tag.recommended').isVisible(),true);
      const explanation = page.locator('.plan-recommendation');
      assert.equal(await explanation.isVisible(),true);
      assert.match(await explanation.innerText(),/Performance/);
      assert.deepEqual(await explanation.locator('li').allInnerTexts(),[
        'You’re new to training, and this plan includes a personal coach.',
        'It matches your interest in strength training.'
      ]);
      assert.deepEqual((await page.locator('[data-action="select-plan"]').allInnerTexts()).map(s=>s.trim()).sort(),
        ['Renew Momentum','Switch to Essential next cycle','Switch to Performance next cycle'].sort());
      assert.match(await page.locator('.membership-privileges').innerText(),/Purchased Momentum benefit/);
      assert.match(await page.locator('.membership-card h2').innerText(),/Momentum membership/);
    };
    assert.deepEqual(await page.evaluate(() => window.recommendationAtReady),{scorer:'function',cards:1});
    await assertRecommendation();
    await page.getByRole('button',{name:'Edit answers',exact:true}).click();
    await page.getByRole('button',{name:'Save my answers',exact:true}).click();
    await page.locator('#survey-status').filter({hasText:'Your answers are saved.'}).waitFor();
    await assertRecommendation();
    await page.setViewportSize({width:390,height:844});
    await page.reload();
    await page.locator('.plans-grid').waitFor();
    await assertRecommendation();
    assert.equal(saves,1);
    assert.deepEqual(mutations,['/api/member-survey']);
    assert.equal(JSON.stringify({terms,invoice}),purchasedBefore);
    assert.deepEqual(await page.evaluate(() => state.invoices),[invoice]);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
