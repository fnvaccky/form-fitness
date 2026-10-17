// The real member screen with isolated responses: no accounts, payments or hosted writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const TODAY = '2026-10-17';
const MEMBER_ID = '11111111-2222-3333-4444-555555555555';
const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
const DAY_LABELS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const NOTE = 'An optional sample week based on your survey answers. Adjust it to your comfort and ask gym staff for help with unfamiliar exercises.';

function fixture() {
  const plans = [
    {id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']},
    {id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio','mobility','group_classes']},
    {id:'elite',name:'Performance',price_cents:249900,coaching:'personal',coach_sessions:4,focus_tags:['strength','mobility']}
  ].map(p => planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const terms = {...plans[0],features:['Purchased Essential benefit']};
  const member = {id:MEMBER_ID,name:'Existing Member',email:'existing@example.invalid',phone:'09170000001',
    goal:'Improve fitness',survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat'],updatedAt:'2026-10-17T05:00:00Z'},
    enabled:true,photo:'',plan:'basic',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const invoice = {id:'paid-current',memberId:MEMBER_ID,plan:'basic',terms,amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start};
  return {plans,member,invoices:[invoice],user:{id:MEMBER_ID,memberId:MEMBER_ID,role:'member',name:member.name,can:capabilitiesFor('member')},saves:[],mutations:[],unexpected:[],errors:[]};
}

const snapshot = f => ({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],
  registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:false,methods:[],testMode:true}});

describe('optional sample training on My membership', {concurrency:false}, () => {
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
        window.sampleAtReady = {renderer:typeof window.sampleTrainingPanel,sections:document.querySelectorAll('#sample-training').length};
      });
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin || path.startsWith('/_vercel/')) return route.fulfill({status:200,body:''});
      if (!path.startsWith('/api/')) {
        if (delayModule && path === '/sample-training.js') await new Promise(resolve => setTimeout(resolve,400));
        return route.continue();
      }
      let body;
      if (request.method() !== 'GET') f.mutations.push(path);
      if (path === '/api/plans' && request.method() === 'GET') body = {plans:f.plans};
      else if (path === '/api/session' && request.method() === 'GET') body = {user:f.user,date:TODAY};
      else if (path === '/api/state' && request.method() === 'GET') body = snapshot(f);
      else if (path === '/api/member-survey' && request.method() === 'POST') {
        const answers = request.postDataJSON();
        f.saves.push(answers);
        f.member.goal = answers.goal;
        f.member.survey = {experience:answers.experience,exercises:answers.exercises,availableDays:answers.availableDays,updatedAt:'2026-10-17T06:00:00Z'};
        body = {goal:f.member.goal,survey:f.member.survey};
      } else {
        f.unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected test request'})});
      }
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(origin+'/#/member/members');
    await page.waitForFunction(() => window.sampleAtReady);
    return page;
  }

  function clean(f) {
    assert.deepEqual(f.errors,[],'no browser JavaScript exceptions');
    assert.deepEqual(f.unexpected,[],'all API responses are isolated and expected');
  }

  async function assertWeek(page, availableDays) {
    const section = page.locator('#sample-training');
    assert.equal(await section.count(),1);
    assert.equal(await section.isVisible(),true);
    assert.equal(await section.locator('h2').innerText(),'Suggested training — sample week');
    assert.ok((await section.innerText()).includes(NOTE));
    const days = section.locator('.sample-week-day');
    assert.equal(await days.count(),7);
    const output = await days.evaluateAll(cards => cards.map(card => ({day:card.dataset.day,text:card.innerText,training:card.classList.contains('training'),recovery:card.classList.contains('recovery'),rest:card.classList.contains('rest')})));
    assert.deepEqual(output.map(day => day.day),DAYS);
    output.forEach((day,index) => {
      assert.ok(day.text.includes(DAY_LABELS[index]));
      assert.equal(Number(day.training)+Number(day.recovery)+Number(day.rest),1);
      if (!availableDays.includes(day.day)) assert.equal(day.training,false,`${day.day} is unavailable`);
      assert.doesNotMatch(day.text,/missed|overdue|incomplete workout/i);
      if (day.training) {
        assert.match(day.text,/\b(min|minutes)\b/i,'approximate session length');
        assert.match(day.text,/warm.up/i);
        assert.match(day.text,/cool.down/i);
      }
    });
    assert.ok(output.some(day => day.training),'at least one selected training day');
    assert.ok(output.some(day => day.recovery),'available non-workout day offers light recovery');
    assert.ok(output.some(day => day.rest),'rest is explicitly present');
    for (const card of await section.locator('.sample-week-day.training').all()) {
      const exercises = card.locator('.sample-exercises li');
      assert.ok(await exercises.count(),'exercise names, doses and instructions are visible');
      for (const exercise of await exercises.all()) {
        assert.ok((await exercise.locator('strong').innerText()).length > 3);
        assert.match(await exercise.locator('.sample-exercise-dose').innerText(),/sets?|repetitions|minutes/i);
        assert.ok((await exercise.locator('p').innerText()).length > 20);
      }
    }
    assert.ok(await section.locator('.sample-training-fit').count(),'explains the fit');
    return output;
  }

  async function reload(page) {
    await page.reload();
    await page.waitForFunction(() => window.sampleAtReady);
  }

  test('restored paid no-coach member sees one week, saves new answers immediately, and keeps recommendation and purchased controls on phones', async () => {
    const f = fixture(), original = JSON.stringify({terms:f.member.terms,invoices:f.invoices});
    const page = await open(f,{delayModule:true});
    try {
      assert.deepEqual(await page.evaluate(() => window.sampleAtReady),{renderer:'function',sections:1});
      await assertWeek(page,f.member.survey.availableDays);
      await mkdir('test-results',{recursive:true});
      await page.locator('#sample-training').screenshot({path:'test-results/sample-training-desktop.png'});
      assert.equal(await page.locator('.plan-card.recommended-plan h2').innerText(),'Performance');
      assert.equal(await page.locator('.plan-card.recommended-plan .tag.recommended').innerText(),'Recommended for you');
      assert.match(await page.locator('.plan-recommendation').innerText(),/personal coach/);
      const initialText = await page.locator('#sample-training').innerText();
      await page.getByRole('button',{name:'Edit answers',exact:true}).click();
      assert.equal(await page.locator('#sample-training').count(),1);
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await page.locator('#sample-training').innerText(),initialText);
      await page.getByRole('button',{name:'Edit answers',exact:true}).click();
      await page.locator('#survey-goal').selectOption('Stay consistent');
      await page.locator('#survey-experience').selectOption('returning');
      await page.locator('#survey-strength').uncheck();
      await page.locator('#survey-mobility').check();
      for (const day of DAYS) await page.locator(`#survey-${day}`).setChecked(['tue','thu','sun'].includes(day));
      await page.getByRole('button',{name:'Save my answers',exact:true}).click();
      await page.locator('#survey-status').filter({hasText:'Your answers are saved.'}).waitFor();
      assert.equal(f.saves.length,1);
      assert.deepEqual(f.saves[0],{goal:'Stay consistent',experience:'returning',exercises:['mobility'],availableDays:['tue','thu','sun']});
      await assertWeek(page,['tue','thu','sun']);
      assert.notEqual(await page.locator('#sample-training').innerText(),initialText,'saved goal, familiarity, preferences and days update the week without refresh');
      assert.match(await page.locator('#sample-training').innerText(),/return|back|gradual/i);
      assert.match(await page.locator('#sample-training').innerText(),/mobility|stretch/i);
      assert.match(await page.locator('.membership-privileges').innerText(),/Purchased Essential benefit/);
      assert.equal(await page.locator('.membership-card h2').innerText(),'Essential membership');
      assert.equal(await page.locator('.membership-card .badge').innerText(),'Active');
      assert.deepEqual((await page.locator('[data-action="select-plan"]').allInnerTexts()).map(s=>s.trim()).sort(),
        ['Renew Essential','Switch to Momentum next cycle','Switch to Performance next cycle'].sort());
      for (const width of [390,320]) {
        await page.setViewportSize({width,height:844});
        await reload(page);
        await assertWeek(page,['tue','thu','sun']);
        if (width === 390) await page.locator('#sample-training').screenshot({path:'test-results/sample-training-phone.png'});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`no page overflow at ${width}px`);
        assert.equal(await page.locator('#sample-training').evaluate(section => section.scrollWidth <= section.clientWidth),true,`no section overflow at ${width}px`);
      }
      assert.deepEqual(await page.evaluate(() => state.invoices),f.invoices);
      assert.equal(JSON.stringify({terms:f.member.terms,invoices:f.invoices}),original,'purchased benefits and invoice data stay unchanged');
      assert.deepEqual(f.mutations,['/api/member-survey']);
      clean(f);
    } finally { await page.close(); }
  });

  test('frozen no-coach terms survive catalog rename/coaching edits and an upcoming coached membership', async () => {
    const f = fixture();
    Object.assign(f.plans[0],{name:'Renamed coaching offer',coaching:'personal',coachSessions:8,coachingLabel:'8 personal coaching sessions'});
    f.invoices.push({...f.invoices[0],id:'paid-upcoming',plan:'elite',terms:{...f.plans[2]},amount:2499,amountCents:249900,paidCents:249900,start:'2026-10-31',end:'2026-11-29'});
    const page = await open(f);
    try {
      await assertWeek(page,f.member.survey.availableDays);
      assert.match(await page.locator('.membership-privileges').innerText(),/Purchased Essential benefit/);
      // Editing only the current purchase changes eligibility; the future no-coach purchase cannot grant it early.
      f.invoices[0].terms = {...f.plans[1]};
      f.member.terms = f.invoices[0].terms;
      f.invoices[1].terms = {...fixture().plans[0]};
      await reload(page);
      assert.equal(await page.locator('#sample-training').count(),0);
      // An unpaid next cycle also leaves the current no-coach sample in place, without selection buttons.
      f.invoices[0].terms = {...fixture().plans[0]};
      f.member.terms = f.invoices[0].terms;
      f.invoices[1].paidCents = 0;
      await reload(page);
      await assertWeek(page,f.member.survey.availableDays);
      assert.equal(await page.locator('.next-cycle-note.waiting').count(),1);
      assert.equal(await page.locator('.next-cycle-note.waiting [data-action="pay"]').count(),1);
      assert.equal(await page.locator('[data-action="select-plan"]').count(),0);
      assert.deepEqual(f.mutations,[]);
      clean(f);
    } finally { await page.close(); }
  });

  test('group/personal coaching and unclear purchased coaching terms never receive a sample week', async () => {
    const scenarios = [
      ['group',{coaching:'group',coachSessions:0}],
      ['personal',{coaching:'personal',coachSessions:4}],
      ['missing coaching',{coachSessions:0,coachingLabel:'No coach'}],
      ['missing sessions',{coaching:'none',coachingLabel:'No coach'}],
      ['contradictory sessions',{coaching:'none',coachSessions:2}],
      ['missing terms',null]
    ];
    for (const [label,coaching] of scenarios) {
      const f = fixture();
      f.invoices[0].terms = coaching ? {...f.invoices[0].terms,...coaching} : null;
      if (label === 'missing coaching') delete f.invoices[0].terms.coaching;
      if (label === 'missing sessions') delete f.invoices[0].terms.coachSessions;
      // A member display snapshot and editable catalog still saying "No coach" must not be a fallback.
      const page = await open(f);
      try {
        assert.equal(await page.locator('#sample-training').count(),0,label);
        assert.equal(await page.locator('#fitness-survey').count(),1);
        await page.evaluate(() => navigate('overview'));
        assert.equal(await page.getByRole('button',{name:'Show my member QR',exact:true}).count(),1,'paid pass control remains accessible');
        assert.deepEqual(f.mutations,[]);
        clean(f);
      } finally { await page.close(); }
    }
  });

  test('upcoming-only, unpaid, expired and disabled memberships retain access rules without a sample week', async () => {
    for (const scenario of ['upcoming','unpaid','expired','disabled','onboarding']) {
      const f = fixture();
      if (scenario === 'upcoming') {
        Object.assign(f.member,{start:'2026-10-31',end:'2026-11-29'});
        Object.assign(f.invoices[0],{start:f.member.start,end:f.member.end});
      }
      if (scenario === 'unpaid') f.invoices[0].paidCents = 0;
      if (scenario === 'expired') {
        f.member.end = '2026-10-16';
        f.invoices[0].end = f.member.end;
      }
      if (scenario === 'disabled') f.member.enabled = false;
      if (scenario === 'onboarding') { f.member.survey = null; f.invoices[0].paidCents = 0; }
      const page = await open(f);
      try {
        assert.equal(await page.locator('#sample-training').count(),0,scenario);
        if (scenario === 'onboarding') {
          assert.equal(await page.locator('.survey-first #member-survey-form').isVisible(),true);
          assert.equal(await page.locator('.membership-card').count(),0);
        } else {
          assert.equal(await page.locator('.membership-card .badge').innerText(),{upcoming:'Scheduled',unpaid:'Pending',expired:'Expired',disabled:'Inactive'}[scenario]);
        }
        assert.deepEqual(f.mutations,[]);
        clean(f);
      } finally { await page.close(); }
    }
  });

  test('paid members with incomplete answers get guidance rather than a fabricated week and keep their paid pass', async () => {
    for (const missing of ['survey','profile goal','experience','preferences','weekdays']) {
      const f = fixture();
      if (missing === 'survey') f.member.survey = null;
      if (missing === 'profile goal') { f.member.goal = ''; f.member.survey.goal = 'Improve fitness'; }
      if (missing === 'experience') f.member.survey.experience = '';
      if (missing === 'preferences') f.member.survey.exercises = [];
      if (missing === 'weekdays') f.member.survey.availableDays = [];
      const page = await open(f);
      try {
        const panel = page.locator('#sample-training');
        assert.equal(await panel.count(),1,missing);
        assert.match(await panel.innerText(),/Complete your fitness profile to see an optional sample week\./);
        assert.equal(await panel.locator('.sample-week-day').count(),0,'no answers fabricated');
        assert.equal(await page.locator('.membership-card .badge').innerText(),'Active');
        assert.equal(await page.locator('.survey-first').count(),0,'paid member is not sent back to first-login onboarding');
        assert.equal(await page.locator('#fitness-survey').count(),1);
        await page.evaluate(() => navigate('overview'));
        assert.equal(await page.getByRole('button',{name:'Show my member QR',exact:true}).count(),1,'incomplete answers do not remove the paid pass control');
        assert.deepEqual(f.mutations,[]);
        clean(f);
      } finally { await page.close(); }
    }
  });
});
