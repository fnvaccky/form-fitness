// Task 11 offline UI checks: the real app files in a browser, with synthetic API answers only (no accounts).
// Ported from a classmate's survey work (fitness-survey-update.zip, tests/survey-browser.js) and updated for the
// survey being required at first login, the desk survey in Add member, and "Your fitness profile".
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDevServer } from '../src/dev.js';
import { capabilitiesFor } from '../src/state.js';
import { validateSurvey } from '../src/survey.js';

const env = {};
const server = createDevServer(env);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = env.APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true, channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
const context = await browser.newContext({viewport:{width:1440,height:1000}});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
// A new member: no plan yet and no survey.
const member = {id:'11111111-2222-3333-4444-555555555555',name:'Morgan Reed',email:'morgan@example.invalid',phone:'09170000001',goal:'Improve fitness',enabled:true,photo:'',plan:undefined,start:null,end:null,joined:'2026-10-01',survey:null};
const plan = {id:'basic',name:'Essential',price:899,priceCents:89900,available:true,days:30,desc:'A solid foundation for your fitness routine.',features:['Unlimited gym access','Fitness orientation'],tag:'YOUR FITNESS JOURNEY'};
let role = 'member', saveCount = 0, failSave = false, delaySave = false, signedIn = true, deskBody = null;
const user = () => ({id:role==='member'?member.id:'99999999-2222-3333-4444-555555555555',memberId:role==='member'?member.id:null,role,name:role==='member'?member.name:'Gym staff',can:capabilitiesFor(role)});
const snapshot = () => ({user:user(),date:'2026-10-10',members:[member],plans:[plan],invoices:[],memberships:[],payments:[],submissions:[],checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],unpaidAccounts:[],settings:{payments:{},email:{}},paymongo:{configured:false,methods:[],testMode:true}});
await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let status = 200, body;
  if(path==='/api/plans')body={plans:[plan]};
  else if(path==='/api/session')body={user:signedIn?user():null,date:'2026-10-10'};
  else if(path==='/api/state')body=snapshot();
  else if(path==='/api/logout'){signedIn=false;body={ok:true};}
  else if(path==='/api/members'){deskBody=route.request().postDataJSON();status=201;body={member:{id:'22222222-2222-3333-4444-555555555555',name:deskBody.name,email:deskBody.email,phone:deskBody.phone},invoiceId:null,setupEmailSent:true,message:'Account created.'};}
  else if(path==='/api/member-survey'){
    saveCount++;
    if(delaySave)await new Promise(resolve=>setTimeout(resolve,250));
    if(failSave){status=502;body={error:'Could not save your answers. Please try again.'};}
    else{
      const answers=validateSurvey(route.request().postDataJSON());
      member.goal=answers.goal;
      member.survey={experience:answers.experience,exercises:answers.exercises,availableDays:answers.availableDays,updatedAt:'2026-10-10T06:30:00.000Z'};
      body={goal:member.goal,survey:member.survey};
    }
  }else throw Error(`Unexpected API request: ${path}`);
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
});
await mkdir('test-results',{recursive:true});
const noOverflow = async width => assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px has no horizontal overflow`);
try {
  // First login: only the survey, with a short welcome and Sign out; no way into the rest of the app.
  await page.goto(origin);
  await page.getByRole('heading',{name:'Welcome, Morgan.',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true,'Sign out is there');
  assert.equal(await page.getByRole('link',{name:'My overview',exact:true}).count(),0,'no navigation until the survey is saved');
  assert.equal(await page.getByRole('button',{name:/skip/i}).count(),0,'no skip');
  await page.locator('.survey-first').screenshot({path:'test-results/survey-first-desktop.png',animations:'disabled'});
  await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
  assert.equal(saveCount,0,'incomplete forms never submit');
  assert.equal(await page.locator('#survey-errors a').count(),3,'the goal comes preselected from the profile; three answers are missing');
  assert.equal(await page.locator('#survey-errors').evaluate(el=>el===document.activeElement),true);
  await page.getByRole('link',{name:'Choose your training experience.',exact:true}).click();
  assert.equal(await page.locator('#survey-experience').evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('#member-survey-form').count(),1,'error links must not navigate away');
  await page.getByLabel('What is your main goal?',{exact:true}).selectOption('Build strength');
  await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption('returning');
  await page.getByLabel('Strength training',{exact:true}).check();
  await page.getByLabel('Cardio',{exact:true}).check();
  await page.getByLabel('Monday',{exact:true}).check();
  await page.getByLabel('Friday',{exact:true}).check();
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await noOverflow(width);
    await page.locator('.survey-first').screenshot({path:`test-results/survey-first-mobile-${width}.png`,animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1000});
  failSave=true;
  await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
  await page.locator('#survey-errors').filter({hasText:'Could not save your answers. Please try again.'}).waitFor();
  assert.equal(await page.getByLabel('Cardio',{exact:true}).isChecked(),true,'answers survive a failed save');
  failSave=false;delaySave=true;
  const before=saveCount;
  await page.locator('#member-survey-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
  await page.getByRole('button',{name:'Saving…',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Monday',{exact:true}).isDisabled(),true);
  // After the first save: thanks, and on to plan selection.
  await page.locator('.survey-thanks').filter({hasText:'Thanks! Choose your plan next.'}).waitFor();
  assert.equal(saveCount,before+1,'double submit is ignored');
  assert.match(await page.locator('#app').innerText(),/Choose a plan to start your membership\./,'plan selection');
  assert(await page.locator('[data-action="select-plan"],[data-action="renew-plan"],.plan-card').count()>0,'the plans are on screen');
  await page.screenshot({path:'test-results/survey-thanks-plans.png',animations:'disabled'});
  // Later: My membership → "Your fitness profile", with Edit and Cancel.
  await page.getByRole('link',{name:'My membership',exact:true}).click();
  await page.getByRole('heading',{name:'Your fitness profile',exact:true}).waitFor();
  assert.match(await page.locator('#fitness-survey').innerText(),/getting back into it/);
  await page.reload();
  await page.getByRole('link',{name:'My membership',exact:true}).click();
  await page.getByRole('button',{name:'Edit answers',exact:true}).click();
  assert.equal(await page.getByLabel('How familiar are you with training?',{exact:true}).inputValue(),'returning');
  assert.equal(await page.getByLabel('Strength training',{exact:true}).isChecked(),true);
  assert.equal(await page.getByLabel('Friday',{exact:true}).isChecked(),true);
  await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption('regular');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.match(await page.locator('#fitness-survey').innerText(),/getting back into it/,'cancel restores saved answers');
  await page.getByRole('button',{name:'Edit answers',exact:true}).click();
  await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption('regular');
  await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
  await page.getByRole('button',{name:'Edit answers',exact:true}).waitFor();
  assert.match(await page.locator('#fitness-survey').innerText(),/train regularly/);
  assert.match(await page.locator('#survey-status').innerText(),/fitness profile is saved/);
  await page.getByRole('button',{name:'Edit answers',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('toast').classList.contains('show'));
  await page.locator('#fitness-survey').screenshot({path:'test-results/survey-profile-desktop.png',animations:'disabled'});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await noOverflow(width);
    await page.locator('#fitness-survey').screenshot({path:`test-results/survey-profile-mobile-${width}.png`,animations:'disabled'});
  }
  await page.getByLabel('Wednesday',{exact:true}).check();
  await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();
  await page.getByRole('button',{name:'Edit answers',exact:true}).waitFor();
  assert(member.survey.availableDays.includes('wed'),'a phone-sized save keeps the new day');
  await page.setViewportSize({width:1440,height:1000});
  // Sign out from the first-login screen.
  member.survey=null;await page.reload();
  await page.getByRole('heading',{name:'Welcome, Morgan.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('heading',{name:'Good to see you.',exact:true}).waitFor();
  signedIn=true;member.survey={experience:'regular',exercises:['strength'],availableDays:['wed'],updatedAt:'2026-10-10T06:30:00.000Z'};
  // Staff and administrators: never asked; they read the answers and can't edit them.
  for(const staffRole of ['staff','admin']){
    role=staffRole;
    await page.goto(origin);
    await page.getByRole('link',{name:/^Members & plans/}).click();
    assert.equal(await page.locator('.survey-first').count(),0,'staff never get the survey screen');
    await page.locator(`[data-action="profile"][data-id="${member.id}"]`).first().click();
    await page.getByRole('heading',{name:'Fitness survey',exact:true}).waitFor();
    assert.match(await page.locator('.survey-staff').innerText(),/Wednesday/);
    assert.equal(await page.getByRole('button',{name:'Save fitness profile',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Edit answers',exact:true}).count(),0);
    if(staffRole==='staff')await page.locator('.modal').screenshot({path:'test-results/survey-staff.png',animations:'disabled'});
    await page.keyboard.press('Escape');
  }
  member.survey=null;
  await page.reload();
  await page.getByRole('link',{name:/^Members & plans/}).click();
  await page.locator(`[data-action="profile"][data-id="${member.id}"]`).first().click();
  assert.match(await page.locator('.survey-staff').innerText(),/No survey answers yet/);
  await page.keyboard.press('Escape');
  // At the desk: Add member's optional survey. Untouched, nothing is sent; half done, it says what's missing.
  await page.getByRole('button',{name:'Add member',exact:true}).first().click();
  await page.getByLabel('Full name *',{exact:true}).fill('Desk Member');await page.getByLabel('Email address *',{exact:true}).fill('desk@example.invalid');await page.getByLabel('Mobile number *',{exact:true}).fill('09170000002');
  assert.equal(await page.getByLabel('Goal (optional)',{exact:true}).count(),0,'the goal is the survey\'s first question now');
  await page.getByText('Fitness survey (optional — the member can do it at first login)',{exact:true}).click();
  await page.locator('#desk-goal').selectOption('Manage weight');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.locator('.modal .form-error').filter({hasText:'Finish the fitness survey (training experience, exercise preferences, usual days)'}).waitFor();
  assert.equal(deskBody,null,'a half-done survey is not sent');
  await page.locator('#desk-experience').selectOption('beginner');await page.locator('#desk-cardio').check();await page.locator('#desk-sat').check();
  await page.locator('.modal').screenshot({path:'test-results/survey-desk.png',animations:'disabled'});
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('heading',{name:'Member account created',exact:true}).waitFor();
  assert.deepEqual(deskBody,{name:'Desk Member',email:'desk@example.invalid',phone:'09170000002',goal:'Manage weight',survey:{experience:'beginner',exercises:['cardio'],availableDays:['sat']}});
  console.log('PASS: first-login survey (welcome, no skip, Sign out), validation, keyboard focus, failed-save recovery, double-submit guard, thanks and plan selection, "Your fitness profile" editing and cancel, reload, phone layouts, staff/admin read-only views and empty state, and the desk survey in Add member.');
  assert.deepEqual(errors,[],'no browser runtime errors');
}catch(error){
  console.error('Browser errors:',errors);
  console.error((await page.locator('body').innerText()).slice(0,2000));
  throw error;
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
