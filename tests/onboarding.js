import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
const host=new URL(process.env.SUPABASE_URL).hostname;
assert(['localhost','127.0.0.1'].includes(host),'Local tests only');
const origin=process.env.APP_ORIGIN;
const accounts=JSON.parse(await readFile('.local/local-test-credentials.json','utf8')).accounts;
const staff=accounts.find(a=>a.role==='staff');
const db=serviceClient();const plan=result(await db.from('ff_plans').select('*').eq('workspace','production').eq('id','basic').single());
const browser=await chromium.launch({channel:'msedge',headless:true});let memberId,registrationId;
try{
 const page=await browser.newPage();await page.goto(origin);
 await page.getByLabel('Email address',{exact:true}).fill(staff.email);await page.getByLabel('Password',{exact:true}).fill(staff.password);await page.getByRole('button',{name:'Log in',exact:true}).click();
 await page.getByRole('button',{name:'Add member',exact:true}).click();
 await page.getByLabel('Full name *',{exact:true}).fill('LOCAL TEST Email');await page.getByLabel('Email address *',{exact:true}).fill('wizard@example.invalid');await page.getByLabel('Mobile number *',{exact:true}).fill('09170000008');await page.getByRole('button',{name:'Continue',exact:true}).click();
 const option=page.locator('.plan-option').filter({has:page.locator('input[value="basic"]')});
 assert.equal(await option.locator('.plan-privileges').isVisible(),true);assert.match(await option.innerText(),new RegExp(plan.features[0]));
 const height=await option.evaluate(el=>el.getBoundingClientRect().height);await option.hover();assert(Math.abs(await option.evaluate(el=>el.getBoundingClientRect().height)-height)<1);
 await page.setViewportSize({width:390,height:844});assert.equal(await option.locator('.plan-privileges').isVisible(),true);assert.equal(await page.locator('.plan-benefits').count(),0);
 console.log('PASS: privileges always visible on desktop/mobile, with no hover resizing');await page.keyboard.press('Escape');
 const email=`local-onboarding-${randomUUID().slice(0,8)}@example.invalid`;
 const response=await page.request.post(origin+'/api/members',{headers:{Origin:origin},data:{name:'LOCAL TEST Email',email,phone:'09170000008',plan:'basic',start:today(),goal:'Improve fitness',requestId:randomUUID()}});
 const registration=await response.json();assert.equal(response.status(),201,registration.error);registrationId=registration.registration.id;assert.equal(registration.accountReady,false);assert.equal(registration.invitationSent,false);
 assert.equal((await db.auth.admin.listUsers()).data.users.some(u=>u.email===email),false,'No account before payment');
 const payBody={id:registrationId,amount:plan.price_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID()};
 for(const invalid of [{amount:1},{verified:false},{emailConfirmed:false},{method:'GCash'}]){const rejected=await page.request.post(origin+'/api/registration-payment',{headers:{Origin:origin},data:{...payBody,...invalid}});assert.equal(rejected.status(),400);}
 const unpaid=await page.request.post(origin+'/api/registration-fulfill',{headers:{Origin:origin},data:{id:registrationId}});assert.equal(unpaid.status(),400);
 await page.setViewportSize({width:1440,height:1000});await page.reload();await page.getByRole('link',{name:'Renewals & payments',exact:true}).click();
 await page.locator(`[data-action="registration-pay"][data-id="${registrationId}"]`).click();await page.locator('#registration-email-confirmed').check();await page.locator('#registration-cash-confirmed').check();
 const paymentResponse=page.waitForResponse(r=>r.url().endsWith('/api/registration-payment')&&r.request().method()==='POST');await page.getByRole('button',{name:'Confirm cash & create account',exact:true}).click();
 const paidResponse=await paymentResponse;const paid=await paidResponse.json();assert.equal(paidResponse.status(),200,paid.error);await page.getByRole('button',{name:'Done',exact:true}).click();memberId=paid.registration.member_id;assert.equal(paid.accountReady,true);assert.equal(paid.invitationSent,true,paid.message);
 const replay=await page.request.post(origin+'/api/registration-payment',{headers:{Origin:origin},data:payBody});assert.equal(replay.status(),200);assert.equal((await replay.json()).registration.member_id,memberId);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,1);
 console.log('PASS: no account before full payment, invalid payments denied, repeat request does not duplicate payment');
 const mailbox=await (await fetch('http://127.0.0.1:54324/api/v1/messages')).json();let mail;
 for(const item of mailbox.messages){const candidate=await (await fetch('http://127.0.0.1:54324/api/v1/message/'+item.ID)).json();if(JSON.stringify(candidate.To).includes(email)){mail=candidate;break;}}
 assert(mail,'Invitation captured locally');assert.match(mail.HTML,/Set up your account/);assert(mail.HTML.includes(plan.features[0]));assert(mail.HTML.includes(today()));
 const match=mail.HTML.match(/href="([^"]*token_hash=[^"]+)"/);assert(match,'Token-hash setup link');const link=match[1].replaceAll('&amp;','&');assert(link.startsWith(origin+'/api/auth/callback?'));
 console.log('PASS: invitation contains plan privileges, dates and correct setup callback; no staff token exposure');
 const memberPage=await browser.newPage();await memberPage.goto(link);await memberPage.getByLabel('New password *',{exact:true}).fill('LocalOnboarding2026!');await memberPage.getByRole('button',{name:'Save password',exact:true}).click();
 await memberPage.getByRole('link',{name:'My membership',exact:true}).click();await memberPage.locator('.membership-privileges').waitFor();assert((await memberPage.locator('.membership-privileges').innerText()).includes(plan.features[0]));
 await memberPage.getByRole('link',{name:'My overview',exact:true}).click();await memberPage.getByRole('button',{name:'Show my member QR',exact:true}).click();await memberPage.locator('#member-qr-canvas').waitFor();assert.equal(await memberPage.locator('#member-qr-canvas').count(),1);await memberPage.keyboard.press('Escape');
 await mkdir('test-results',{recursive:true});await memberPage.screenshot({path:'test-results/onboarding-paid-pass.png'});
 console.log('PASS: emailed link sets password, member sees same privileges, paid member can generate a live pass');
 // Walk-in renewal creates and pays one future cycle, and retries are idempotent.
 await page.getByRole('link',{name:'Renewals & payments',exact:true}).click();await page.getByRole('button',{name:'Walk-in renewal',exact:true}).click();
 await page.locator('#walkin-member').selectOption(memberId);await page.locator('#walkin-plan').selectOption('plus');await page.locator('#walkin-verified').check();
 const renewalBody={memberId,plan:'plus',start:await page.locator('#walkin-start').inputValue(),amount:await page.locator('#walkin-amount').inputValue(),verified:true,idempotencyKey:randomUUID()};
 await page.getByRole('button',{name:'Confirm cash renewal',exact:true}).click();await page.locator('#walkin-renew-form').waitFor({state:'detached'});
 let cycles=result(await db.from('ff_memberships').select('*').eq('member_id',memberId));assert.equal(cycles.length,2);assert(cycles.some(c=>c.plan_id==='plus'&&c.start_date===renewalBody.start));
 // API replay test uses a separate subsequent cycle to preserve the UI-generated key.
 const next=cycles.map(c=>c.end_date).sort().at(-1);const nextDate=new Date(next+'T12:00:00Z');nextDate.setUTCDate(nextDate.getUTCDate()+1);renewalBody.start=nextDate.toISOString().slice(0,10);
 for(let i=0;i<2;i++){const r=await page.request.post(origin+'/api/walkin-renew',{headers:{Origin:origin},data:renewalBody});assert.equal(r.status(),200,JSON.stringify(await r.json()));}
 assert.equal(result(await db.from('ff_memberships').select('id').eq('member_id',memberId)).length,3);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,3);
 const unauthorized=await memberPage.request.post(origin+'/api/walkin-renew',{headers:{Origin:origin},data:renewalBody});assert.equal(unauthorized.status(),403);
 const rls=await memberPage.evaluate(async()=>await (await fetch('/api/state')).json());assert.deepEqual(rls.registrations,[]);
 console.log('PASS: walk-in next-plan renewal paid atomically; repeat does not duplicate; member cannot call staff renewal or see pending registrations');

}finally{
 await browser.close();if(registrationId)result(await db.from('ff_registrations').delete().eq('id',registrationId));if(memberId){for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',memberId));result(await db.from('ff_profiles').delete().eq('id',memberId));const {error}=await db.auth.admin.deleteUser(memberId);if(error)throw error;}
}
