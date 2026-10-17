import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
const origin=process.env.TEST_BASE_URL||process.env.APP_ORIGIN||'http://localhost:4173';
const credentials=JSON.parse(await readFile('.local/demo-credentials.json','utf8'));
const adminAccount=credentials.accounts.find(a=>a.role==='admin'),memberAccount=credentials.accounts.find(a=>a.email.includes('-customer@'))||credentials.accounts[1];
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
if(process.env.VERCEL_AUTOMATION_BYPASS_SECRET)await context.request.get(origin,{headers:{'x-vercel-protection-bypass':process.env.VERCEL_AUTOMATION_BYPASS_SECRET,'x-vercel-set-bypass-cookie':'true'}});
const page=await context.newPage();const errors=[],checks=[];
// Vercel Web Analytics (PR #1) loads /_vercel/insights/script.js, which exists only on Vercel; locally it is a 404.
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 400')&&!m.text().includes('status of 401')&&!m.location().url.includes('/_vercel/insights/'))errors.push(m.text());});
const pass=s=>{checks.push(s);console.log('PASS: '+s);};
const heading=async name=>{await page.getByRole('heading',{name,exact:true}).waitFor();};
// Task 11: a member without a fitness survey is asked for it first; answer it if this demo customer hasn't yet.
const answerSurveyIfAsked=async()=>{await page.locator('.survey-first,.page-heading').first().waitFor();if(await page.locator('.survey-first').count()){await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption('regular');await page.getByLabel('Strength training',{exact:true}).check();await page.getByLabel('Monday',{exact:true}).check();await page.getByRole('button',{name:'Save fitness profile',exact:true}).click();await page.locator('.survey-first').waitFor({state:'detached'});}};
const login=async a=>{await page.getByLabel('Email address',{exact:true}).fill(a.email);await page.getByLabel('Password',{exact:true}).fill(a.password);await page.getByRole('button',{name:'Log in',exact:true}).click();};
await mkdir('test-results',{recursive:true});
try{
 await page.goto(origin);await heading('Good to see you.');
 assert.equal(await page.getByRole('button',{name:'Create a member account',exact:true}).count(),0);pass('First registration is staff-assisted; public signup is unavailable');
 await page.getByRole('button',{name:'Forgot your password?',exact:true}).click();await page.getByLabel('Email address *',{exact:true}).waitFor();await page.keyboard.press('Escape');pass('Password recovery UI opens without sending mail to a test address');
 await login(memberAccount);await answerSurveyIfAsked();await heading('Your next chapter, DEMO.');
 assert.equal(await page.getByRole('button',{name:'Admin view',exact:true}).count(),0);await page.screenshot({animations:'disabled',path:'test-results/member-desktop.png'});pass('Real customer login renders dashboard with no admin controls');
 await page.reload();await heading('Your next chapter, DEMO.');pass('Browser reload restores the Supabase session');
 // 13A: once the member has checked in today (the integration suite checks the demo customer in), the pass shows that instead of a QR.
 const visited=(await (await page.request.get(origin+'/api/checkin-status')).json()).checkedIn;
 await page.getByRole('button',{name:'Show my member QR',exact:true}).click();
 if(visited)await page.locator('.checked-in').filter({hasText:/Already checked in today at \d{1,2}:\d\d [AP]M/}).waitFor();
 else{await heading('Your member QR');assert.equal(await page.locator('#member-qr-canvas').count(),1);}
 await page.keyboard.press('Escape');pass(visited?'Active member pass shows today\'s check-in instead of a new QR':'Active member pass renders as a scannable QR');
 await page.getByRole('link',{name:'My payments',exact:true}).click();await heading('Your payments, at a glance.');
 await page.getByRole('link',{name:'My membership',exact:true}).click();
 // UI-001: a paid member renews or switches for their next cycle; while one waits for payment, they pay it instead.
 await page.locator('.plans-grid').waitFor();
 if(await page.locator('.next-cycle-note.waiting').count()){
  assert.match(await page.locator('.next-cycle-note.waiting').innerText(),/^Your next cycle \(.+, from \d{1,2} [A-Z][a-z]{2}\) is waiting for payment\./);
  assert.equal(await page.locator('[data-action="select-plan"]').count(),0,'no other plan while the next cycle waits');
 }else{
  await page.locator('.plan-card:not(.current-plan) [data-action="select-plan"]').first().click();await heading('Create your next membership cycle');assert.match(await page.locator('.notice').innerText(),/real invoice/);await page.keyboard.press('Escape');
 }
 pass('Payments, membership navigation and honest renewal confirmation UI');
 await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);await page.screenshot({animations:'disabled',path:'test-results/member-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('link',{name:'My overview',exact:true}).click();await heading('Your next chapter, DEMO.');assert.equal(await page.locator('.sidebar.open').count(),0);pass('Mobile member layout fits viewport and navigation closes');
 await page.getByRole('button',{name:'Log out',exact:true}).click();await heading('Good to see you.');
 await page.setViewportSize({width:1440,height:1000});await login(adminAccount);await heading('A stronger community.');
 const snapshot=await page.evaluate(async()=>await (await fetch('/api/state')).json());
 assert.equal(Number(await page.locator('.stat-value').first().innerText()),snapshot.members.length);
 const expected=snapshot.payments.filter(p=>p.date.startsWith(snapshot.date.slice(0,7))).reduce((n,p)=>n+p.amountCents,0)/100;
 assert.equal(Number((await page.locator('.stat-value').nth(2).innerText()).replace(/[^0-9.]/g,'')),expected);
 await page.screenshot({animations:'disabled',path:'test-results/admin-desktop.png'});pass('Admin dashboard counts and revenue match persisted financial records');
 await page.getByRole('button',{name:'Add member',exact:true}).click();assert.equal(await page.locator('#new-password').count(),0);await page.keyboard.press('Escape');pass('Admin onboarding never asks for a permanent customer password');
 await page.getByRole('link',{name:/Members & plans/}).click();await page.getByLabel('Search members',{exact:true}).fill('no-such-member-test');assert.match(await page.locator('#member-results').innerText(),/No members found/);await page.getByRole('tab',{name:'Membership plans',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Edit plan',exact:true}).count(),3);pass('Member empty state and plan management controls');
 await page.getByRole('button',{name:'Open settings',exact:true}).click();await page.getByRole('button',{name:'Gmail sender',exact:true}).click();assert.match(await page.locator('.modal-body').innerText(),/Demo notifications are disabled/);await page.keyboard.press('Escape');pass('Gmail setup and demo suppression are explicitly reported');
 // Get a fresh pass in a separate real customer session, encode it, and test scanner image fallback.
 const memberCtx=await browser.newContext({baseURL:origin,...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{extraHTTPHeaders:{'x-vercel-protection-bypass':process.env.VERCEL_AUTOMATION_BYPASS_SECRET,'x-vercel-set-bypass-cookie':'true'}}:{})});
 await memberCtx.request.post(origin+'/api/login',{headers:{Origin:origin},data:{email:memberAccount.email,password:memberAccount.password}});
 const response=await memberCtx.request.get(origin+'/api/qr');assert.equal(response.status(),200);const qr=await response.json();
 const image=await QRCode.toBuffer(qr.token,{width:500,margin:3,errorCorrectionLevel:'M'});
 await page.getByRole('button',{name:'Scan member',exact:true}).click();await page.locator('#scan-file').setInputFiles({name:'member-pass.png',mimeType:'image/png',buffer:image});await heading('Membership verified');
 assert.equal(await page.locator('#identity-confirmed').isChecked(),false);await page.keyboard.press('Escape');
 await memberCtx.request.post(origin+'/api/logout',{headers:{Origin:origin},data:{}});await memberCtx.close();pass('Actual QR image decoding fallback identifies member and requires staff confirmation');
 await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);await page.screenshot({animations:'disabled',path:'test-results/admin-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);pass('Admin mobile layout fits viewport');
 await page.getByRole('button',{name:'Log out',exact:true}).click();await heading('Good to see you.');pass('Customer and admin browser logout return to sign-in');
 assert.deepEqual(errors,[]);pass('No unhandled JavaScript exceptions or unexpected browser console errors');
}catch(error){console.log('Browser errors',errors);await page.screenshot({animations:'disabled',path:'test-results/browser-failure.png'});throw error;}
finally{await writeFile('test-results/browser-results.json',JSON.stringify({time:new Date().toISOString(),origin,passed:checks,errors,physicalCameraTested:false},null,2));await browser.close();}
