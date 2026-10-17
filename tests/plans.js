import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {notificationBody} from '../src/notifications.js';
import {today} from '../src/validation.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 12A end to end on the local stack: plan management through the API (administrators only, every field checked by
// the database), purchased terms through a catalog edit (an email sent afterwards still describes what was bought),
// retirement, a plan edit racing a new cycle, and the screens: administrators add and edit plans on desktop and phone,
// staff see read-only cards, members see coaching and what they bought. No email is sent and PayMongo is not called.
// Every fixture is removed afterwards, the test plans included (plans can't be deleted through the app, so a local
// superuser session does it, with the plan table's guard switched off only inside that transaction).
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:'',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex')};
const db=serviceClient(env),users=[],planIds=[],passed=[];
const tag=randomBytes(3).toString('hex');
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const psqlArgs=['exec','-i','supabase_db_RepReady','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-At'];
const psql=sql=>{const r=spawnSync('docker',psqlArgs,{input:sql,encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}});if(r.status)throw Error(r.stderr);return r.stdout.trim();};
const psqlAsync=sql=>new Promise(resolve=>{const p=spawn('docker',psqlArgs,{env:{...process.env,MSYS_NO_PATHCONV:'1'}});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>resolve({code,out:out.trim(),err}));p.stdin.end(sql);});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
const SURVEY={experience:'regular',exercises:['strength'],availableDays:['mon']};
async function account(role,label){
 const password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email:`plans-${label}-${tag}@example.invalid`,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:role},
  user_metadata:{form_fitness:true,name:`LOCAL TEST Plans ${label}`,phone:'09170000060'}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email:data.user.email,password};
}
async function addMember(staffApi,label,extra={}){
 const added=await staffApi.post('/members',{name:`Plans ${label} Member`,email:`plans-${label.toLowerCase()}-${tag}@example.invalid`,phone:'09170000061',goal:'Improve fitness',survey:SURVEY,...extra},201);
 users.push(added.member.id);
 const password='Local9!'+randomBytes(24).toString('base64url');
 assert.ifError((await db.auth.admin.updateUserById(added.member.id,{password})).error);
 return {...added.member,password,invoiceId:added.invoiceId};
}
const signedIn=async(origin,person)=>{const api=client(origin);await api.post('/login',{email:person.email,password:person.password});return api;};
// A full plan body for the API; a test changes only what it needs.
const planBody=(id,changes={})=>({action:'update',id,name:`ZZ E2E ${tag}`,price:'1234.50',days:28,description:'Made by the end-to-end test.',
 features:['Gym floor','Everything in Essential'],available:true,coaching:'group',coachSessions:2,focusTags:['strength','cardio'],...changes});
