import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
import {recommendPlans} from '../public/plan-recommender.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 12B end to end on the local stack.
// 1. The browser's rules and the database's give identical results on 2,500 combinations of answers and catalogs.
// 2. The recommendation shows where plans are chosen (after the first-login survey, My membership, the staff's
//    Walk-in renewal picker and Add member's desk survey), on desktop and phone; it never selects anything; the record
//    keeps what was recommended and what was chosen; Task 11's survey gates and UI-001's waiting state still hold.
// PayMongo is configured with a fake test key and never called. Every fixture is removed afterwards (plans through a
// local superuser transaction, since the app can't delete plans).
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:'',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex')};
const db=serviceClient(env),users=[],planIds=[],passed=[];
const tag=randomBytes(3).toString('hex');
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const psql=sql=>{const r=spawnSync('docker',['exec','-i','supabase_db_RepReady','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-At'],{input:sql,encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'},maxBuffer:64*1024*1024});if(r.status)throw Error(r.stderr);return r.stdout.trim();};
const canon=o=>Array.isArray(o)?o.map(canon):o&&typeof o==='object'?Object.fromEntries(Object.keys(o).sort().map(k=>[k,canon(o[k])])):o;
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
async function account(role,label){
 const password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email:`rec-${label}-${tag}@example.invalid`,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:role},
  user_metadata:{form_fitness:true,name:`LOCAL TEST Rec ${label}`,phone:'09170000110'}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email:data.user.email,password};
}
async function addMember(staffApi,label,extra={}){
 const added=await staffApi.post('/members',{name:`Rec${label} Member`,email:`rec-${label.toLowerCase()}-${tag}@example.invalid`,phone:'09170000111',goal:'Improve fitness',...extra},201);
 users.push(added.member.id);
 const password='Local9!'+randomBytes(24).toString('base64url');
 assert.ifError((await db.auth.admin.updateUserById(added.member.id,{password})).error);
 return {...added.member,password,invoiceId:added.invoiceId};
}
const choices=async memberId=>result(await db.from('ff_plan_choices').select('chosen_plan_id,recommended_plan_id,rule_version,created_by,recommendation').eq('member_id',memberId).order('created_at'));
let browser,app;
try{
 await mkdir('test-results',{recursive:true});

 // 1. The same rules in the browser and in the database. -------------------------------------------------------------
 const seeded=JSON.parse(psql(`select jsonb_agg(jsonb_build_object('id',id,'name',name,'priceCents',price_cents,'coaching',coaching,'coachSessions',coach_sessions,'focusTags',to_jsonb(focus_tags),'available',available) order by id) from public.ff_plans where workspace='production';`));
 const catalogs=[seeded,
  [...seeded,{id:'lite',name:'Lite',priceCents:seeded.find(p=>p.id==='basic').priceCents,coaching:'group',coachSessions:0,focusTags:[],available:true},{id:'aaa',name:'Aaa',priceCents:149950,coaching:'group',coachSessions:2,focusTags:['group_classes'],available:true}],
  seeded.map(p=>p.id==='elite'?{...p,available:false}:p),
  seeded.map(p=>({...p,coaching:p.coaching==='none'?'group':p.coaching,focusTags:[]})),
  []];
 const goals=['Improve fitness','Build strength','Stay consistent','Manage weight',''],experiences=['beginner','returning','regular',''];
 const exerciseSets=[[],['strength'],['cardio','mobility'],['group_classes','strength','strength'],['yoga','cardio','group_classes','mobility']];
 const daySets=[[],['sat'],['mon','thu'],['mon','tue','wed'],['mon','tue','wed','thu','fri','sat','sun']];
 const cases=[];
 for(const plans of catalogs)for(const goal of goals)for(const experience of experiences)for(const exercises of exerciseSets)for(const availableDays of daySets)cases.push({answers:{goal,experience,exercises,availableDays},plans});
 const sql=JSON.stringify(cases).replace(/'/g,"''");
 const fromDatabase=JSON.parse(psql(`select jsonb_agg(ff_private.score_plans(c->'answers',c->'plans') order by n)::text from jsonb_array_elements('${sql}'::jsonb) with ordinality as x(c,n);`));
 const mismatches=cases.map((c,i)=>[c,JSON.stringify(canon(recommendPlans(c.answers,c.plans))),JSON.stringify(canon(fromDatabase[i]))]).filter(([,a,b])=>a!==b);
 assert.equal(mismatches.length,0,`first mismatch: ${mismatches[0]&&JSON.stringify(mismatches[0][0].answers)}\n browser  ${mismatches[0]?.[1]}\n database ${mismatches[0]?.[2]}`);
 const statuses=fromDatabase.reduce((n,r)=>({...n,[r.status]:(n[r.status]||0)+1}),{});
 assert(statuses.recommended&&statuses.incomplete&&statuses.no_plans,'every outcome is covered');
 pass(`The browser and the database give identical recommendations on ${cases.length} combinations (${JSON.stringify(statuses)}), reasons and points included`);

 // 2. The screens. ---------------------------------------------------------------------------------------------------
 app=await serve();
 const admin=await account('admin','admin'),staff=await account('staff','staff');
 const staffApi=client(app.origin),adminApi=client(app.origin);
 await staffApi.post('/login',{email:staff.email,password:staff.password});await adminApi.post('/login',{email:admin.email,password:admin.password});
 const termsBefore=result(await db.from('ff_memberships').select('id,terms'));
 const choicesBefore=result(await db.from('ff_plan_choices').select('id',{count:'exact',head:false})).length;
 browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[];
 const open=async(person,viewport={width:1440,height:1000})=>{
  const page=await (await browser.newContext({viewport})).newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);await page.locator('.page-heading,.survey-first').first().waitFor();return page;
 };
 const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
 const selectButtons=page=>page.locator('[data-action="select-plan"]').allInnerTexts().then(t=>t.map(s=>s.trim()).sort());

 // After the first-login survey, on plan selection; then under My membership. Desktop and phone.
 const fresh=[await addMember(staffApi,'Fresh'),await addMember(staffApi,'FreshPhone')];
 for(const [member,viewport,label] of [[fresh[0],{width:1440,height:1000},'desktop'],[fresh[1],{width:390,height:844},'phone']]){
  const page=await open(member,viewport);
  await page.locator('.survey-first').waitFor();
  await page.getByLabel('What is your main goal?',{exact:true}).selectOption('Build strength');
  await page.getByLabel('How familiar are you with training?',{exact:true}).selectOption('beginner');
  await page.getByLabel('Strength training',{exact:true}).check();await page.getByLabel('Monday',{exact:true}).check();await page.getByLabel('Thursday',{exact:true}).check();
  await page.getByRole('button',{name:'Save my answers',exact:true}).click();
  await page.locator('.survey-thanks').filter({hasText:'We recommend Performance for you; see why below. Any plan can be chosen.'}).waitFor();
  const block=page.locator('.plan-recommendation');
  assert.match(await block.innerText(),/Recommended for you[\s\S]*Performance[\s\S]*You’re new to training, and this plan includes a personal coach\.[\s\S]*It matches your interest in strength training\./i,`${label}: the reasons`);
  assert.equal(await page.locator('.plan-card.recommended-plan').count(),1);
  assert.match(await page.locator('.plan-card.recommended-plan').innerText(),/Recommended for you[\s\S]*Performance/i);
  assert.deepEqual(await selectButtons(page),['Select Essential','Select Momentum','Select Performance'],`${label}: every plan stays selectable, none chosen`);
  assert.equal(await fits(page),true,`${label}: fits`);
  await page.screenshot({path:`test-results/recommend-first-${label}.png`,fullPage:true,animations:'disabled'});
  await page.evaluate(()=>navigate('members'));await page.locator('.plans-grid').waitFor();
  assert.match(await page.locator('.plan-recommendation').innerText(),/Performance/,`${label}: under My membership too`);
  assert.equal(await page.locator('.plan-card.recommended-plan').count(),1);assert.equal(await fits(page),true);
  await page.screenshot({path:`test-results/recommend-membership-${label}.png`,fullPage:true,animations:'disabled'});
  if(label==='desktop'){
   // Free choice: Momentum, not the suggested Performance. The record keeps both, computed by the database.
   await page.getByRole('button',{name:'Select Momentum',exact:true}).click();
   await page.locator('#renew-form input[type="checkbox"]').check();
   const created=page.waitForResponse(r=>r.url().endsWith('/api/renew'));await page.locator('button[form="renew-form"]').click();assert.equal((await created).status(),200);
   await page.locator('#toast').filter({hasText:'Invoice created'}).waitFor();
  }
  await page.close();
 }
 const firstChoice=await choices(fresh[0].id);
 assert.equal(firstChoice.length,1);assert.equal(firstChoice[0].chosen_plan_id,'plus');assert.equal(firstChoice[0].recommended_plan_id,'elite');
 assert.equal(firstChoice[0].created_by,fresh[0].id);assert.equal(firstChoice[0].rule_version,'12B.1');
 assert.deepEqual(firstChoice[0].recommendation.inputs,{goal:'Build strength',experience:'beginner',exercises:['strength'],availableDays:['mon','thu'],daysPerWeek:2});
 assert.equal((await choices(fresh[1].id)).length,0,'looking at a recommendation records nothing');
 pass('After the first-login survey and under My membership (desktop and phone): "Recommended for you", the reasons and the badge, every plan selectable; choosing another plan is recorded with the recommendation the database computed');

 // UI-001: a paid member whose next cycle waits for payment keeps the waiting state; no plan buttons come back.
 const waiting=await addMember(staffApi,'Waiting',{goal:'Stay consistent',survey:{experience:'regular',exercises:['group_classes'],availableDays:['mon','tue','wed','thu','fri']},plan:'plus',start:today()});
 const paidInvoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',waiting.id).single());
 await staffApi.post('/payments',{invoiceId:paidInvoice.id,amount:paidInvoice.amount_cents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
 const waitingApi=client(app.origin);await waitingApi.post('/login',{email:waiting.email,password:waiting.password});
 const until=result(await db.from('ff_memberships').select('end_date').eq('member_id',waiting.id).single()).end_date,next=new Date(until+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
 await waitingApi.post('/renew',{plan:'plus',start:next.toISOString().slice(0,10)});
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const page=await open(waiting,viewport);await page.evaluate(()=>navigate('members'));await page.locator('.next-cycle-note.waiting').waitFor();
  assert.equal(await page.locator('[data-action="select-plan"]').count(),0,'no plan buttons while the next cycle waits');
  assert.equal(await page.locator('.next-cycle-note.waiting + .plan-recommendation').count(),1,'the recommendation shows below the waiting note, for information');
  assert.equal(await fits(page),true);await page.close();
 }
 assert.deepEqual((await choices(waiting.id)).map(c=>[c.chosen_plan_id,c.recommended_plan_id]),[['plus','plus'],['plus','plus']],'the desk plan and the renewal, each recorded once');
 pass('UI-001\'s waiting state holds: Pay now, no plan buttons, and the recommendation only as information (desktop and phone)');

 // Task 11: a paid member without a survey keeps their pass and is asked for it; renewal still waits for it.
 const unsurveyed=await addMember(staffApi,'NoSurvey',{plan:'basic',start:today()});
 const unsurveyedInvoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',unsurveyed.id).single());
 await staffApi.post('/payments',{invoiceId:unsurveyedInvoice.id,amount:unsurveyedInvoice.amount_cents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
 const page=await open(unsurveyed);
 assert.equal(await page.locator('.survey-first').count(),0,'not stopped by the survey');assert.equal(await page.getByRole('button',{name:'Show my member QR',exact:true}).count(),1,'the pass is there');
 await page.evaluate(()=>navigate('members'));await page.locator('.plans-grid').waitFor();
 assert.match(await page.locator('.plan-recommendation.incomplete').innerText(),/Complete your fitness profile to see which plan suits you best\./);
 assert.equal(await page.locator('.plan-card.recommended-plan').count(),0,'no recommendation is made up');
 await page.close();
 const unsurveyedApi=client(app.origin);await unsurveyedApi.post('/login',{email:unsurveyed.email,password:unsurveyed.password});
 assert.equal((await unsurveyedApi.post('/renew',{plan:'plus',start:next.toISOString().slice(0,10)},403)).error,'Complete your fitness survey first.');
 assert.deepEqual((await choices(unsurveyed.id)).map(c=>[c.chosen_plan_id,c.recommended_plan_id,c.recommendation.status]),[['basic',null,'incomplete']],'its desk plan is recorded with no recommendation');
 pass('Task 11 holds: a paid member without a survey keeps the pass and is asked to complete it (no recommendation made up); renewal still waits for the survey');

 // The staff's Walk-in renewal picker, desktop and phone: the suggestion for the member being renewed, selecting nothing.
 for(const [viewport,label] of [[{width:1440,height:1000},'desktop'],[{width:390,height:844},'phone']]){
  const staffPage=await open(staff,viewport);
  await staffPage.evaluate(()=>navigate('payments'));await staffPage.getByRole('button',{name:'Walk-in renewal',exact:true}).click();
  await staffPage.locator('#walkin-member').selectOption(waiting.id);
  const before=await staffPage.locator('#walkin-plan').inputValue();
  assert.match(await staffPage.locator('#walkin-recommendation').innerText(),/Recommended for you[\s\S]*Momentum[\s\S]*You want to stay consistent, and group coaching helps with that\.[\s\S]*Any plan can be chosen\./i);
  await staffPage.locator('#walkin-member').selectOption(unsurveyed.id);
  assert.match(await staffPage.locator('#walkin-recommendation').innerText(),/No recommendation yet: RecNoSurvey hasn’t completed the fitness survey\./);
  await staffPage.locator('#walkin-member').selectOption(waiting.id);
  assert.equal(await staffPage.locator('#walkin-plan').inputValue(),before,'the picker\'s choice is never changed by the suggestion');
  assert.equal(await fits(staffPage),true);await staffPage.screenshot({path:`test-results/recommend-walkin-${label}.png`,animations:'disabled'});
  await staffPage.close();
 }
 pass('Walk-in renewal (desktop and phone): the suggestion and its reasons for the member being renewed, or a note when they have no survey; the plan picker is left as it was');

 // Add member, desktop and phone: a note until the desk survey is complete, then the suggestion; the plan stays unset.
 const deskEmail=`rec-desk-${tag}@example.invalid`;
 for(const [viewport,label] of [[{width:1440,height:1000},'desktop'],[{width:390,height:844},'phone']]){
  const staffPage=await open(staff,viewport);
  await staffPage.getByRole('button',{name:'Add member',exact:true}).first().click();await staffPage.locator('#member-create-form').waitFor();
  assert.match(await staffPage.locator('#desk-recommendation').innerText(),/Fill in the whole fitness survey below to see a recommended plan\./);
  await staffPage.locator('#desk-survey summary').click();
  await staffPage.getByLabel('What is your main goal?',{exact:true}).selectOption('Manage weight');
  assert.match(await staffPage.locator('#desk-recommendation').innerText(),/Fill in the whole fitness survey/,'a partly filled survey still asks for the rest');
  await staffPage.getByLabel('How familiar are you with training?',{exact:true}).selectOption('regular');
  await staffPage.getByLabel('Cardio',{exact:true}).check();await staffPage.getByLabel('Monday',{exact:true}).check();await staffPage.getByLabel('Wednesday',{exact:true}).check();await staffPage.getByLabel('Friday',{exact:true}).check();
  assert.match(await staffPage.locator('#desk-recommendation').innerText(),/Recommended for you[\s\S]*Essential[\s\S]*You want to manage your weight, and this plan focuses on cardio\./i);
  assert.equal(await staffPage.locator('#member-plan').inputValue(),'','the plan stays at "No plan yet"');
  assert.equal(await fits(staffPage),true);await staffPage.screenshot({path:`test-results/recommend-add-member-${label}.png`,animations:'disabled'});
  if(label==='desktop'){
   // Staff choose Momentum for the member anyway; the record keeps both.
   await staffPage.getByLabel('Full name *',{exact:true}).fill('RecDesk Member');await staffPage.getByLabel('Email address *',{exact:true}).fill(deskEmail);
   await staffPage.getByLabel('Mobile number *',{exact:true}).fill('09170000112');await staffPage.locator('#member-plan').selectOption('plus');
   const created=staffPage.waitForResponse(r=>r.url().endsWith('/api/members'));await staffPage.getByRole('button',{name:'Create account',exact:true}).click();
   const body=await (await created).json();users.push(body.member.id);
   await staffPage.getByRole('heading',{name:'Member account created'}).or(staffPage.getByRole('heading',{name:'Account created'})).waitFor();
   assert.deepEqual((await choices(body.member.id)).map(c=>[c.chosen_plan_id,c.recommended_plan_id,c.created_by]),[['plus','basic',staff.id]],'staff chose Momentum; Essential was recommended');
  }
  await staffPage.close();
 }
 pass('Add member (desktop and phone): a note until the desk survey is complete, then the suggestion with its reasons; the plan stays unset, and staff choosing another plan is recorded');

 // A survey or catalog change changes the current suggestion; earlier records keep theirs.
 const changer=client(app.origin);await changer.post('/login',{email:fresh[1].email,password:fresh[1].password});
 await changer.post('/member-survey',{goal:'Manage weight',experience:'regular',exercises:['cardio'],availableDays:['mon','wed','fri']});
 const cheaper=`zz-rec-${tag}`;planIds.push(cheaper);
 const member1=await open(fresh[1]);await member1.evaluate(()=>navigate('members'));await member1.locator('.plan-recommendation').waitFor();
 assert.match(await member1.locator('.plan-recommendation').innerText(),/Essential/,'the new answers: Essential');
 await adminApi.post('/plans',{action:'create',id:cheaper,name:`ZZ Cardio ${tag}`,price:'500',days:30,description:'A test plan.',features:['Cardio floor'],available:true,coaching:'none',coachSessions:0,focusTags:['cardio']});
 await member1.reload();await member1.locator('.page-heading').first().waitFor();await member1.evaluate(()=>navigate('members'));await member1.locator('.plan-recommendation').waitFor();
 assert.match(await member1.locator('.plan-recommendation').innerText(),new RegExp(`ZZ Cardio ${tag}`),'a cheaper plan with the same points now leads');
 await adminApi.post('/plans',{action:'update',id:cheaper,name:`ZZ Cardio ${tag}`,price:'500',days:30,description:'A test plan.',features:['Cardio floor'],available:false,coaching:'none',coachSessions:0,focusTags:['cardio']});
 await member1.reload();await member1.locator('.page-heading').first().waitFor();await member1.evaluate(()=>navigate('members'));await member1.locator('.plan-recommendation').waitFor();
 assert.match(await member1.locator('.plan-recommendation').innerText(),/Essential/,'retired, it is never recommended');
 await member1.close();
 assert.equal((await choices(fresh[0].id))[0].recommended_plan_id,'elite','the earlier record keeps its recommendation');
 pass('A survey change and catalog changes (a new cheaper plan, then retiring it) change the current suggestion; the earlier record keeps its own');

 // Nothing else changed: viewing recommendations wrote no record, and no purchased terms moved.
 const termsAfter=new Map(result(await db.from('ff_memberships').select('id,terms')).map(r=>[r.id,JSON.stringify(r.terms)]));
 assert(termsBefore.every(r=>termsAfter.get(r.id)===JSON.stringify(r.terms)),'every cycle that existed before keeps its terms');
 const newChoices=result(await db.from('ff_plan_choices').select('id')).length-choicesBefore;
 assert.equal(newChoices,5,'exactly one record per new cycle: Fresh\'s choice, Waiting\'s plan and renewal, NoSurvey\'s plan, the desk member\'s plan');
 assert.deepEqual(errors,[],'no JavaScript errors');
 pass('Purchased terms unchanged, and only new cycles made records (5), none from viewing');
 console.log(`PASS: ${passed.length} recommendation checks`);
}finally{
 if(browser)await browser.close();app?.server.close();
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_payments','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
 if(planIds.length)psql(`begin;\nalter table public.ff_plans disable trigger ff_plans_guard;\ndelete from public.ff_plans where workspace='production' and id in (${planIds.map(id=>`'${id}'`).join(',')});\nalter table public.ff_plans enable trigger ff_plans_guard;\ncommit;`);
}
