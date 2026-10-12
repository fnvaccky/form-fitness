import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {chromium} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
import {legacyRegistration} from './legacy-registration.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 10 end to end on the local stack: account-first Add member, the limited unpaid home, activation by
// cash or by PayMongo's verified signal, and deleting never-paid accounts by hand and by the daily job.
// PayMongo is mocked in memory (test mode); nothing leaves this machine. The daily job's switched-on run
// uses the demo workspace, and only when every account it would delete is one this suite made.
const run=randomBytes(4).toString('hex');
const env={...process.env,PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex'),
 GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:'',CRON_SECRET:randomBytes(24).toString('hex'),ACCOUNT_CLEANUP_ENABLED:'false'};
const db=serviceClient(env),users=[],legacyIds=[],passed=[];
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
// PayMongo, mocked: create, retrieve and expire checkout sessions.
const realFetch=globalThis.fetch,sessions=new Map();let count=0,expireCalls=0;
globalThis.fetch=async(url,options={})=>{
 if(!String(url).startsWith('https://api.paymongo.com/'))return realFetch(url,options);
 assert(options.headers.Authorization.startsWith('Basic '));
 const parts=String(url).split('/');
 if(String(url).endsWith('/expire')){
  expireCalls++;const s=sessions.get(parts.at(-2));
  if(s.attributes.status==='expired'||s.attributes.payments.some(p=>p.attributes.status==='paid'))return Response.json({errors:[{code:'parameter_invalid',detail:'Simulated refusal.'}]},{status:400});
  s.attributes.status='expired';return Response.json({data:s});
 }
 if(options.method==='POST'){
  const a=JSON.parse(options.body).data.attributes,id=`cs_Acc${run}${++count}`;
  const session={id,type:'checkout_session',attributes:{...a,livemode:false,status:'active',checkout_url:'https://checkout.paymongo.com/'+id,payments:[]}};
  sessions.set(id,session);return Response.json({data:session});
 }
 return Response.json({data:sessions.get(parts.at(-1))});
};
function pay(id,method='gcash'){const s=sessions.get(id),amount=s.attributes.line_items[0].amount;s.attributes.payments=[{id:'pay_'+id.slice(3),attributes:{status:'paid',amount,currency:'PHP',livemode:false,source:{type:method}}}];}
function webhook(origin,session,{bad=false}={}){
 const raw=JSON.stringify({data:{id:'evt_Acc'+run,attributes:{type:'checkout_session.payment.paid',livemode:false,data:session}}});
 const t=Math.floor(Date.now()/1000),signature=createHmac('sha256',env.PAYMONGO_WEBHOOK_SECRET).update(t+'.'+raw).digest('hex');
 return realFetch(origin+'/api/paymongo/webhook',{method:'POST',headers:{'Content-Type':'application/json','Paymongo-Signature':`t=${t},te=${bad?'0'.repeat(64):signature},li=`},body:raw});
}
// One in-process app per workspace; production also serves the pages for the browser checks.
const root=path.resolve('public');
function serve(workspace,files=false){
 let origin;
 const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/api/'))return handle(req,res,{...env,APP_WORKSPACE:workspace,APP_ORIGIN:origin});
  try{
   assert(files);const file=path.resolve(root,'.'+new URL(req.url,origin).pathname),target=file===root?path.join(root,'index.html'):file;assert(target.startsWith(root+path.sep));
   res.setHeader('Content-Type',target.endsWith('.js')?'application/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(target));
  }catch{res.statusCode=404;res.end();}
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve({server,origin});}));
}
function client(origin){
 let cookies='';
 const send=async(method,endpoint,body,status)=>{
  const response=await realFetch(origin+'/api'+endpoint,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookies?{Cookie:cookies}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const data=await response.json().catch(()=>({}));assert.equal(response.status,status,`${method} ${endpoint}: ${data.error||response.status}`);return data;
 };
 return {post:(endpoint,body,status=200)=>send('POST',endpoint,body,status),get:(endpoint,status=200)=>send('GET',endpoint,undefined,status)};
}
async function account(workspace,role){
 const email=`accounts-${role}-${randomUUID().slice(0,8)}@example.invalid`,password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:workspace,ff_role:role},user_metadata:{form_fitness:true,name:'LOCAL TEST Accounts '+role,phone:'09170000070'}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email,password};
}
async function addMember(api,label,extra={}){
 const added=await api.post('/members',{name:'LOCAL TEST '+label,email:`accounts-${label}-${randomUUID().slice(0,8)}@example.invalid`,phone:'09170000071',...extra},201);
 users.push(added.member.id);return {...added.member,invoiceId:added.invoiceId,setupEmailSent:added.setupEmailSent};
}
async function memberSession(origin,member){
 const password='Local9!'+randomBytes(24).toString('base64url');
 assert.ifError((await db.auth.admin.updateUserById(member.id,{password})).error);
 const api=client(origin);await api.post('/login',{email:member.email,password});return Object.assign(api,{password});
}
const exists=async id=>({auth:!!(await db.auth.admin.getUserById(id)).data?.user,profile:!!result(await db.from('ff_profiles').select('id').eq('id',id).maybeSingle())});
const rows=async(table,column,value)=>result(await db.from(table).select('*').eq(column,value));
const logFor=id=>rows('ff_account_cleanup_log','account_id',id);
const hash=email=>createHash('sha256').update(email.toLowerCase()).digest('hex');
const invoiceOf=async id=>result(await db.from('ff_invoices').select('amount_cents,paid_cents').eq('id',id).single());
const cash=(api,invoiceId,amountCents)=>api.post('/payments',{invoiceId,amount:amountCents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
async function checkoutFor(memberApi,invoiceId){
 const made=await memberApi.post('/paymongo/checkout',{kind:'invoice',invoiceId,method:'ewallet',requestId:randomUUID()});
 return result(await db.from('ff_checkouts').select('*').eq('id',made.checkout.id).single());
}
const NEVER_PAID='Only never-paid member accounts can be deleted.',PAID_LATE='A payment came in for this account at PayMongo. It was recorded, so the account was not deleted.';
let browser,prod,demo;
try{
 await mkdir('test-results',{recursive:true});
 prod=await serve('production',true);demo=await serve('demo');
 const admin=await account('production','admin'),staff=await account('production','staff');
 const adminApi=client(prod.origin),staffApi=client(prod.origin);
 await adminApi.post('/login',{email:admin.email,password:admin.password});await staffApi.post('/login',{email:staff.email,password:staff.password});

 const fresh=await addMember(staffApi,'no-plan');
 assert.equal(fresh.invoiceId,null);assert.equal(fresh.setupEmailSent,true);
 const freshUser=(await db.auth.admin.getUserById(fresh.id)).data.user;
 assert.deepEqual([freshUser.app_metadata.ff_role,freshUser.app_metadata.ff_workspace],['member','production']);
 assert.equal(result(await db.from('ff_profiles').select('role').eq('id',fresh.id).single()).role,'member');
 assert.equal((await rows('ff_memberships','member_id',fresh.id)).length,0);assert.equal((await rows('ff_invoices','member_id',fresh.id)).length,0);
 assert.equal((await rows('ff_registrations','email',fresh.email)).length,0);
 pass('Add member creates the account at once with no plan: an Auth user and a member profile, the setup email, and no cycle, invoice or registration');

 const freshApi=await memberSession(prod.origin,fresh);
 assert.match((await freshApi.get('/qr',400)).error,/^Check-in denied/);
 const chosen=await freshApi.post('/renew',{plan:'basic',start:today()});assert(chosen.invoiceId);
 assert.match((await freshApi.get('/qr',400)).error,/^Check-in denied/);
 const freshState=await freshApi.get('/state');
 assert.equal(freshState.members.find(m=>m.id===fresh.id).plan,'basic');assert.equal(freshState.unpaidAccounts,undefined,'Members never get the unpaid-accounts list');
 pass('A member gets no pass with no plan, or with a chosen plan that is not fully paid (check-in itself: tests/account-cleanup.sql)');

 await cash(staffApi,chosen.invoiceId,(await invoiceOf(chosen.invoiceId)).amount_cents);
 assert.match((await freshApi.get('/qr')).token,/^FORM2\./);
 pass('Plan + cash recorded at the desk activates the membership: the member pass works');

 const online=await addMember(staffApi,'online',{plan:'basic',start:today()});assert(online.invoiceId,'A plan chosen at the desk is an unpaid invoice');
 const onlineApi=await memberSession(prod.origin,online);
 const onlineRow=await checkoutFor(onlineApi,online.invoiceId);assert.equal(onlineRow.status,'pending');
 assert.equal((await onlineApi.post('/paymongo/status',{id:onlineRow.id})).checkout.status,'pending','Coming back from PayMongo without paying changes nothing');
 pay(onlineRow.session_id,'gcash');
 assert.equal((await webhook(prod.origin,sessions.get(onlineRow.session_id),{bad:true})).status,401);
 assert.equal((await invoiceOf(online.invoiceId)).paid_cents,0,'A forged webhook changes nothing');
 assert.match((await onlineApi.get('/qr',400)).error,/^Check-in denied/);
 assert.equal((await webhook(prod.origin,sessions.get(onlineRow.session_id))).status,200);
 const onlineInvoice=await invoiceOf(online.invoiceId);assert.equal(onlineInvoice.paid_cents,onlineInvoice.amount_cents);
 assert.equal((await rows('ff_payments','member_id',online.id)).length,1);
 assert.match((await onlineApi.get('/qr')).token,/^FORM2\./);
 pass('Plan + online payment activates only on PayMongo\'s verified signal: a return visit or a forged webhook changes nothing; the signed webhook settles it and the pass works');

 const target=await addMember(staffApi,'delete-me',{plan:'basic',start:today()});
 assert.equal((await staffApi.post('/members/delete-unpaid',{id:target.id},403)).error,'Administrator access is required.');
 assert.equal((await staffApi.get('/state')).unpaidAccounts,undefined);
 const cron=(origin,headers={},method='GET')=>realFetch(origin+'/api/cron/account-cleanup',{method,headers});
 assert.equal((await cron(prod.origin)).status,401);
 assert.equal((await cron(prod.origin,{Authorization:'Bearer '+'x'.repeat(48)})).status,401);
 assert.equal((await cron(prod.origin,{Authorization:'Bearer '+env.CRON_SECRET},'POST')).status,405);
 assert.deepEqual(await exists(target.id),{auth:true,profile:true});
 pass('Staff cannot delete accounts or see the list, and the daily job refuses anyone without its secret');

 const listed=(await adminApi.get('/state')).unpaidAccounts,entry=listed.find(a=>a.id===target.id);
 assert(entry,'The never-paid account is listed');assert.equal(entry.ageDays,0);assert.equal(entry.hasPlan,true);assert.deepEqual(entry.openCheckouts,[]);
 for(const id of [fresh.id,online.id,admin.id,staff.id])assert(!listed.some(a=>a.id===id),'Accounts that paid, staff and administrators are never listed');
 const removed=await adminApi.post('/members/delete-unpaid',{id:target.id});
 assert.deepEqual(removed,{deleted:target.id,checkoutsExpired:0,message:'Account deleted. The email can be used again.'});
 assert.deepEqual(await exists(target.id),{auth:false,profile:false});
 assert.equal((await rows('ff_invoices','member_id',target.id)).length,0);assert.equal((await rows('ff_memberships','member_id',target.id)).length,0);
 const [entryLog,...extraLog]=await logFor(target.id);assert.equal(extraLog.length,0);
 assert.deepEqual({actor:entryLog.actor,by:entryLog.deleted_by,workspace:entryLog.workspace,hash:entryLog.email_hash,age:entryLog.age_days,reason:entryLog.reason,invoices:entryLog.details.invoices,cycles:entryLog.details.cycles},
  {actor:'admin',by:admin.id,workspace:'production',hash:hash(target.email),age:0,reason:'Deleted by an administrator (force clean-up).',invoices:1,cycles:1});
 assert(!JSON.stringify(entryLog).includes(target.email),'The log keeps only a hash of the email');
 pass('An administrator deletes a never-paid account: the Auth user, profile, unpaid cycle and invoice go, and one log row records who, when, the age and an email hash');

 const again=await addMember(staffApi,'again',{email:target.email});
 assert.notEqual(again.id,target.id);assert.equal(again.email,target.email);
 pass('The deleted account\'s email can be registered again straight away');

 const day=offset=>new Date(Date.now()+8*3600000+offset*86400000).toISOString().slice(0,10);
 result(await db.from('ff_memberships').update({start_date:day(-60),end_date:day(-31)}).eq('member_id',fresh.id));
 assert.match((await freshApi.get('/qr',400)).error,/^Check-in denied/,'The paid cycle has ended');
 assert.equal((await adminApi.post('/members/delete-unpaid',{id:fresh.id},403)).error,NEVER_PAID+' This one has a payment on record, so it can only be disabled.');
 assert.deepEqual(await exists(fresh.id),{auth:true,profile:true});
 pass('A member who paid once, with that cycle since expired, cannot be deleted: "Only never-paid member accounts can be deleted…"');

 for(const person of [staff,admin])assert.equal((await adminApi.post('/members/delete-unpaid',{id:person.id},403)).error,NEVER_PAID+' Staff and administrator accounts can only be disabled.');
 pass('Staff and administrator accounts cannot be deleted, only disabled');

 const late=await addMember(staffApi,'late-payer',{plan:'basic',start:today()});
 const lateRow=await checkoutFor(await memberSession(prod.origin,late),late.invoiceId);
 assert.equal((await adminApi.get('/state')).unpaidAccounts.find(a=>a.id===late.id).openCheckouts.length,1);
 pay(lateRow.session_id,'gcash');
 assert.equal((await adminApi.post('/members/delete-unpaid',{id:late.id},409)).error,PAID_LATE);
 assert.deepEqual(await exists(late.id),{auth:true,profile:true});
 assert.equal((await rows('ff_payments','member_id',late.id)).length,1);
 assert.equal(result(await db.from('ff_checkouts').select('status').eq('id',lateRow.id).single()).status,'paid');
 assert.equal((await logFor(late.id)).length,0);assert(!(await adminApi.get('/state')).unpaidAccounts.some(a=>a.id===late.id));
 pass('An open checkout that turns out paid at PayMongo is settled, and the delete is refused');

 const open=await addMember(staffApi,'open-checkout',{plan:'basic',start:today()});
 const openRow=await checkoutFor(await memberSession(prod.origin,open),open.invoiceId),expiresBefore=expireCalls;
 const cleared=await adminApi.post('/members/delete-unpaid',{id:open.id});
 assert.equal(cleared.checkoutsExpired,1);assert.equal(expireCalls,expiresBefore+1);assert.equal(sessions.get(openRow.session_id).attributes.status,'expired');
 assert.deepEqual(await exists(open.id),{auth:false,profile:false});
 const kept=result(await db.from('ff_checkouts').select('*').eq('id',openRow.id).single());
 assert.deepEqual({status:kept.status,member:kept.member_id,invoice:kept.invoice_id,creator:kept.created_by,detached:!!kept.detached_at},{status:'expired',member:null,invoice:null,creator:null,detached:true});
 assert.deepEqual(kept.review_log.slice(-2).map(e=>e.action),['cancel','detach']);
 const [openLog]=await logFor(open.id);assert.equal(openLog.details.checkoutsExpired,1);assert.equal(openLog.details.checkoutsDetached,1);
 pass('An unpaid open checkout is expired at PayMongo before the delete; the checkout row stays as history, detached from the account');

 const legacy=await legacyRegistration(staff,{name:'LOCAL TEST Legacy',email:`accounts-legacy-${randomUUID().slice(0,8)}@example.invalid`,phone:'09170000072',plan:'basic',start:today(),requestId:randomUUID()});
 legacyIds.push(legacy.registration.id);
 const finished=await staffApi.post('/registration-payment',{id:legacy.registration.id,amount:legacy.registration.amount_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID()});
 assert.equal(finished.accountReady,true);users.push(finished.registration.member_id);
 assert.equal((await adminApi.post('/members/delete-unpaid',{id:finished.registration.member_id},403)).error,NEVER_PAID+' This one has a payment on record, so it can only be disabled.');
 pass('An older pending registration still finishes through the first-payment path, and that member can never be deleted');

 // The daily job, on the demo workspace.
 const demoAdmin=await account('demo','admin'),demoApi=client(demo.origin);
 await demoApi.post('/login',{email:demoAdmin.email,password:demoAdmin.password});
 const withPlan={plan:'basic',start:today()};
 const oldPlain=await addMember(demoApi,'old-plain'),oldOpen=await addMember(demoApi,'old-open',withPlan),oldLate=await addMember(demoApi,'old-late',withPlan);
 const sixDays=await addMember(demoApi,'six-days'),young=await addMember(demoApi,'young'),oldPaid=await addMember(demoApi,'old-paid',withPlan);
 const oldOpenRow=await checkoutFor(await memberSession(demo.origin,oldOpen),oldOpen.invoiceId);
 const oldLateRow=await checkoutFor(await memberSession(demo.origin,oldLate),oldLate.invoiceId);pay(oldLateRow.session_id,'gcash');
 await cash(demoApi,oldPaid.invoiceId,(await invoiceOf(oldPaid.invoiceId)).amount_cents);
 const backdate=async(member,days)=>result(await db.from('ff_profiles').update({created_at:new Date(Date.now()-days*86400000-60000).toISOString()}).eq('id',member.id));
 for(const member of [oldPlain,oldOpen,oldLate,oldPaid])await backdate(member,8);
 await backdate(sixDays,6);
 // Guard: the switched-on run below deletes every due demo account, so stop unless they are all this suite's.
 const due=result(await db.rpc('ff_account_cleanup_auto',{action:'due',body:{workspace:'demo'}})).map(a=>a.id).sort();
 assert.deepEqual(due,[oldPlain.id,oldOpen.id,oldLate.id].sort(),'Only this suite\'s never-paid demo accounts older than 7 days may be due. Stopping before the job is switched on.');
 const job=async()=>(await realFetch(demo.origin+'/api/cron/account-cleanup',{headers:{Authorization:'Bearer '+env.CRON_SECRET}})).json();
 assert.deepEqual(await job(),{enabled:false,due:3,deleted:0,message:'Automatic clean-up is turned off.'});
 for(const member of [oldPlain,oldOpen,oldLate])assert.deepEqual(await exists(member.id),{auth:true,profile:true},'Switched off, the job deletes nothing');
 assert.equal(sessions.get(oldOpenRow.session_id).attributes.status,'active','Switched off, the job touches no checkout');
 env.ACCOUNT_CLEANUP_ENABLED='true';let outcome;
 try{outcome=await job();}finally{env.ACCOUNT_CLEANUP_ENABLED='false';}
 assert.deepEqual(outcome,{enabled:true,due:3,deleted:2,kept:[{id:oldLate.id,reason:PAID_LATE}]});
 for(const member of [oldPlain,oldOpen])assert.deepEqual(await exists(member.id),{auth:false,profile:false});
 for(const member of [oldLate,sixDays,young,oldPaid])assert.deepEqual(await exists(member.id),{auth:true,profile:true});
 assert.equal(sessions.get(oldOpenRow.session_id).attributes.status,'expired');
 assert.equal((await rows('ff_payments','member_id',oldLate.id)).length,1,'The late online payment was recorded');
 for(const member of [oldPlain,oldOpen]){
  const [row]=await logFor(member.id);
  assert.deepEqual({actor:row.actor,by:row.deleted_by,reason:row.reason,hash:row.email_hash,workspace:row.workspace},{actor:'automatic',by:null,reason:'Never paid within 7 days (automatic clean-up).',hash:hash(member.email),workspace:'demo'});
  assert(row.age_days>=8);
 }
 const refusedYoung=await db.rpc('ff_account_cleanup_auto',{action:'delete',body:{workspace:'demo',id:young.id,expired:[]}});
 assert.equal(refusedYoung.error?.message,'This account is newer than 7 days, so automatic clean-up leaves it.');
 const refusedPaid=await db.rpc('ff_account_cleanup_auto',{action:'delete',body:{workspace:'demo',id:oldPaid.id,expired:[]}});
 assert(refusedPaid.error?.message.startsWith(NEVER_PAID),refusedPaid.error?.message);
 pass('The daily job: switched off it deletes nothing; switched on it deletes never-paid accounts older than 7 days, expires their open checkouts, keeps one whose checkout turns out paid, and leaves younger or paid accounts');

 // In the browser: the unpaid member's home, and the administrators' Unpaid accounts tab.
 browser=await chromium.launch({channel:'msedge',headless:true});const pageErrors=[];
 const signIn=async(person,viewport={width:1440,height:1000})=>{
  const page=await (await browser.newContext({viewport})).newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(prod.origin);
  await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);return page;
 };
 // Screenshots wait for fade-ins and slides to finish.
 const shot=async(page,name,fullPage=true)=>{await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`test-results/${name}.png`,fullPage});};
 const basic=result(await db.from('ff_plans').select('name').eq('workspace','production').eq('id','basic').single());
 const shopper=await addMember(staffApi,'browser'),shopperApi=await memberSession(prod.origin,shopper);
 const home=await signIn({email:shopper.email,password:shopperApi.password});
 await home.getByText('Choose a plan to start your membership.',{exact:true}).waitFor();
 assert.equal(await home.getByRole('button',{name:'Show my member QR',exact:true}).count(),0);
 await shot(home,'accounts-member-no-plan');
 await home.getByRole('button',{name:'Select '+basic.name,exact:true}).click();
 await home.locator('#modal-title').filter({hasText:'Start your membership'}).waitFor();
 await home.locator('#renew-form input[type="checkbox"]').check();
 const renewing=home.waitForResponse(r=>r.url().endsWith('/api/renew'));
 await home.getByRole('button',{name:'Create invoice',exact:true}).click();assert.equal((await renewing).status(),200);
 await home.getByRole('link',{name:'My overview',exact:true}).click();
 await home.locator('.member-pass-bar').filter({hasText:'Your membership starts after full payment'}).waitFor();
 assert.equal(await home.getByRole('button',{name:'Show my member QR',exact:true}).count(),0);
 await shot(home,'accounts-member-unpaid');
 const phone=await signIn({email:shopper.email,password:shopperApi.password},{width:390,height:844});
 await phone.locator('.member-pass-bar').filter({hasText:'Your membership starts after full payment'}).waitFor();await shot(phone,'accounts-member-unpaid-mobile');
 await home.getByRole('button',{name:'Pay now',exact:true}).click();
 await home.locator('#modal-title').filter({hasText:'Pay your membership'}).waitFor();
 assert.deepEqual(await home.locator('#invoice-channel option:not(:disabled)').evaluateAll(options=>options.map(o=>o.value)),['gcash','paymaya','grab_pay','card']);
 await shot(home,'accounts-member-pay',false);await home.keyboard.press('Escape');
 pass('Browser: a member with no plan sees "Choose a plan", picks one, then sees Pay now (PayMongo, or cash at the desk) and no member pass');

 // Admin screens render members who have no plan yet: the overview, and the roster's "No plan".
 const adminPage=await signIn(admin);await adminPage.locator('.stats-grid').first().waitFor();await adminPage.evaluate(()=>navigate('members'));
 const noPlanRow=adminPage.locator('tr',{hasText:again.email});await noPlanRow.waitFor();assert.match(await noPlanRow.innerText(),/No plan/);
 await adminPage.locator('[data-action="member-tab"][data-tab="unpaid"]').click();
 const row=adminPage.locator(`tr[data-unpaid="${shopper.id}"]`);await row.waitFor();
 assert.match(await row.innerText(),/Today/);assert.match(await row.innerText(),/Yes, unpaid/);
 await shot(adminPage,'accounts-admin-unpaid-tab');
 await row.getByRole('button',{name:'Delete unpaid account',exact:true}).click();
 await adminPage.locator('.modal').getByText('This permanently deletes the account and frees the email. Only accounts that have never paid can be deleted.',{exact:true}).waitFor();
 assert.deepEqual(await exists(shopper.id),{auth:true,profile:true},'Nothing happens before confirming');
 await shot(adminPage,'accounts-admin-delete-confirm',false);
 const deleting=adminPage.waitForResponse(r=>r.url().endsWith('/api/members/delete-unpaid'));
 await adminPage.locator('.modal').getByRole('button',{name:'Delete unpaid account',exact:true}).click();assert.equal((await deleting).status(),200);
 await adminPage.locator('#toast.show').filter({hasText:'Account deleted. The email can be used again.'}).waitFor();
 await row.waitFor({state:'detached'});assert.deepEqual(await exists(shopper.id),{auth:false,profile:false});
 const staffPage=await signIn(staff);await staffPage.evaluate(()=>navigate('members'));
 await staffPage.locator('[data-action="member-tab"][data-tab="roster"]').waitFor();
 assert.equal(await staffPage.locator('[data-tab="unpaid"]').count(),0);assert.equal(await staffPage.getByRole('button',{name:'Delete unpaid account'}).count(),0);
 assert.deepEqual(pageErrors,[],'No JavaScript errors on any page');
 pass('Browser: administrators get the Unpaid accounts tab with each account\'s age and a confirmed Delete unpaid account; staff get neither');
 console.log(`PASS: ${passed.length} account-first and clean-up checks`);
}finally{
 if(browser)await browser.close();globalThis.fetch=realFetch;prod?.server.close();demo?.server.close();
 // Only rows this suite made. Clean-up log rows stay: the log is append-only, here too.
 result(await db.from('ff_checkouts').delete().like('session_id',`cs_Acc${run}%`));
 for(const id of legacyIds)result(await db.from('ff_registrations').delete().eq('id',id));
 // Every member's rows first: their payments name the staff fixtures as recorders.
 for(const id of users){
  result(await db.from('ff_checkouts').delete().eq('member_id',id));
  for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));
 }
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
}