const cleanupPlans=()=>{if(planIds.length)psql(`begin;\nalter table public.ff_plans disable trigger ff_plans_guard;\ndelete from public.ff_plans where workspace='production' and id in (${planIds.map(id=>`'${id.replace(/'/g,"''")}'`).join(',')});\nalter table public.ff_plans enable trigger ff_plans_guard;\ncommit;`);};
let browser,app;
try{
 await mkdir('test-results',{recursive:true});
 app=await serve();
 const admin=await account('admin','admin'),staff=await account('staff','staff');
 const adminApi=await signedIn(app.origin,admin),staffApi=await signedIn(app.origin,staff);
 const planId=`zz-e2e-${tag}`;

 // 1. Plan management through the API: administrators only, every field checked by the database. -------------------
 await staffApi.post('/plans',{...planBody(planId),action:'create'},403);
 const member0=await addMember(staffApi,'Reader');const memberApi=await signedIn(app.origin,member0);
 await memberApi.post('/plans',{...planBody(planId),action:'create'},403);
 assert.match((await adminApi.post('/plans',{id:'basic',name:'Essential',price:'899',available:true},409)).error,/out of date/,'the old Edit plan form is told to reload');
 planIds.push(planId);
 const created=await adminApi.post('/plans',{...planBody(planId),action:'create'});
 assert.deepEqual({id:created.plan.id,price:created.plan.price,priceCents:created.plan.priceCents,days:created.plan.days,coaching:created.plan.coaching,coachSessions:created.plan.coachSessions,
  coachingLabel:created.plan.coachingLabel,focusTags:created.plan.focusTags,available:created.plan.available,alreadySaved:created.alreadySaved},
  {id:planId,price:1234.5,priceCents:123450,days:28,coaching:'group',coachSessions:2,coachingLabel:'Group coaching · 2 sessions',focusTags:['strength','cardio'],available:true,alreadySaved:false});
 assert.equal((await adminApi.post('/plans',{...planBody(planId),action:'create'})).alreadySaved,true,'a repeated Add plan returns the saved plan');
 for(const [changes,message,status=400] of [[{days:0},/cycle length of 1 to 366 days/],[{coaching:'none',coachSessions:3},/no coach has 0 coach sessions/],[{focusTags:['yoga']},/Choose focus tags/],
  [{features:Array.from({length:11},(_,i)=>`Feature ${i}`)},/up to 10 features/],[{name:'Essential'},/Another plan already uses this name/,409],[{description:'<b>bold</b>'},/description/]])
  assert.match((await adminApi.post('/plans',planBody(planId,changes),status)).error,message,JSON.stringify(changes));
 assert.match((await adminApi.post('/plans',planBody(planId,{price:'12.345'}),400)).error,/at most two decimal places/);
 assert.equal((await client(app.origin).get('/plans')).plans.find(p=>p.id===planId)?.coachingLabel,'Group coaching · 2 sessions','signed-out visitors see the new plan with its coaching');
 pass('Plan management: staff and members are refused; an administrator adds a plan (a repeat returns it); every field is checked by the database, with its own message');

 // 2. Purchased terms through a catalog edit. -----------------------------------------------------------------------
 const buyer=await addMember(staffApi,'Buyer',{plan:planId,start:today()});
 const invoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',buyer.id).single());
 await staffApi.post('/payments',{invoiceId:invoice.id,amount:invoice.amount_cents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
 const paymentRow=result(await db.from('ff_notifications').select('*').eq('member_id',buyer.id).like('event_key','payment:%').single());
 assert.equal(paymentRow.status,'queued','the payment email waits in the queue (no sender in tests)');
 await adminApi.post('/plans',planBody(planId,{name:`ZZ E2E Renamed ${tag}`,price:'1500',days:31,features:['Gym floor','Sauna'],coaching:'personal',coachSessions:5}));
 const email=await notificationBody(db,paymentRow,{...env,APP_ORIGIN:app.origin});
 assert.match(email,new RegExp(`Plan: ZZ E2E ${tag}\\n`));assert.match(email,/- Everything in Essential: Unlimited gym access, All strength equipment, Locker room access, Fitness orientation\n/);
 assert.match(email,/Coaching: Group coaching · 2 sessions/);assert.doesNotMatch(email,/Renamed|Sauna|Personal coach/);
 const buyerApi=await signedIn(app.origin,buyer);
 let mine=await buyerApi.get('/state');
 assert.equal(mine.members[0].terms.name,`ZZ E2E ${tag}`);assert.equal(mine.members[0].terms.coachingLabel,'Group coaching · 2 sessions');
 assert.equal(mine.invoices[0].terms.priceCents,123450);assert.equal(mine.plans.find(p=>p.id===planId).name,`ZZ E2E Renamed ${tag}`);
 const until=result(await db.from('ff_memberships').select('end_date').eq('member_id',buyer.id).single()).end_date;
 const next=new Date(until+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
 await buyerApi.post('/renew',{plan:planId,start:next.toISOString().slice(0,10)});
 mine=await buyerApi.get('/state');
 const renewal=mine.invoices.find(i=>i.start===next.toISOString().slice(0,10));
 assert.deepEqual({name:renewal.terms.name,priceCents:renewal.amountCents,days:renewal.terms.days,coaching:renewal.terms.coachingLabel},{name:`ZZ E2E Renamed ${tag}`,priceCents:150000,days:31,coaching:'Personal coach · 5 sessions'});
 pass('After a plan edit, the paid cycle and a payment email sent afterwards still describe the plan as bought, "Everything in Essential" included; a new cycle uses the edited plan');

 // 3. Retiring the plan stops new cycles only. ----------------------------------------------------------------------
 await adminApi.post('/plans',planBody(planId,{name:`ZZ E2E Renamed ${tag}`,price:'1500',days:31,features:['Gym floor','Sauna'],coaching:'personal',coachSessions:5,available:false}));
 const later=new Date(next);later.setUTCDate(later.getUTCDate()+31);
 assert.match((await buyerApi.post('/renew',{plan:planId,start:later.toISOString().slice(0,10)},400)).error,/Select an available membership plan/);
 await staffApi.post('/payments',{invoiceId:renewal.id,amount:renewal.amountCents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
 mine=await buyerApi.get('/state');
 assert.equal(mine.invoices.find(i=>i.id===renewal.id).paidCents,150000,'the unpaid invoice on the retired plan is paid at its own price');
 assert.equal(mine.plans.find(p=>p.id===planId).available,false,'the retired plan stays readable');
 assert.equal((await client(app.origin).get('/plans')).plans.some(p=>p.id===planId),false,'and is no longer offered');
 pass('A retired plan takes no new cycle, stays readable, and its unpaid invoice is still paid at its own price');

 // 4. A plan edit racing a new cycle: whichever takes the plan row first, the cycle gets one whole version of it. -----
 const racePlan=`zz-e2e-${tag}-race`;planIds.push(racePlan);
 await adminApi.post('/plans',{...planBody(racePlan,{name:`ZZ E2E Race ${tag}`,price:'1000',features:['Race floor']}),action:'create'});
 const racer=await addMember(staffApi,'Racer'),racer2=await addMember(staffApi,'Racer2');
 const sessions={admin:randomUUID(),racer:randomUUID(),racer2:randomUUID()};
 psql(`insert into auth.sessions(id,user_id) values('${sessions.admin}','${admin.id}'),('${sessions.racer}','${racer.id}'),('${sessions.racer2}','${racer2.id}');`);
 const as=(id,session)=>`select set_config('request.jwt.claims','${JSON.stringify({sub:id,role:'authenticated',session_id:session})}',true);\nset local role authenticated;`;
 const edit=price=>`select public.ff_plan_admin('update','${JSON.stringify({...planBody(racePlan,{name:`ZZ E2E Race ${tag}`,features:['Race floor']}),action:undefined,price:undefined,priceCents:price})}'::jsonb) is not null;`;
 const renewSql=(id,session)=>`${as(id,session)}\nselect public.ff_command('renew','${JSON.stringify({plan:racePlan,start:today()})}'::jsonb) is not null;\nselect to_char(clock_timestamp(),'HH24:MI:SS.MS');`;
 const waiting=()=>psql(`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%ff_%' and state='active';`);
 // a) The edit holds the plan; the renewal waits for it, then takes the edited plan.
 const editFirst=psqlAsync(`begin;\n${as(admin.id,sessions.admin)}\n${edit(150000)}\nselect pg_sleep(4);\nselect to_char(clock_timestamp(),'HH24:MI:SS.MS');\ncommit;`);
 await wait(1500);const renewSecond=psqlAsync(`begin;\n${renewSql(racer.id,sessions.racer)}\ncommit;`);
 await wait(1500);const blockedA=Number(waiting());
 const [a1,b1]=await Promise.all([editFirst,renewSecond]);assert.equal(a1.code,0,a1.err);assert.equal(b1.code,0,b1.err);
 assert(blockedA>=1,'the renewal was waiting on the plan row');assert(b1.out.split('\n').at(-1)>a1.out.split('\n').at(-1),'and finished after the edit committed');
 const raceCycle=JSON.parse(psql(`select json_build_object('terms',m.terms,'amount',i.amount_cents) from public.ff_memberships m join public.ff_invoices i on i.membership_id=m.id where m.member_id='${racer.id}';`));
 assert.equal(raceCycle.terms.priceCents,150000);assert.equal(raceCycle.amount,150000);
 // b) The renewal holds the plan; the edit waits for it; the cycle keeps the plan as it was.
 const renewFirst=psqlAsync(`begin;\n${renewSql(racer2.id,sessions.racer2)}\nselect pg_sleep(4);\nselect to_char(clock_timestamp(),'HH24:MI:SS.MS');\ncommit;`);
 await wait(1500);const editSecond=psqlAsync(`begin;\n${as(admin.id,sessions.admin)}\n${edit(175000)}\nselect to_char(clock_timestamp(),'HH24:MI:SS.MS');\ncommit;`);
 await wait(1500);const blockedB=Number(waiting());
 const [b2,a2]=await Promise.all([renewFirst,editSecond]);assert.equal(b2.code,0,b2.err);assert.equal(a2.code,0,a2.err);
 assert(blockedB>=1,'the edit was waiting on the plan row');assert(a2.out.split('\n').at(-1)>b2.out.split('\n').at(-1),'and finished after the renewal committed');
 const raceCycle2=JSON.parse(psql(`select json_build_object('terms',m.terms,'amount',i.amount_cents) from public.ff_memberships m join public.ff_invoices i on i.membership_id=m.id where m.member_id='${racer2.id}';`));
 assert.equal(raceCycle2.terms.priceCents,150000);assert.equal(raceCycle2.amount,150000);
 assert.equal(Number(psql(`select price_cents from public.ff_plans where workspace='production' and id='${racePlan}';`)),175000);
 pass('A plan edit racing a new cycle: the later one waits on the plan row, so the cycle\'s terms and invoice come from one whole version (the edited one if the edit was first, the old one if not)');

 // A base plan and a child that includes it, for the rename below; one member buys the child before the rename.
 const baseId=`zz-e2e-${tag}-base`,childId=`zz-e2e-${tag}-child`,baseName=`ZZ Base ${tag}`,childName=`ZZ Child ${tag}`,renamedBase=`ZZ Base Renamed ${tag}`;planIds.push(baseId,childId);
 await adminApi.post('/plans',{...planBody(baseId,{name:baseName,price:'500',features:['Base floor'],coaching:'none',coachSessions:0}),action:'create'});
 await adminApi.post('/plans',{...planBody(childId,{name:childName,price:'800',features:[`Everything in ${baseName}`,'Child extra']}),action:'create'});
 assert.match((await adminApi.post('/plans',planBody(childId,{name:childName,features:['Everything in Nothing Here']}),400)).error,/"Everything in Nothing Here" names no other plan/,'a line naming no plan is refused');
 const childBuyer=await addMember(staffApi,'ChildBuyer',{plan:childId,start:today()});

 // 5. The screens. --------------------------------------------------------------------------------------------------
 browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[];
 const open=async(person,viewport={width:1440,height:1000})=>{
  const page=await (await browser.newContext({viewport})).newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);await page.locator('.page-heading').first().waitFor();return page;
 };
 const plansTab=async page=>{await page.evaluate(()=>{memberTab='plans';navigate('members');});await page.locator('.plans-grid').waitFor();};
 const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
 // Administrator, desktop: coaching on every card, Add plan with a pending state, no double submit, confirmed values without a reload.
 const page=await open(admin);await plansTab(page);
 const cardCoaching=async name=>(await page.locator('.plan-card',{has:page.getByRole('heading',{name,exact:true})}).locator('.plan-coaching').innerText()).trim();
 assert.equal(await cardCoaching('Essential'),'No coach');assert.equal(await cardCoaching('Momentum'),'Group coaching');assert.equal(await cardCoaching('Performance'),'Personal coach · 4 sessions');
 assert.equal(await page.getByRole('button',{name:'Add plan',exact:true}).count(),1);
 assert.equal(await page.locator('.plan-admin [data-action="edit-plan"]').count(),await page.evaluate(()=>plans.length),'Edit plan for every plan');
 assert.match(await page.locator('.plan-card.retired').first().innerText(),/RETIRED[\s\S]*Not offered for new cycles/,'the retired plan is marked, with no register button');
 await page.evaluate(()=>{window.__noReload=true;});
 await page.getByRole('button',{name:'Add plan',exact:true}).click();
 await page.getByLabel('Plan name *',{exact:true}).fill(`ZZ UI Plan ${tag}`);
 const uiPlan=await page.getByLabel('Plan ID *',{exact:true}).inputValue();assert.equal(uiPlan,`zz-ui-plan-${tag}`,'the ID is suggested from the name');planIds.push(uiPlan);
 await page.getByLabel('Price (PHP) *',{exact:true}).fill('1999.5');await page.getByLabel('Cycle length (days) *',{exact:true}).fill('45');
 await page.getByLabel('Description',{exact:true}).fill('Made in the browser test.');await page.getByLabel('Features',{exact:true}).fill('Everything in Momentum\nTowel service');
 await page.getByLabel('Coaching',{exact:true}).selectOption('personal');await page.getByLabel('Coach sessions per cycle',{exact:true}).fill('3');
 await page.getByLabel('Mobility',{exact:true}).check();await page.getByLabel('Strength',{exact:true}).check();
 let posts=0,release;const held=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/plans',async route=>{posts++;await held;await route.continue();});
 const save=page.locator('button[form="plan-form"]');
 await save.click();await page.waitForFunction(()=>document.querySelector('button[form="plan-form"]')?.textContent==='Saving…');
 assert.equal(await save.isDisabled(),true,'pending: the button says Saving… and is disabled');
 await page.locator('#plan-form').evaluate(form=>form.requestSubmit());await wait(300);
 assert.equal(posts,1,'a second submit while saving sends nothing');
 release();await page.locator('#plan-form').waitFor({state:'detached'});await page.unroute('**/api/plans');
 const row=page.locator(`[data-plan-row="${uiPlan}"]`);
 assert.match(await row.innerText(),/ZZ UI Plan [\s\S]*₱1,999\.50 \/ 45 days[\s\S]*Personal coach · 3 sessions[\s\S]*Available/,'the table shows the plan as the server saved it');
 assert.equal(await page.evaluate(()=>window.__noReload),true,'without reloading the page');
 assert.equal(await page.locator('.plan-card',{has:page.getByRole('heading',{name:`ZZ UI Plan ${tag}`,exact:true})}).locator('.plan-focus').innerText(),'Focus: Strength · Mobility','focus tags in their usual order');
 assert.deepEqual(result(await db.from('ff_plans').select('price_cents,days,coaching,coach_sessions,focus_tags').eq('workspace','production').eq('id',uiPlan).single()),{price_cents:199950,days:45,coaching:'personal',coach_sessions:3,focus_tags:['strength','mobility']});
 await page.screenshot({path:'test-results/plans-admin-desktop.png',fullPage:true,animations:'disabled'});
 // Edit: an error stays in the form (and the button comes back); a good change shows at once.
 await row.getByRole('button',{name:'Edit plan',exact:true}).click();
 assert.equal(await page.getByLabel('Plan ID',{exact:true}).getAttribute('readonly'),'','the ID can\'t be edited');
 await page.getByLabel('Plan name *',{exact:true}).fill('Essential');await save.click();
 await page.locator('#form-error').filter({hasText:'Another plan already uses this name.'}).waitFor();assert.equal(await save.innerText(),'Save plan');assert.equal(await save.isDisabled(),false);
 await page.getByLabel('Plan name *',{exact:true}).fill(`ZZ UI Plan ${tag}`);await page.getByLabel('Cycle length (days) *',{exact:true}).fill('0');await save.click();
 await page.locator('#form-error').filter({hasText:'Enter a cycle length of 1 to 366 days.'}).waitFor();
 await page.getByLabel('Cycle length (days) *',{exact:true}).fill('60');await page.getByLabel('Coaching',{exact:true}).selectOption('none');
 assert.equal(await page.getByLabel('Coach sessions per cycle',{exact:true}).isDisabled(),true,'no coach: the sessions are 0 and locked');
 await save.click();await page.locator('#plan-form').waitFor({state:'detached'});
 assert.match(await row.innerText(),/₱1,999\.50 \/ 60 days[\s\S]*No coach/);
 await page.locator('#toast').filter({hasText:'Existing memberships and invoices keep their terms.'}).waitFor();
 pass('Administrator, desktop: coaching on every card; Add plan shows Saving…, sends once, and the new plan appears as the server saved it without a reload; edit errors stay in the form');
 // Renaming a plan that another includes: the other plan's "Everything in" line follows, shown at once.
 await page.locator(`[data-plan-row="${baseId}"]`).getByRole('button',{name:'Edit plan',exact:true}).click();
 await page.getByLabel('Plan name *',{exact:true}).fill(renamedBase);await page.getByLabel('Features',{exact:true}).fill('Base floor\nBase sauna');
 await save.click();await page.locator('#plan-form').waitFor({state:'detached'});
 await page.locator('#toast').filter({hasText:`${childName} now says “Everything in ${renamedBase}”.`}).waitFor();
 assert.match(await page.locator('.plan-card',{has:page.getByRole('heading',{name:childName,exact:true})}).innerText(),new RegExp(`Everything in ${renamedBase}`),'the child card shows the new line');
 assert.equal(await page.evaluate(()=>window.__noReload),true,'without a reload');
 pass('Renaming a plan that another includes: the other plan\'s "Everything in" line follows the new name, shown at once, and the toast says so');
 // Administrator, phone.
 await page.setViewportSize({width:390,height:844});await plansTab(page);
 assert.equal(await fits(page),true,'phone: no sideways scroll on Membership plans');
 await page.getByRole('button',{name:'Add plan',exact:true}).click();await page.getByLabel('Plan name *',{exact:true}).waitFor();
 assert.equal(await fits(page),true,'phone: the plan form fits');
 await page.screenshot({path:'test-results/plans-admin-phone.png',animations:'disabled'});
 await page.keyboard.press('Escape');await page.close();
 pass('Administrator, phone: Membership plans and the plan form fit the screen');
 // Staff: the same cards, read-only.
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const staffPage=await open(staff,viewport);await plansTab(staffPage);
  assert.equal(await staffPage.getByRole('button',{name:'Add plan',exact:true}).count(),0);assert.equal(await staffPage.locator('[data-action="edit-plan"]').count(),0);
  assert.equal(await staffPage.locator('.plan-admin').count(),0);assert(await staffPage.locator('.plan-coaching').count()>=3);assert.equal(await fits(staffPage),true);
  await staffPage.screenshot({path:`test-results/plans-staff-${viewport.width}.png`,fullPage:true,animations:'disabled'});await staffPage.close();
 }
 pass('Staff, desktop and phone: plan cards with coaching, and no Add plan or Edit plan');
 // The member who bought the plan before it was renamed and retired.
 for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['phone',{width:390,height:844}]]){
  const memberPage=await open(buyer,viewport);
  await memberPage.locator('.member-hero').waitFor();
  assert.match(await memberPage.locator('.membership-card').innerText(),new RegExp(`ZZ E2E ${tag} membership[\\s\\S]*28-DAY ACCESS`),`${label}: today's cycle shows the plan as bought, before its rename and retirement`);
  await memberPage.evaluate(()=>navigate('members'));await memberPage.locator('.plans-grid').waitFor();
  assert.equal(await memberPage.locator('.plan-card',{hasText:`ZZ E2E Renamed ${tag}`}).count(),0,`${label}: the retired plan is not offered`);
  assert.match(await memberPage.locator('.membership-privileges').innerText(),/Gym floor[\s\S]*Everything in Essential\s*Unlimited gym access[\s\S]*Group coaching · 2 sessions/,`${label}: the privileges and coaching bought`);
  assert.doesNotMatch(await memberPage.locator('.membership-privileges').innerText(),/Sauna|Personal coach/,`${label}: nothing from the edited plan`);
  assert(await memberPage.locator('.plan-card .plan-coaching').count()>=3);assert.equal(await memberPage.locator('.plan-focus').count(),0,'members don\'t see focus tags');
  assert.equal(await fits(memberPage),true);
  await memberPage.screenshot({path:`test-results/plans-member-${label}.png`,fullPage:true,animations:'disabled'});await memberPage.close();
 }
 pass('Member, desktop and phone: today\'s cycle shows what was bought (name, length, privileges, coaching) after the plan was renamed and retired; a retired plan is not offered; cards show coaching, not focus tags');
 // A member on the original terms sees "Everything in Essential" with what it meant then.
 const before=await addMember(staffApi,'Momentum',{plan:'plus',start:today()});
 const momentumPage=await open(before);
 await momentumPage.evaluate(()=>navigate('members'));await momentumPage.locator('.membership-privileges').waitFor();
 assert.match(await momentumPage.locator('.membership-privileges').innerText(),/Everything in Essential\s*Unlimited gym access · All strength equipment · Locker room access · Fitness orientation[\s\S]*Group coaching/);
 await momentumPage.close();
 pass('"Everything in Essential" shows the Essential features as they were when the cycle was bought');
 // After the rename: a new purchase of the child includes the renamed base's benefits; the earlier one keeps its own.
 const childBuyer2=await addMember(staffApi,'ChildBuyer2',{plan:childId,start:today()});
 const newTerms=(await (await signedIn(app.origin,childBuyer2)).get('/state')).members[0].terms,oldTerms=(await (await signedIn(app.origin,childBuyer)).get('/state')).members[0].terms;
 assert.deepEqual(newTerms.included,[{line:`Everything in ${renamedBase}`,plan:renamedBase,features:['Base floor','Base sauna']}],'bought after the rename');
 assert.deepEqual(oldTerms.included,[{line:`Everything in ${baseName}`,plan:baseName,features:['Base floor']}],'bought before the rename, unchanged');
 const oldPage=await open(childBuyer);await oldPage.evaluate(()=>navigate('members'));await oldPage.locator('.membership-privileges').waitFor();
 assert.match(await oldPage.locator('.membership-privileges').innerText(),new RegExp(`Everything in ${baseName}\\s*Base floor`));assert.doesNotMatch(await oldPage.locator('.membership-privileges').innerText(),/Base sauna|Renamed/);
 await oldPage.close();
 pass('After the rename, a new purchase includes the renamed plan\'s benefits (the added one too); the member who bought before still sees "Everything in" the old name with the list as bought');
 assert.deepEqual(errors,[],'no JavaScript errors');
 console.log(`PASS: ${passed.length} plan management checks`);
}finally{
 if(browser)await browser.close();app?.server.close();
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_payments','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
 cleanupPlans();
 const left=psql(`select count(*) from public.ff_plans where id in (${planIds.map(id=>`'${id}'`).join(',')||"''"});`);
 assert.equal(left,'0','the test plans are gone');
}
