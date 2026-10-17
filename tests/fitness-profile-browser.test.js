// Combined editor using real assets and isolated API responses; no live accounts or writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const MEMBER_ID = '11111111-2222-3333-4444-555555555555', TODAY = '2026-10-17';
const empty = () => ({heightCm:null,weightKg:null,ageBand:null,conditions:[]});
function fixture() {
  const plans = [
    {id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']},
    {id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio','mobility','group_classes']},
    {id:'elite',name:'Performance',price_cents:249900,coaching:'personal',coach_sessions:4,focus_tags:['strength','mobility']}
  ].map(p=>planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const terms = {...plans[0],features:['Purchased Essential benefit']};
  const member = {id:MEMBER_ID,name:'Existing Member',email:'existing@example.invalid',phone:'09170000001',goal:'Improve fitness',
    survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat'],updatedAt:'2026-10-17T05:00:00Z'},
    enabled:true,photo:'',plan:'basic',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const invoice = {id:'paid-current',memberId:MEMBER_ID,plan:'basic',terms,amount:899,amountCents:89900,paidCents:89900,start:member.start,end:member.end,due:member.start,created:member.start};
  return {plans,member,invoices:[invoice],health:{heightCm:175,weightKg:70,ageBand:'20plus',conditions:['asthma'],updatedAt:'2026-10-17T05:00:00Z'},
    user:{id:MEMBER_ID,memberId:MEMBER_ID,role:'member',name:member.name,can:capabilitiesFor('member')},posts:[],fail:{},errors:[],unexpected:[],delay:0};
}
const snapshot = f => ({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:f.invoices,memberships:[],payments:[],submissions:[],checkins:[],activity:[],
  registrations:[],checkouts:[],outbox:[],settings:{payments:{},email:null},visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:false,methods:[],testMode:true},memberHealth:f.health});

describe('combined member fitness profile', {concurrency:false}, () => {
  let browser, server, origin;
  before(async()=>{
    const env = {}; server = createDevServer(env);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    origin = env.APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
  });
  after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
  async function open(f,{delayModule=false}={}) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
    page.on('pageerror',error=>f.errors.push(error.message));
    await page.addInitScript(()=>document.addEventListener('repready-ready',()=>{window.profileReady=true;}));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;
      if(url.origin!==origin||path.startsWith('/_vercel/'))return route.fulfill({status:200,body:''});
      if(!path.startsWith('/api/')) {
        if(delayModule&&path==='/member-health.js')await new Promise(resolve=>setTimeout(resolve,400));
        return route.continue();
      }
      let body;
      if(request.method()==='GET'&&path==='/api/plans')body={plans:f.plans};
      else if(request.method()==='GET'&&path==='/api/session')body={user:f.user,date:TODAY};
      else if(request.method()==='GET'&&path==='/api/state')body=snapshot(f);
      else if(request.method()==='POST'&&['/api/member-survey','/api/member-health'].includes(path)) {
        const answers=request.postDataJSON();f.posts.push({path,answers});
        const keys=path.endsWith('member-survey')?['availableDays','exercises','experience','goal']:['ageBand','conditions','heightCm','weightKg'];
        assert.deepEqual(Object.keys(answers).sort(),keys,'private fields never enter the staff-readable survey payload');
        if(f.hold)await f.hold;
        if(f.delay)await new Promise(resolve=>setTimeout(resolve,f.delay));
        if(f.fail[path])return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:f.fail[path]})});
        if(path.endsWith('member-survey')) {
          f.member.goal=answers.goal;f.member.survey={experience:answers.experience,exercises:answers.exercises,availableDays:answers.availableDays,updatedAt:'2026-10-17T06:00:00Z'};
          body={goal:f.member.goal,survey:f.member.survey};
        }else {f.health={...answers,updatedAt:'2026-10-17T06:00:00Z'};body={memberHealth:f.health};}
      }else {f.unexpected.push(`${request.method()} ${path}`);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected isolated request'})});}
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(origin+'/#/member/members');await page.waitForFunction(()=>window.profileReady);return page;
  }
  const clean=f=>{assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);};
  const edit=page=>page.getByRole('button',{name:'Edit answers',exact:true}).click();
  const save=page=>page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
  const saved=page=>page.getByRole('button',{name:'Edit answers',exact:true}).waitFor();
  async function assertGuidance(page) {
    assert.equal(await page.locator('#sample-training').count(),1);
    assert.match(await page.locator('#sample-training').innerText(),/Professional guidance recommended/);
    assert.equal(await page.locator('.sample-week-day').count(),0);
  }
  async function changeBoth(page) {await page.locator('#survey-goal').selectOption('Build strength');await page.locator('#health-weight').fill('80');}

  test('restored paid Essential with saved Asthma renders guidance and one combined editor on desktop and phones',async()=>{
    const f=fixture(),page=await open(f,{delayModule:true});
    try {
      await assertGuidance(page);
      assert.equal(await page.locator('.plan-card.recommended-plan h2').innerText(),'Performance');
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 22\.9/);
      await edit(page);
      assert.equal(await page.locator('#member-survey-form').count(),1);
      assert.equal(await page.locator('#member-survey-form form,#member-health-form').count(),0);
      assert.equal(await page.getByRole('button',{name:'Save fitness profile',exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:/Save my answers|Save optional details/}).count(),0);
      assert.equal(await page.locator('#survey-goal').inputValue(),'Improve fitness');
      assert.equal(await page.locator('#health-asthma').isChecked(),true);
      assert.equal(await page.locator('#health-height').inputValue(),'175');
      await mkdir('test-results',{recursive:true});
      await page.locator('#fitness-survey').screenshot({path:'test-results/fitness-profile-desktop.png',animations:'disabled'});
      for(const width of [390,320]) {
        await page.setViewportSize({width,height:844});
        await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        assert.equal(await page.locator('#fitness-survey').evaluate(panel=>panel.scrollWidth<=panel.clientWidth),true);
        assert.equal(await page.getByRole('button',{name:'Save fitness profile',exact:true}).isVisible(),true);
        if(width===390)await page.locator('#fitness-survey').screenshot({path:'test-results/fitness-profile-phone.png',animations:'disabled'});
      }
      await page.reload();await page.waitForFunction(()=>window.profileReady);await assertGuidance(page);
      assert.deepEqual(f.posts,[]);clean(f);
    }finally{await page.close();}
  });

  test('one save validates and saves both isolated sections once, then immediately refreshes guidance, BMI and recommendations',async()=>{
    const f=fixture();f.health={...f.health,conditions:['none']};f.delay=250;
    const purchases=JSON.stringify({terms:f.member.terms,invoices:f.invoices}),page=await open(f);
    try {
      assert.equal(await page.locator('.sample-week-day').count(),7);
      const controls=await page.locator('[data-action="select-plan"]').allInnerTexts();
      await edit(page);await changeBoth(page);await page.locator('#health-asthma').check();
      await page.locator('#member-survey-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
      await page.getByRole('button',{name:'Saving…',exact:true}).waitFor();
      assert.equal(await page.locator('#survey-goal').isDisabled(),true);
      assert.equal(await page.locator('#health-asthma').isDisabled(),true);
      await saved(page);await assertGuidance(page);
      assert.equal(f.posts.length,2);assert.equal(new Set(f.posts.map(p=>p.path)).size,2);
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 26\.1/);
      assert.match(await page.locator('#survey-status').innerText(),/saved/i);
      assert.equal(await page.locator('.plan-card.recommended-plan h2').innerText(),'Performance');
      assert.deepEqual(await page.locator('[data-action="select-plan"]').allInnerTexts(),controls);
      assert.equal(JSON.stringify({terms:f.member.terms,invoices:f.invoices}),purchases);
      assert.match(await page.locator('.membership-privileges').innerText(),/Purchased Essential benefit/);
      clean(f);
    }finally{await page.close();}
  });

  test('saved Asthma does not override current coached purchase; upcoming paid Essential and later unpaid cycle show an accurate exclusion',async()=>{
    const f=fixture(),currentTerms={...f.plans[1],features:['Purchased Momentum benefit']};
    Object.assign(f.member,{plan:'plus',terms:currentTerms,start:'2026-10-12',end:'2026-11-10'});
    Object.assign(f.invoices[0],{plan:'plus',terms:currentTerms,amount:1499,amountCents:149900,paidCents:149900,start:f.member.start,end:f.member.end});
    f.invoices.push({...f.invoices[0],id:'paid-upcoming-essential',plan:'basic',terms:{...f.plans[0]},amount:899,amountCents:89900,paidCents:89900,start:'2026-11-11',end:'2026-12-10'});
    f.invoices.push({...f.invoices[0],id:'unpaid-future-momentum',paidCents:0,start:'2026-12-11',end:'2027-01-09'});
    const page=await open(f);
    try {
      assert.equal(await page.locator('#sample-training').count(),1);
      assert.equal(await page.locator('.sample-week-day').count(),0);
      assert.doesNotMatch(await page.locator('#sample-training').innerText(),/Professional guidance recommended/);
      assert.match(await page.locator('#sample-training').innerText(),/current|coach/i);
      assert.equal(await page.locator('[data-sample-exclusion="group-coaching"]').count(),1);
      assert.match(await page.locator('.membership-card h2').innerText(),/Momentum/);
      assert.equal(await page.locator('.plan-card.current-plan .tag.current-plan').innerText(),'Your upcoming paid plan');
      assert.equal(await page.locator('.next-cycle-note.waiting [data-action="pay"]').getAttribute('data-id'),'unpaid-future-momentum');
      assert.match(await page.locator('#member-health').innerText(),/Asthma/i);
      assert.deepEqual(f.posts,[]);clean(f);
    }finally{await page.close();}
  });

  test('both sections validate before any request and blank or declined optional fields remain optional',async()=>{
    const f=fixture(),page=await open(f);
    try {
      await edit(page);await page.locator('#survey-experience').selectOption('');await page.locator('#health-height').fill('49');await save(page);
      assert.equal(await page.locator('#survey-errors').isVisible(),true);
      assert.equal(await page.locator('#member-health-error').isVisible(),true);
      assert.deepEqual(f.posts,[]);
      await page.locator('#survey-experience').selectOption('returning');await save(page);assert.deepEqual(f.posts,[]);
      await page.locator('[data-health-clear]').click();await save(page);await saved(page);
      assert.equal(f.posts.length,2);assert.deepEqual(f.posts.find(p=>p.path.endsWith('member-health')).answers,empty());
      assert.equal(await page.locator('.sample-week-day').count(),7);
      assert.match(await page.locator('#sample-training').innerText(),/unknown or declined/i);
      await edit(page);await page.locator('#health-prefer_not').check();await save(page);await saved(page);
      assert.equal(await page.locator('.sample-week-day').count(),7);
      assert.match(await page.locator('#sample-training').innerText(),/unknown or declined/i);clean(f);
    }finally{await page.close();}
  });

  test('an in-flight save survives a replaced member snapshot and rejects duplicate submission from a newly rendered editor',async()=>{
    const f=fixture();f.health={...f.health,conditions:['none']};
    let release;f.hold=new Promise(resolve=>{release=resolve;});
    const page=await open(f);
    try {
      await edit(page);await changeBoth(page);await page.locator('#health-asthma').check();
      await page.locator('#member-survey-form').evaluate(form=>form.requestSubmit());
      await page.waitForFunction(()=>document.querySelector('#member-survey-form').dataset.saving==='true');
      await page.evaluate(()=>{state.members=state.members.map(member=>({...member,survey:{...member.survey}}));render();});
      assert.equal(await page.locator('#member-survey-form').count(),1);
      assert.equal(await page.getByRole('button',{name:'Saving…',exact:true}).isDisabled(),true);
      assert.equal(await page.locator('#survey-goal').isDisabled(),true);
      assert.equal(await page.locator('#health-asthma').isDisabled(),true);
      assert.equal(await page.locator('#survey-goal').inputValue(),'Build strength');
      assert.equal(await page.locator('#health-weight').inputValue(),'80');
      assert.equal(await page.locator('#health-asthma').isChecked(),true);
      await page.locator('#member-survey-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
      release();
      await page.waitForFunction(()=>fitnessProfileSavingMember===null);
      await saved(page);
      assert.equal(f.posts.length,2,'the fresh editor cannot start duplicate endpoint requests');
      assert.equal(await page.evaluate(()=>state.members[0].goal),'Build strength','confirmed results update the current state member, not a detached snapshot');
      assert.equal(await page.evaluate(()=>state.memberHealth.weightKg),80);
      assert.deepEqual(await page.evaluate(()=>state.memberHealth.conditions),['asthma']);
      assert.equal(await page.locator('#member-survey-form').count(),0,'successful completion closes the editor');
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 26\.1/);
      await assertGuidance(page);
      clean(f);
    }finally{release();await page.close();}
  });

  test('health failure preserves the draft and withholds routines; retry sends only failed health section',async()=>{
    const f=fixture();f.fail['/api/member-health']='Private health service unavailable.';const page=await open(f);
    try {
      await edit(page);await changeBoth(page);await page.locator('#health-none').check();await save(page);
      await page.locator('#survey-errors').filter({hasText:/Health details could not be saved/}).waitFor();
      assert.equal(f.posts.length,2);assert.equal(f.member.goal,'Build strength');
      assert.equal(await page.locator('#survey-goal').inputValue(),'Build strength');assert.equal(await page.locator('#health-weight').inputValue(),'80');
      assert.equal(await page.locator('#health-none').isChecked(),true);
      assert.match(await page.locator('#sample-training').innerText(),/Optional health details need to be saved/);
      assert.equal(await page.locator('.sample-week-day').count(),0,'a failed health save never generates a routine from unsaved health answers');
      assert.deepEqual(await page.evaluate(()=>state.memberHealth.conditions),['asthma']);
      assert.doesNotMatch(await page.locator('#survey-status').innerText(),/profile.*saved/i);
      delete f.fail['/api/member-health'];await save(page);await saved(page);
      assert.deepEqual(f.posts.map(p=>p.path).sort(),['/api/member-health','/api/member-health','/api/member-survey']);
      assert.equal(await page.locator('.sample-week-day').count(),7);assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 26\.1/);clean(f);
    }finally{await page.close();}
  });

  test('fitness failure preserves all input and confirmed health guidance; retry does not repeat successful health save',async()=>{
    const f=fixture();f.health={...f.health,conditions:['none']};f.fail['/api/member-survey']='Fitness service unavailable.';
    const page=await open(f);
    try {
      await edit(page);await changeBoth(page);await page.locator('#health-asthma').check();await save(page);
      await page.locator('#survey-errors').filter({hasText:/Fitness answers could not be saved/}).waitFor();
      assert.equal(f.posts.length,2);assert.equal(f.member.goal,'Improve fitness');
      assert.equal(await page.locator('#survey-goal').inputValue(),'Build strength');assert.equal(await page.locator('#health-asthma').isChecked(),true);
      await assertGuidance(page);assert.deepEqual(await page.evaluate(()=>state.memberHealth.conditions),['asthma']);
      delete f.fail['/api/member-survey'];await save(page);await saved(page);
      assert.deepEqual(f.posts.map(p=>p.path).sort(),['/api/member-health','/api/member-survey','/api/member-survey']);
      await assertGuidance(page);clean(f);
    }finally{await page.close();}
  });

  test('Cancel discards both drafts and Clear health details only becomes a health-only write on main Save',async()=>{
    const f=fixture(),survey=JSON.stringify({goal:f.member.goal,survey:f.member.survey}),page=await open(f);
    try {
      await edit(page);await changeBoth(page);await page.locator('[data-health-clear]').click();
      assert.equal(await page.locator('#health-height').inputValue(),'');assert.equal(await page.locator('[name="conditions"]:checked').count(),0);
      assert.deepEqual(f.posts,[]);await assertGuidance(page);
      await page.getByRole('button',{name:'Cancel',exact:true}).click();await assertGuidance(page);
      assert.match(await page.locator('#member-health-bmi').innerText(),/BMI 22\.9/);
      await edit(page);assert.equal(await page.locator('#survey-goal').inputValue(),'Improve fitness');assert.equal(await page.locator('#health-asthma').isChecked(),true);
      await page.locator('[data-health-clear]').click();assert.deepEqual(f.posts,[]);await save(page);await saved(page);
      assert.deepEqual(f.posts,[{path:'/api/member-health',answers:empty()}]);
      assert.equal(JSON.stringify({goal:f.member.goal,survey:f.member.survey}),survey);
      assert.equal(await page.locator('.sample-week-day').count(),7);
      assert.match(await page.locator('#sample-training').innerText(),/unknown or declined/i);clean(f);
    }finally{await page.close();}
  });

  test('first onboarding remains required while optional blanks save with no new gate; paid incomplete member stays in the app',async()=>{
    for(const paid of [false,true]) {
      const f=fixture();f.member.survey=null;f.health=null;if(!paid)f.invoices[0].paidCents=0;
      const page=await open(f);
      try {
        assert.equal(await page.locator('.survey-first').count(),paid?0:1);
        await save(page);assert.deepEqual(f.posts,[]);
        await page.locator('#survey-experience').selectOption('beginner');await page.locator('#survey-strength').check();await page.locator('#survey-mon').check();
        await save(page);
        if(paid){await saved(page);assert.equal(await page.locator('.sample-week-day').count(),7);}
        else {await page.getByRole('link',{name:'My membership',exact:true}).waitFor();assert.equal(await page.locator('.survey-first').count(),0);}
        assert.deepEqual(f.posts.map(p=>p.path),['/api/member-survey'],'blank unknown optional health needs no write');clean(f);
      }finally{await page.close();}
    }
  });

  test('after first required answers save, Cancel can discard a failed optional health draft without imposing a health gate',async()=>{
    const f=fixture();f.member.survey=null;f.health=null;f.invoices[0].paidCents=0;
    f.fail['/api/member-health']='Private health service unavailable.';
    const page=await open(f);
    try {
      await page.locator('#survey-experience').selectOption('beginner');await page.locator('#survey-strength').check();await page.locator('#survey-mon').check();
      await page.locator('#health-asthma').check();await save(page);
      await page.locator('#survey-errors').filter({hasText:/Health details could not be saved/}).waitFor();
      assert.equal(f.member.survey.experience,'beginner');assert.equal(f.health,null);
      assert.equal(await page.locator('#health-asthma').isChecked(),true);
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      await page.getByRole('link',{name:'My membership',exact:true}).waitFor();
      assert.equal(await page.locator('.survey-first').count(),0);
      await page.getByRole('link',{name:'My membership',exact:true}).click();await edit(page);
      assert.equal(await page.locator('#health-asthma').isChecked(),false);
      assert.equal(await page.locator('#survey-experience').inputValue(),'beginner');
      assert.equal(f.posts.length,2,'Cancel makes no additional request');clean(f);
    }finally{await page.close();}
  });
});
