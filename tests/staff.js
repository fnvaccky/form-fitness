import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,request} from 'playwright';
import {serviceClient,result} from '../src/supabase.js';
// Staff management end to end against the local stack, the running dev server and Mailpit.
// Accounts created here are cleaned up by disabling them, never by deleting them.
const host=new URL(process.env.SUPABASE_URL).hostname;
assert(['localhost','127.0.0.1'].includes(host),'Local tests only');
const origin=process.env.APP_ORIGIN;
const accounts=JSON.parse(await readFile('.local/local-test-credentials.json','utf8')).accounts;
const admin=accounts.find(a=>a.role==='admin'),staff=accounts.find(a=>a.role==='staff'),member=accounts.find(a=>a.role==='member');
const db=serviceClient(),contexts=[],created=[],passed=[];let browser;
const pass=name=>{passed.push(name);console.log('PASS: '+name);};
async function context(){const c=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});contexts.push(c);return c;}
async function call(c,path,body,status=200){const r=body===undefined?await c.get('/api'+path):await c.post('/api'+path,{data:body});const data=await r.json();assert.equal(r.status(),status,`${path}: ${data.error||r.status()}`);return data;}
async function signIn(account){const c=await context();await call(c,'/login',{email:account.email,password:account.password});return c;}
async function setupMail(email,after){
 for(let i=0;i<30;i++){
  const list=await (await fetch('http://127.0.0.1:54324/api/v1/messages?limit=50')).json();
  for(const item of list.messages||[])if(Date.parse(item.Created)>=after&&JSON.stringify(item.To).toLowerCase().includes(email))return (await fetch('http://127.0.0.1:54324/api/v1/message/'+item.ID)).json();
  await new Promise(r=>setTimeout(r,500));
 }
 return null;
}
const adminCtx=await signIn(admin),staffCtx=await signIn(staff),memberCtx=await signIn(member),anonymous=await context();
try{
 const probe={name:'LOCAL TEST Probe',email:'local-staff-probe@example.invalid',phone:'09170000020'};
 const routes=[['/staff',probe],['/staff/update',{id:randomUUID(),name:'LOCAL TEST Probe',phone:'09170000020'}],['/staff/enable',{id:randomUUID(),enabled:false}],['/staff/resend',{id:randomUUID()}]];
 for(const [c,status] of [[anonymous,401],[memberCtx,403],[staffCtx,403]])for(const [path,body] of routes)assert.equal((await c.post('/api'+path,{data:body})).status(),status,path);
 assert.equal((await call(staffCtx,'/state')).staff,undefined);assert.equal((await call(memberCtx,'/state')).staff,undefined);
 assert.equal((await call(staffCtx,'/session')).user.can.manageStaff,undefined);assert.equal((await call(adminCtx,'/session')).user.can.manageStaff,true);
 pass('Anonymous calls to /api/staff* get 401; member and staff calls get 403 and neither receives the staff list');

 const email=`local-staff-${randomUUID().slice(0,8)}@example.invalid`,startedAt=Date.now()-2000;
 const made=await call(adminCtx,'/staff',{name:'LOCAL TEST Staff',email,phone:'+63 917 000 0021'},201);created.push(made.staff.id);
 assert.equal(made.staff.role,'staff');assert.equal(made.staff.phone,'09170000021');assert.equal(made.setupEmailSent,true,made.message);
 const profile=result(await db.from('ff_profiles').select('*').eq('id',made.staff.id).single());
 assert.equal(profile.role,'staff');assert.equal(profile.workspace,'production');assert.equal(profile.enabled,true);
 assert.equal(result(await db.from('ff_memberships').select('id').eq('member_id',made.staff.id)).length,0,'no membership');
 assert.equal(result(await db.from('ff_invoices').select('id').eq('member_id',made.staff.id)).length,0,'no invoice');
 assert.deepEqual(result(await db.from('ff_staff_audit').select('action').eq('target_id',made.staff.id)).map(r=>r.action),['create']);
 assert((await call(adminCtx,'/state')).staff.some(s=>s.id===made.staff.id&&s.role==='staff'&&s.enabled));
 const duplicate=await adminCtx.post('/api/staff',{data:{name:'LOCAL TEST Staff',email:email.toUpperCase(),phone:'09170000021'}});
 assert.equal(duplicate.status(),409);assert.match((await duplicate.json()).error,/already uses this email/);
 for(const extra of [{role:'admin'},{password:'ChosenByAdmin2026'}])assert.equal((await adminCtx.post('/api/staff',{data:{name:'LOCAL TEST Staff',email:'local-staff-extra@example.invalid',phone:'09170000021',...extra}})).status(),400);
 pass('Admin creates staff: role staff, no membership or invoice, one audit row; duplicate email gets 409; role and password fields are refused');

 const mail=await setupMail(email,startedAt);assert(mail,'setup email captured locally');
 assert.match(mail.HTML,/Your gym administrator manages your access/);assert.doesNotMatch(mail.HTML,/Plan:|member pass/,'no membership details in a staff email');
 const link=mail.HTML.match(/href="([^"]*token_hash=[^"]+)"/)[1].replaceAll('&amp;','&');assert(link.startsWith(origin+'/api/auth/callback?'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage();await page.goto(link);
 const newStaff={email,password:'LocalStaff2026'+randomUUID().slice(0,6)};
 const saving=page.waitForResponse(r=>r.url().endsWith('/api/set-password')&&r.request().method()==='POST');
 await page.getByLabel('New password *',{exact:true}).fill(newStaff.password);await page.getByRole('button',{name:'Save password',exact:true}).click();
 const saved=await saving;assert.equal(saved.status(),200,(await saved.json()).error);
 const session=await (await page.request.get(origin+'/api/session')).json();
 assert.deepEqual(Object.keys(session.user.can).sort(),['addMember','initiateOnlinePayment','recordCashPayment','renew','roster','scan']);
 let newCtx=await signIn(newStaff);assert.equal((await call(newCtx,'/state')).user.role,'staff');
 pass('The setup email carries the staff wording; following it and saving a password signs the new staff member in with exactly the staff capabilities');

 await call(adminCtx,'/staff/enable',{id:made.staff.id,enabled:false});
 const codes=[(await newCtx.get('/api/state')).status(),(await page.request.get(origin+'/api/state')).status(),(await (await context()).post('/api/login',{data:newStaff})).status()];
 for(const code of codes)assert([401,403].includes(code),`disabled staff got ${code}`);
 await call(adminCtx,'/staff/enable',{id:made.staff.id,enabled:true});
 newCtx=await signIn(newStaff);assert.equal((await call(newCtx,'/state')).user.role,'staff');
 pass(`Disabling cuts both open sessions on the next call and blocks sign-in (${codes.join(', ')}); enabling restores access`);

 const pair=await Promise.all([1,2].map(()=>adminCtx.post('/api/staff/resend',{data:{id:made.staff.id}})));
 assert.deepEqual(pair.map(r=>r.status()).sort(),[200,429],'two simultaneous resends send one link');
 assert.equal(result(await db.from('ff_staff_audit').select('id').eq('target_id',made.staff.id).eq('action','resend')).length,1);
 const later=await adminCtx.post('/api/staff/resend',{data:{id:made.staff.id}});assert.equal(later.status(),429);assert.match((await later.json()).error,/Try again in \d+ seconds/);
 pass('Resend claims once: of two simultaneous resends one sends and one gets 429, and another within 60 seconds gets 429 with the wait time');

 const edited=await call(adminCtx,'/staff/update',{id:made.staff.id,name:'LOCAL TEST Staff Renamed',phone:'09170000022'});
 assert.equal(edited.staff.name,'LOCAL TEST Staff Renamed');assert.equal(edited.staff.phone,'09170000022');assert.equal(edited.staff.email,email);
 assert.equal((await adminCtx.post('/api/staff/update',{data:{id:made.staff.id,name:'LOCAL TEST Staff',phone:'09170000022',email:'local-staff-other@example.invalid'}})).status(),400);
 assert.equal((await adminCtx.post('/api/staff/enable',{data:{id:admin.id,enabled:false}})).status(),403);
 assert.equal((await adminCtx.post('/api/staff/update',{data:{id:member.id,name:'LOCAL TEST Member',phone:'09170000023'}})).status(),400);
 assert.deepEqual(result(await db.from('ff_staff_audit').select('action').eq('target_id',made.staff.id).order('created_at')).map(r=>r.action),['create','disable','enable','resend','update']);
 pass('Admin edits name and mobile; email changes are refused; administrators and members cannot be changed here; every action has one audit row');
}finally{
 for(const id of created){try{await adminCtx.post('/api/staff/enable',{data:{id,enabled:false}});}catch{console.error('Disable the test staff account manually.');}}
 await browser?.close();for(const c of contexts)await c.dispose();
 await mkdir('test-results',{recursive:true});await writeFile('test-results/staff-results.json',JSON.stringify({time:new Date().toISOString(),origin,passed},null,2));
}
