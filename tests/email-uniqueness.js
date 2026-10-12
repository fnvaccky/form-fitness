import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {request} from 'playwright';
import {serviceClient,result} from '../src/supabase.js';
import {handle} from '../src/api.js';
import {today} from '../src/validation.js';
import {legacyRegistration} from './legacy-registration.js';
// One email, one account, end to end against the local stack: the running dev server for the
// production workspace and an in-process handler for the demo workspace. Task 10: Add member creates the
// account at once, so the races below race to create Auth users. It records no payment, and removes only
// the accounts and the pending registration it created.
const host=new URL(process.env.SUPABASE_URL).hostname;
assert(['localhost','127.0.0.1'].includes(host),'Local tests only');
const origin=process.env.APP_ORIGIN,MESSAGE='An account already uses this email.';
const accounts=JSON.parse(await readFile('.local/local-test-credentials.json','utf8')).accounts;
const demoAccounts=JSON.parse(await readFile('.local/demo-credentials.json','utf8')).accounts;
const db=serviceClient(),contexts=[],emails=[];
let demoOrigin='';
const demoServer=http.createServer((req,res)=>handle(req,res,{...process.env,APP_WORKSPACE:'demo',APP_ORIGIN:demoOrigin}));
await new Promise(resolve=>demoServer.listen(0,'127.0.0.1',resolve));
demoOrigin=`http://127.0.0.1:${demoServer.address().port}`;
const pass=name=>console.log('PASS: '+name);
async function signIn(base,account){const c=await request.newContext({baseURL:base,extraHTTPHeaders:{Origin:base}});contexts.push(c);assert.equal((await c.post('/api/login',{data:{email:account.email,password:account.password}})).status(),200,'login');return c;}
const member=email=>({name:'LOCAL TEST Email Rule',email,phone:'09170000061',goal:'Improve fitness'});
const fresh=()=>{const email=`local-email-rule-${randomUUID().slice(0,8)}@example.invalid`;emails.push(email);return email;};
async function refused(c,path,body,label){const r=await c.post('/api'+path,{data:body});const data=await r.json();assert.equal(r.status(),409,`${label}: ${r.status()} ${data.error}`);assert.equal(data.error,MESSAGE,label);}
const accountsFor=async email=>({profiles:result(await db.from('ff_profiles').select('id').ilike('email',email)).length,
 auth:(await db.auth.admin.listUsers({perPage:1000})).data.users.filter(u=>u.email===email.toLowerCase()).length});
try{
 const prod=await signIn(origin,accounts.find(a=>a.role==='admin')),demo=await signIn(demoOrigin,demoAccounts.find(a=>a.role==='admin'));
 const email=fresh();
 assert.equal((await prod.post('/api/members',{data:member(email)})).status(),201);
 pass('Add member with a new email still works');
 await refused(prod,'/members',member(email),'second Add member of the same email');
 await refused(prod,'/members',member(email.toUpperCase()),'same email in upper case');
 await refused(demo,'/members',member(email),'same email in the other workspace');
 await refused(prod,'/staff',{name:'LOCAL TEST Email Rule',email,phone:'09170000062'},'staff creation with a member\'s email');
 for(const role of ['admin','staff','member'])await refused(prod,'/members',member(accounts.find(a=>a.role===role).email),`Add member with an existing ${role}'s email`);
 // A paid-first registration saved before Task 10 still holds its email.
 const held=fresh();
 await legacyRegistration(accounts.find(a=>a.role==='staff'),{name:'LOCAL TEST Email Rule',email:held,phone:'09170000061',plan:'basic',start:today(),requestId:randomUUID()});
 await refused(prod,'/members',member(held),'Add member with an email an older pending registration holds');
 await refused(demo,'/members',member(held.toUpperCase()),'the same, in the other workspace and upper case');
 pass('Add member, staff creation, a second Add member, mixed case, the other workspace and an older pending registration are all refused with "An account already uses this email."');
 const same=fresh(),cross=fresh();
 const together=await Promise.all([prod.post('/api/members',{data:member(same)}),prod.post('/api/members',{data:member(same)})]);
 assert.deepEqual(together.map(r=>r.status()).sort(),[201,409],'same workspace');
 const across=await Promise.all([prod.post('/api/members',{data:member(cross)}),demo.post('/api/members',{data:member(cross)})]);
 assert.deepEqual(across.map(r=>r.status()).sort(),[201,409],'across workspaces');
 for(const response of [...together,...across])if(response.status()===409)assert.equal((await response.json()).error,MESSAGE);
 for(const e of [email,same,cross])assert.deepEqual(await accountsFor(e),{profiles:1,auth:1},`exactly one account for ${e}`);
 pass('Two simultaneous Add member requests for one email, in one workspace or across both, create exactly one account');
}finally{
 for(const e of emails){
  await db.from('ff_registrations').delete().eq('email',e).eq('status','awaiting_payment');
  for(const p of result(await db.from('ff_profiles').select('id,role').ilike('email',e))){
   if(p.role!=='member')continue;
   for(const table of ['ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',p.id));
   result(await db.from('ff_profiles').delete().eq('id',p.id));await db.auth.admin.deleteUser(p.id);
  }
 }
 for(const c of contexts)await c.dispose();demoServer.close();
}
