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
// UI-001 end to end on the local stack: My membership → "Explore your next cycle" for a member with a paid cycle
// (desktop and phone), the "waiting for payment" state once their next cycle exists, and the plain "Select" wording
// for a member with no plan. PayMongo is configured with a fake test key and never called. Fixtures are removed afterwards.
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:'',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex')};
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
// Members come with their fitness survey (filled in at the desk), so the survey never stands in the way here.
const SURVEY={experience:'regular',exercises:['strength'],availableDays:['mon']};
async function addMember(staffApi,label,extra={}){
 const added=await staffApi.post('/members',{name:`Cycle${label} Member`,email:`cycle-${label.toLowerCase()}-${randomUUID().slice(0,8)}@example.invalid`,phone:'09170000032',goal:'Improve fitness',survey:SURVEY,...extra},201);
 users.push(added.member.id);
 const password='Local9!'+randomBytes(24).toString('base64url');
 assert.ifError((await db.auth.admin.updateUserById(added.member.id,{password})).error);
 return {...added.member,password};
}
const longDate=d=>new Date(d+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
const shortDate=d=>new Date(d+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'});
const addDays=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
let browser,app;
try{
 await mkdir('test-results',{recursive:true});
 app=await serve();
 const {data,error}=await db.auth.admin.createUser({email:`cycle-staff-${randomUUID().slice(0,8)}@example.invalid`,password:'Local9!'+randomBytes(24).toString('base64url'),email_confirm:true,
  app_metadata:{ff_workspace:'production',ff_role:'staff'},user_metadata:{form_fitness:true,name:'LOCAL TEST Cycle staff',phone:'09170000033'}});
 assert.ifError(error);users.push(data.user.id);
 const staffApi=client(app.origin);await staffApi.post('/login',{email:data.user.email,password:(await db.auth.admin.updateUserById(data.user.id,{password:'Local9!StaffCycle2026x'}),'Local9!StaffCycle2026x')});
 const start=today();
 // A member on Momentum, paid at the desk.
 const paid=await addMember(staffApi,'Momentum',{plan:'plus',start});
 const invoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',paid.id).single());
 await staffApi.post('/payments',{invoiceId:invoice.id,amount:invoice.amount_cents/100,method:'Cash',verified:true,date:start,idempotencyKey:randomUUID()});
 const until=result(await db.from('ff_memberships').select('end_date').eq('member_id',paid.id).single()).end_date,next=addDays(until,1);
 const note=`You’re on Momentum until ${longDate(until)}. Choosing a plan below creates your next cycle, starting ${shortDate(next)}; your current one isn’t affected.`;
 browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[];
 const signIn=async(person,viewport={width:1440,height:1000})=>{
  const page=await (await browser.newContext({viewport})).newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);
  // Sign-in finishes on the overview; move to My membership once it is on screen.
  await page.locator('.page-heading').first().waitFor();await page.evaluate(()=>navigate('members'));await page.locator('.plans-grid').waitFor();return page;
 };
 const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
 for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['phone',{width:390,height:844}]]){
  const page=await signIn(paid,viewport);
  assert.equal((await page.locator('.next-cycle-note').innerText()).trim(),note,`${label}: the note above the cards`);
  // Right above the cards, or above Task 12B's recommendation, which sits right above them.
  assert(await page.locator('.next-cycle-note + .plans-grid, .next-cycle-note + .plan-recommendation + .plans-grid').count(),`${label}: the note sits right above the cards`);
  const current=page.locator('.plan-card.current-plan');
  assert.equal(await current.count(),1);
  assert.match(await current.innerText(),/Your current plan[\s\S]*Momentum/);
  assert.equal(/THE BALANCED CHOICE/.test(await current.innerText()),false,`${label}: "Your current plan" replaces the marketing badge`);
  assert.equal((await current.locator('[data-action="select-plan"]').innerText()).trim(),'Renew Momentum');
  assert.deepEqual((await page.locator('.plan-card:not(.current-plan) [data-action="select-plan"]').allInnerTexts()).map(t=>t.trim()).sort(),['Switch to Essential next cycle','Switch to Performance next cycle']);
  assert.equal(await fits(page),true,`${label}: no sideways scroll`);
  await page.screenshot({path:`test-results/next-cycle-${label}.png`,fullPage:true,animations:'disabled'});
  await page.close();
 }
 pass('Desktop and phone: a paid Momentum member sees "You’re on Momentum until … starting …" above the cards, "Your current plan" with "Renew Momentum", and "Switch to … next cycle" on the others');

 // Renewing creates the next cycle, starting the day after the paid one; then Pay now for it, and no other pick.
 const page=await signIn(paid);
 await page.getByRole('button',{name:'Renew Momentum',exact:true}).click();
 assert.equal(await page.locator('#renew-start').inputValue(),next,'the next cycle starts the day after the paid one');
 await page.locator('#renew-form input[type="checkbox"]').check();
 const renewing=page.waitForResponse(r=>r.url().endsWith('/api/renew'));
 await page.getByRole('button',{name:'Create renewal invoice',exact:true}).click();assert.equal((await renewing).status(),200);
 // Renewing lands on My payments with the new invoice; back on My membership, the next cycle waits for payment.
 await page.locator('#toast').filter({hasText:'Invoice created. Payment is still required.'}).waitFor();
 await page.evaluate(()=>navigate('members'));
 const waiting=`Your next cycle (Momentum, from ${shortDate(next)}) is waiting for payment.`;
 await page.locator('.next-cycle-note.waiting').filter({hasText:waiting}).waitFor();
 assert.equal(await page.locator('.next-cycle-note.waiting').getByRole('button',{name:'Pay now',exact:true}).count(),1,'with Pay now');
 assert.equal(await page.locator('[data-action="select-plan"]').count(),0,'no other plan can be picked while it waits');
 assert.match(await page.locator('.plan-card.current-plan').innerText(),/Your current plan[\s\S]*Momentum/,'the current plan stays marked');
 assert.equal(/THE BALANCED CHOICE/.test(await page.locator('.plan-card.current-plan').innerText()),false);
 await page.screenshot({path:'test-results/next-cycle-waiting-desktop.png',fullPage:true,animations:'disabled'});
 await page.close();
 const phone=await signIn(paid,{width:390,height:844});
 await phone.locator('.next-cycle-note.waiting').filter({hasText:waiting}).waitFor();
 assert.equal(await fits(phone),true,'phone: no sideways scroll');
 await phone.screenshot({path:'test-results/next-cycle-waiting-phone.png',fullPage:true,animations:'disabled'});
 await phone.close();
 pass('After "Renew Momentum" the next cycle starts the day after the paid one; then "Your next cycle (Momentum, from …) is waiting for payment" with Pay now replaces the plan buttons (desktop and phone)');

 // A member with no plan keeps "Select".
 const fresh=await addMember(staffApi,'NoPlan');
 const freshPage=await signIn(fresh);
 assert.equal(await freshPage.locator('.next-cycle-note').count(),0);
 assert.deepEqual((await freshPage.locator('[data-action="select-plan"]').allInnerTexts()).map(t=>t.trim()).sort(),['Select Essential','Select Momentum','Select Performance']);
 assert.equal(await freshPage.locator('.plan-card.current-plan').count(),0);
 await freshPage.close();
 pass('A member with no plan keeps the "Select" wording');
 assert.deepEqual(errors,[],'no JavaScript errors');
 console.log(`PASS: ${passed.length} next-cycle checks`);
}finally{
 if(browser)await browser.close();app?.server.close();
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_payments','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
}
