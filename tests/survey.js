import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 11 end to end on the local stack: the fitness survey required at first login (screen and API), plan
// selection after it, a paid member who keeps using the app while the survey waits, the desk survey in Add member,
// staff read-only, and Task 10's clean-up removing a never-paid account's survey. No PayMongo call is made (the survey check refuses first). Every fixture is removed afterwards.
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:'',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex')};
const db=serviceClient(env),users=[],passed=[];
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const root=path.resolve('public');
function serve(){
 let origin;
 const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/api/'))return handle(req,res,{...env,APP_WORKSPACE:'production',APP_ORIGIN:origin});
  try{
   const file=path.resolve(root,'.'+new URL(req.url,origin).pathname),target=file===root?path.join(root,'index.html'):file;assert(target.startsWith(root+path.sep));
   res.setHeader('Content-Type',target.endsWith('.js')?'application/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(target));
  }catch{res.statusCode=404;res.end();}
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve({server,origin});}));
}
function client(origin){
 let cookies='';
 const send=async(method,endpoint,body,status)=>{
  const response=await fetch(origin+'/api'+endpoint,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookies?{Cookie:cookies}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const data=await response.json().catch(()=>({}));assert.equal(response.status,status,`${method} ${endpoint}: ${data.error||response.status}`);return data;
 };
 return {post:(e,b,s=200)=>send('POST',e,b,s),get:(e,s=200)=>send('GET',e,undefined,s)};
}
async function account(role){
 const email=`survey-${role}-${randomUUID().slice(0,8)}@example.invalid`,password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:role},user_metadata:{form_fitness:true,name:'LOCAL TEST Survey '+role,phone:'09170000030'}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email,password};
}
// Members are made the real way, with Add member; extra may carry a desk survey.
async function addMember(staffApi,label,extra={}){
 const added=await staffApi.post('/members',{name:`Survey${label} Member`,email:`survey-${label.toLowerCase()}-${randomUUID().slice(0,8)}@example.invalid`,phone:'09170000031',...extra},201);
 users.push(added.member.id);
 const password='Local9!'+randomBytes(24).toString('base64url');
 assert.ifError((await db.auth.admin.updateUserById(added.member.id,{password})).error);
 return {...added.member,password};
}
const answers={goal:'Build strength',experience:'returning',exercises:['strength','cardio'],availableDays:['mon','fri']};
const deskSurvey={experience:'beginner',exercises:['cardio'],availableDays:['sat']};
let browser,app;
try{
 await mkdir('test-results',{recursive:true});
 app=await serve();
 const admin=await account('admin'),staff=await account('staff');
 const staffApi=client(app.origin),adminApi=client(app.origin);
 await staffApi.post('/login',{email:staff.email,password:staff.password});await adminApi.post('/login',{email:admin.email,password:admin.password});
 const start=today();

 // API: until the survey is saved, no plan selection and no online checkout; staff are never blocked.
 const fresh=await addMember(staffApi,'Fresh'),freshApi=client(app.origin);await freshApi.post('/login',{email:fresh.email,password:fresh.password});
 assert.equal((await freshApi.get('/state')).members[0].survey,null,'no survey yet');
 assert.equal((await freshApi.post('/renew',{plan:'basic',start},403)).error,'Complete your fitness survey first.');
 assert.equal((await freshApi.post('/paymongo/checkout',{kind:'invoice',invoiceId:randomUUID(),method:'gcash',requestId:randomUUID()},403)).error,'Complete your fitness survey first.');
 assert.equal(result(await db.from('ff_invoices').select('id').eq('member_id',fresh.id)).length,0,'nothing was created');
 const other=await addMember(staffApi,'Walkin');
 assert((await staffApi.post('/renew',{memberId:other.id,plan:'basic',start})).invoiceId,'staff choose a plan for a member who has no survey yet');
 pass('API: until the survey is saved, a member gets 403 on plan selection and online checkout and nothing is created; staff are never blocked');

 // Browser: first login shows only the survey; after saving, thanks and plan selection, where the member starts.
 browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[];
 const signIn=async(person,viewport={width:1440,height:1000})=>{
  const page=await (await browser.newContext({viewport})).newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);return page;
 };
 for(const [label,member,viewport] of [['desktop',fresh,{width:1440,height:1000}],['phone',await addMember(staffApi,'Phone'),{width:390,height:844}]]){
  const page=await signIn(member,viewport);
  await page.getByRole('heading',{name:/^Welcome, Survey(Fresh|Phone)\.$/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('link',{name:'My overview',exact:true}).count(),0,`${label}: nothing else until the survey is saved`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${label}: no sideways scroll`);
  await page.screenshot({path:`test-results/survey-first-login-${label}.png`,fullPage:true});
  await page.getByLabel('What is your main goal?',{exact:true}).selectOption(answers.goal);
  await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption(answers.experience);
  await page.getByLabel('Strength training',{exact:true}).check();await page.getByLabel('Cardio',{exact:true}).check();
  await page.getByLabel('Monday',{exact:true}).check();await page.getByLabel('Friday',{exact:true}).check();
  await page.getByRole('button',{name:'Save my answers',exact:true}).click();
  await page.locator('.survey-thanks').filter({hasText:'Thanks! Choose your plan next.'}).waitFor();
  const saved=result(await db.from('ff_member_surveys').select('*').eq('id',member.id).single());
  assert.deepEqual([saved.experience,saved.exercises,saved.available_days],['returning',['strength','cardio'],['mon','fri']]);
  assert.equal(result(await db.from('ff_profiles').select('goal').eq('id',member.id).single()).goal,'Build strength');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${label}: plan selection fits`);
  await page.screenshot({path:`test-results/survey-plan-selection-${label}.png`,fullPage:true});
  await page.getByRole('button',{name:'Select Essential',exact:true}).click();
  await page.locator('#modal-title').filter({hasText:'Start your membership'}).waitFor();await page.locator('#renew-form input[type="checkbox"]').check();
  const renewing=page.waitForResponse(r=>r.url().endsWith('/api/renew'));
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();assert.equal((await renewing).status(),200,`${label}: the plan selection goes through once the survey is saved`);
  assert.equal(result(await db.from('ff_invoices').select('id').eq('member_id',member.id)).length,1,`${label}: the member chose a plan`);
  await page.close();
 }
 pass('Browser, desktop and phone: first login shows only the survey (with Sign out); after saving, "Thanks! Choose your plan next." and plan selection, where the member creates their first invoice');

 // A member with a paid cycle and no survey isn't stopped: a card asks for it, and the pass, its code, the check-in
 // confirmation and My visits all work. Choosing the next plan waits for the survey, and the renew screen says why.
 const paid=await addMember(staffApi,'Paid',{plan:'basic',start});
 const paidInvoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',paid.id).single());
 await staffApi.post('/payments',{invoiceId:paidInvoice.id,amount:paidInvoice.amount_cents/100,method:'Cash',verified:true,date:start,idempotencyKey:randomUUID()});
 const card='Complete your fitness profile — it takes a minute and helps us recommend the right plan.';
 const paidPage=await signIn(paid);
 await paidPage.locator('.survey-card').filter({hasText:card}).waitFor();
 assert.equal(await paidPage.locator('.survey-first').count(),0,'a paid member is not stopped by the survey');
 assert.equal(await paidPage.locator('.page-heading + .survey-card, .survey-card + .member-pass-bar').count()>0,true,'the card is at the top of the overview');
 await paidPage.screenshot({path:'test-results/survey-paid-overview-desktop.png',fullPage:true,animations:'disabled'});
 const issued=paidPage.waitForResponse(r=>r.url().endsWith('/api/qr'));
 await paidPage.getByRole('button',{name:'Show my member QR',exact:true}).click();
 const memberPass=await (await issued).json();
 await paidPage.locator('#pass-code').filter({hasText:memberPass.code}).waitFor();
 const scanned=await staffApi.post('/scan',{code:memberPass.code.toLowerCase().replace('-','')});
 assert.equal(scanned.member.id,paid.id,'staff find the member by the pass code');
 await staffApi.post('/check-in',{token:scanned.token,confirmed:true});
 await paidPage.locator('.checked-in').filter({hasText:/Checked in — \d{1,2}:\d\d [AP]M/}).waitFor({timeout:5000});
 const paidApi=client(app.origin);await paidApi.post('/login',{email:paid.email,password:paid.password});
 assert.equal((await paidApi.get('/checkin-status')).checkedIn,true,'the check-in status works');
 await paidPage.getByRole('button',{name:'Close',exact:true}).click();
 await paidPage.locator('.my-visits').filter({hasText:'This month: 1 visit'}).waitFor();
 await paidPage.getByRole('link',{name:'My membership',exact:true}).click();
 await paidPage.locator('.survey-card').filter({hasText:card}).waitFor();
 assert.equal(await paidPage.locator('.survey-card + .member-hero').count(),1,'the card is at the top of My membership');
 await paidPage.locator('[data-action="select-plan"][data-plan="basic"]').click();
 await paidPage.locator('.survey-renew-note').filter({hasText:'Choosing your next plan comes after your fitness profile.'}).waitFor();
 assert.equal(await paidPage.locator('[form="renew-form"][type="submit"]').isDisabled(),true,'the renew button waits for the survey');
 await paidPage.screenshot({path:'test-results/survey-paid-renew-note.png',animations:'disabled'});
 assert.equal((await paidApi.post('/renew',{plan:'basic',start:result(await db.from('ff_memberships').select('end_date').eq('member_id',paid.id).single()).end_date},403)).error,'Complete your fitness survey first.','the API still refuses renewal');
 await paidPage.getByRole('link',{name:'Complete your fitness profile',exact:true}).click();
 await paidPage.locator('#member-survey-form').waitFor();
 await paidPage.getByLabel('How familiar are you with training?',{exact:true}).selectOption('regular');
 await paidPage.getByLabel('Cardio',{exact:true}).check();await paidPage.getByLabel('Sunday',{exact:true}).check();
 await paidPage.getByRole('button',{name:'Save my answers',exact:true}).click();
 await paidPage.getByRole('button',{name:'Edit answers',exact:true}).waitFor();
 assert.equal(await paidPage.locator('.survey-card').count(),0,'the card goes once the survey is saved');
 await paidPage.locator('[data-action="select-plan"][data-plan="basic"]').click();
 assert.equal(await paidPage.locator('.survey-renew-note').count(),0);
 assert.equal(await paidPage.locator('[form="renew-form"][type="submit"]').isDisabled(),false,'now the next plan can be chosen');
 await paidPage.close();
 const phone=await signIn(await (async()=>{const m=await addMember(staffApi,'PaidPhone',{plan:'basic',start});const i=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',m.id).single());
  await staffApi.post('/payments',{invoiceId:i.id,amount:i.amount_cents/100,method:'Cash',verified:true,date:start,idempotencyKey:randomUUID()});return m;})(),{width:390,height:844});
 await phone.locator('.survey-card').filter({hasText:card}).waitFor();
 assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the card fits a phone');
 const box=await phone.locator('.survey-card .button').boundingBox();assert(box.width>=200,'a full-width button on a phone');
 await phone.screenshot({path:'test-results/survey-paid-overview-phone.png',fullPage:true,animations:'disabled'});
 await phone.close();
 pass('A paid member without a survey is not stopped: the card sits at the top of the overview and My membership (desktop and phone); the pass, its code, the check-in confirmation, check-in status and My visits work; the renew screen explains and the API refuses renewal until the survey is saved from the card');

 // A member without a paid cycle is fully blocked, even with an unpaid plan chosen at the desk.
 const unpaid=await addMember(staffApi,'Unpaid',{plan:'basic',start});
 const unpaidPage=await signIn(unpaid);
 await unpaidPage.locator('.survey-first').waitFor();
 assert.equal(await unpaidPage.locator('.survey-card').count(),0,'no card: the whole screen is the survey');
 assert.equal(await unpaidPage.getByRole('button',{name:/Pay now|Show my member QR/}).count(),0,'nothing else until the survey is saved');
 const unpaidApi=client(app.origin);await unpaidApi.post('/login',{email:unpaid.email,password:unpaid.password});
 assert.equal((await unpaidApi.post('/paymongo/checkout',{kind:'invoice',invoiceId:result(await db.from('ff_invoices').select('id').eq('member_id',unpaid.id).single()).id,method:'gcash',requestId:randomUUID()},403)).error,'Complete your fitness survey first.');
 await unpaidPage.close();
 pass('A member without a paid cycle is fully blocked: only the survey on screen, and no checkout through the API');

 // At the desk: a survey filled in with the member means no prompt; staff read it and can't change it.
 const desk=await addMember(staffApi,'Desk',{goal:'Manage weight',survey:deskSurvey});
 const deskPage=await signIn(desk);
 await deskPage.getByText('Choose a plan to start your membership.',{exact:true}).waitFor();
 assert.equal(await deskPage.locator('.survey-first').count(),0,'a desk-filled survey: no prompt at first login');
 await deskPage.getByRole('link',{name:'My membership',exact:true}).click();
 await deskPage.getByRole('heading',{name:'Your fitness profile',exact:true}).waitFor();
 assert.match(await deskPage.locator('#fitness-survey').innerText(),/Manage weight[\s\S]*I’m new to training[\s\S]*Cardio[\s\S]*Saturday/);
 await deskPage.screenshot({path:'test-results/survey-fitness-profile.png',fullPage:true,animations:'disabled'});
 const seen=(await staffApi.get('/state')).members.find(m=>m.id===desk.id);
 assert.deepEqual({experience:seen.survey.experience,exercises:seen.survey.exercises,availableDays:seen.survey.availableDays,goal:seen.goal},{...deskSurvey,goal:'Manage weight'},'staff read the answers');
 assert.equal((await staffApi.post('/member-survey',answers,403)).error,'Only members can save their own survey.');
 assert.equal((await adminApi.post('/member-survey',answers,403)).error,'Only members can save their own survey.');
 assert.equal(result(await db.from('ff_member_surveys').select('experience').eq('id',desk.id).single()).experience,'beginner','unchanged');
 pass('A survey filled in at the desk means no prompt at first login and shows under "Your fitness profile"; staff and administrators read it but cannot change it');

 // Members only ever read their own survey.
 const deskApi=client(app.origin);await deskApi.post('/login',{email:desk.email,password:desk.password});
 const own=await deskApi.get('/state');
 assert.deepEqual(own.members.map(m=>m.id),[desk.id]);assert.equal(own.members[0].survey.experience,'beginner');
 assert.equal(JSON.stringify(own).includes('returning'),false,'nothing of the other members\' answers');
 pass('Members only ever read their own survey');

 // Task 10's clean-up: deleting a never-paid account also removes its survey row.
 const gone=await addMember(staffApi,'Gone',{goal:'Improve fitness',survey:deskSurvey});
 assert(result(await db.from('ff_member_surveys').select('id').eq('id',gone.id).maybeSingle()),'the never-paid member has survey answers');
 await adminApi.post('/members/delete-unpaid',{id:gone.id});
 assert.equal(result(await db.from('ff_member_surveys').select('id').eq('id',gone.id).maybeSingle()),null,'the survey row went with the account');
 assert.equal(result(await db.from('ff_profiles').select('id').eq('id',gone.id).maybeSingle()),null);
 pass('Deleting a never-paid account (Task 10) also removes its survey answers');
 assert.deepEqual(errors,[],'no JavaScript errors');
 console.log(`PASS: ${passed.length} survey checks`);
}finally{
 if(browser)await browser.close();app?.server.close();
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_payments','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
}
