import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
// Task 10, account first, in the browser against the running dev server: staff add a member with a plan
// at the desk and the account exists at once; the member signs in from the setup email to a limited home
// with no pass; staff record the cash and the pass works. Walk-in renewals follow, as before.
const host=new URL(process.env.SUPABASE_URL).hostname;
assert(['localhost','127.0.0.1'].includes(host),'Local tests only');
const origin=process.env.APP_ORIGIN;
const accounts=JSON.parse(await readFile('.local/local-test-credentials.json','utf8')).accounts;
const staff=accounts.find(a=>a.role==='staff');
const db=serviceClient();const plan=result(await db.from('ff_plans').select('*').eq('workspace','production').eq('id','basic').single());
const browser=await chromium.launch({channel:'msedge',headless:true});let memberId;
async function mailFor(email){
 for(let i=0;i<30;i++){
  const list=await (await fetch('http://127.0.0.1:54324/api/v1/messages?limit=50')).json();
  for(const item of list.messages||[])if(JSON.stringify(item.To).toLowerCase().includes(email))return (await fetch('http://127.0.0.1:54324/api/v1/message/'+item.ID)).json();
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 return null;
}
try{
 await mkdir('test-results',{recursive:true});
 const page=await browser.newPage();await page.goto(origin);
 await page.getByLabel('Email address',{exact:true}).fill(staff.email);await page.getByLabel('Password',{exact:true}).fill(staff.password);await page.getByRole('button',{name:'Log in',exact:true}).click();
 await page.getByRole('button',{name:'Add member',exact:true}).click();
 const email=`local-onboarding-${randomUUID().slice(0,8)}@example.invalid`;
 await page.getByLabel('Full name *',{exact:true}).fill('LOCAL TEST Onboarding');await page.getByLabel('Email address *',{exact:true}).fill(email);
 await page.getByLabel('Mobile number *',{exact:true}).fill('09170000008');
 // Task 11: staff fill in the member's fitness survey at the desk, so the member isn't asked for it at first login.
 await page.getByText('Fitness survey (optional — the member can do it at first login)',{exact:true}).click();
 await page.locator('#desk-goal').selectOption('Build strength');await page.locator('#desk-experience').selectOption('beginner');await page.locator('#desk-strength').check();await page.locator('#desk-mon').check();
 assert.equal(await page.locator('#member-start').isDisabled(),true,'No start date without a plan');
 await page.locator('#member-plan').selectOption('basic');
 assert.equal(await page.locator('#member-start').isDisabled(),false);assert.equal(await page.locator('#member-start').inputValue(),today());
 await page.screenshot({path:'test-results/onboarding-add-member.png'});
 const creating=page.waitForResponse(r=>r.url().endsWith('/api/members')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Create account',exact:true}).click();
 const createdResponse=await creating,added=await createdResponse.json();assert.equal(createdResponse.status(),201,added.error);memberId=added.member.id;
 await page.locator('#modal-title').filter({hasText:'Member account created'}).waitFor();
 const user=(await db.auth.admin.getUserById(memberId)).data.user;assert.equal(user.email,email);assert.equal(user.app_metadata.ff_role,'member');
 const invoice=result(await db.from('ff_invoices').select('*').eq('member_id',memberId).single());
 assert.equal(invoice.id,added.invoiceId);assert.equal(invoice.paid_cents,0);assert.equal(invoice.amount_cents,plan.price_cents);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,0);
 assert.equal(result(await db.from('ff_registrations').select('id').eq('email',email)).length,0,'No first registration any more');
 const survey=result(await db.from('ff_member_surveys').select('*').eq('id',memberId).single());
 assert.deepEqual([survey.experience,survey.exercises,survey.available_days],['beginner',['strength'],['mon']],'the desk survey is saved with the account');
 assert.equal(result(await db.from('ff_profiles').select('goal').eq('id',memberId).single()).goal,'Build strength');
 console.log('PASS: Add member creates the account at once, with the fitness survey filled in at the desk; the plan chosen at the desk is an unpaid invoice, with no payment and no registration');
 const mail=await mailFor(email);assert(mail,'Setup email captured locally');
 const match=mail.HTML.match(/href="([^"]*token_hash=[^"]+)"/);assert(match,'Token-hash setup link');const link=match[1].replaceAll('&amp;','&');assert(link.startsWith(origin+'/api/auth/callback?'));
 const memberPage=await browser.newPage();await memberPage.goto(link);await memberPage.getByLabel('New password *',{exact:true}).fill('LocalOnboarding2026!');await memberPage.getByRole('button',{name:'Save password',exact:true}).click();
 const bar=memberPage.locator('.member-pass-bar');await bar.waitFor();
 assert.equal(await memberPage.locator('.survey-first').count(),0,'a desk-filled survey means no survey screen at first login');
 assert.match(await bar.innerText(),/Your membership starts after full payment/);
 assert.equal(await memberPage.getByRole('button',{name:'Show my member QR',exact:true}).count(),0,'No pass button before payment');
 assert.equal(await memberPage.getByRole('button',{name:'Pay now',exact:true}).count(),1);
 const refused=await memberPage.evaluate(async()=>{const r=await fetch('/api/qr');return {status:r.status,body:await r.json()};});
 assert.equal(refused.status,400);assert.match(refused.body.error,/^Check-in denied/);
 await memberPage.screenshot({path:'test-results/onboarding-unpaid-home.png'});
 console.log('PASS: the setup email signs the member in to a limited home: Pay now, no member pass, and the pass API refuses');
 await page.getByRole('button',{name:'Record cash payment',exact:true}).click();
 await page.locator('#funds-verified').check();
 const paying=page.waitForResponse(r=>r.url().endsWith('/api/payments')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Confirm payment',exact:true}).click();
 const paidResponse=await paying;assert.equal(paidResponse.status(),200,(await paidResponse.json()).error);
 await page.locator('#modal-title').filter({hasText:'Payment confirmed'}).waitFor();await page.keyboard.press('Escape');await page.locator('.modal-backdrop').waitFor({state:'detached'});
 assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',invoice.id).single()).paid_cents,plan.price_cents);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,1);
 await memberPage.reload();
 await memberPage.getByRole('link',{name:'My membership',exact:true}).click();await memberPage.locator('.membership-privileges').waitFor();assert((await memberPage.locator('.membership-privileges').innerText()).includes(plan.features[0]));
 await memberPage.getByRole('link',{name:'My overview',exact:true}).click();await memberPage.getByRole('button',{name:'Show my member QR',exact:true}).click();await memberPage.locator('#member-qr-canvas').waitFor();assert.equal(await memberPage.locator('#member-qr-canvas').count(),1);await memberPage.keyboard.press('Escape');
 await memberPage.screenshot({path:'test-results/onboarding-paid-pass.png'});
 console.log('PASS: cash recorded at the desk activates the plan: the member sees their privileges and a live pass');
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
 const rls=await memberPage.evaluate(async()=>await (await fetch('/api/state')).json());assert.deepEqual(rls.registrations,[]);assert.equal(rls.unpaidAccounts,undefined);
 console.log('PASS: walk-in next-plan renewal paid atomically; repeat does not duplicate; member cannot call staff renewal or see pending registrations or unpaid accounts');
}finally{
 await browser.close();
 if(memberId){for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',memberId));result(await db.from('ff_profiles').delete().eq('id',memberId));const {error}=await db.auth.admin.deleteUser(memberId);if(error)throw error;}
}
