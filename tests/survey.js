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
// selection after it, the desk survey in Add member, staff read-only, and Task 10's clean-up removing a never-paid
// account's survey. No PayMongo call is made (the survey check refuses first). Every fixture is removed afterwards.
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

 // At the desk: a survey filled in with the member means no prompt; staff read it and can't change it.
 const desk=await addMember(staffApi,'Desk',{goal:'Manage weight',survey:deskSurvey});
 const deskPage=await signIn(desk);
 await deskPage.getByText('Choose a plan to start your membership.',{exact:true}).waitFor();
 assert.equal(await deskPage.locator('.survey-first').count(),0,'a desk-filled survey: no prompt at first login');
 await deskPage.getByRole('link',{name:'My membership',exact:true}).click();
 await deskPage.getByRole('heading',{name:'Your fitness profile',exact:true}).waitFor();
 assert.match(await deskPage.locator('#fitness-survey').innerText(),/Manage weight[\s\S]*I’m new to training[\s\S]*Cardio[\s\S]*Saturday/);
 await deskPage.screenshot({path:'test-results/survey-fitness-profile.png',fullPage:true});
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
