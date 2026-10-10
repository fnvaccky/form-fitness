import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {request} from 'playwright';
import {serviceClient,result} from '../src/supabase.js';
import {handle} from '../src/api.js';
import {today} from '../src/validation.js';
// One email, one account, end to end against the local stack: the running dev server for the
// production workspace and an in-process handler for the demo workspace. It records no payment, and
// removes only the pending registrations it created.
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
const registration=email=>({name:'LOCAL TEST Email Rule',email,phone:'09170000061',plan:'basic',start:today(),goal:'Improve fitness',requestId:randomUUID()});
const fresh=()=>{const email=`local-email-rule-${randomUUID().slice(0,8)}@example.invalid`;emails.push(email);return email;};
async function refused(c,path,body,label){const r=await c.post('/api'+path,{data:body});const data=await r.json();assert.equal(r.status(),409,`${label}: ${r.status()} ${data.error}`);assert.equal(data.error,MESSAGE,label);}
try{
 const prod=await signIn(origin,accounts.find(a=>a.role==='admin')),demo=await signIn(demoOrigin,demoAccounts.find(a=>a.role==='admin'));
 const email=fresh();
 assert.equal((await prod.post('/api/members',{data:registration(email)})).status(),201);
 pass('Normal registration with a new email still works');
 await refused(prod,'/members',registration(email),'second registration of a pending email');
 await refused(prod,'/members',registration(email.toUpperCase()),'same email in upper case');
 await refused(demo,'/members',registration(email),'same email in the other workspace');
 await refused(prod,'/staff',{name:'LOCAL TEST Email Rule',email,phone:'09170000062'},'staff creation with a pending email');
 for(const role of ['admin','staff','member'])await refused(prod,'/members',registration(accounts.find(a=>a.role===role).email),`registration with an existing ${role}'s email`);
 pass('Member registration, staff creation, a second registration, mixed case and the other workspace are all refused with "An account already uses this email."');
 const same=fresh(),cross=fresh();
 const together=await Promise.all([prod.post('/api/members',{data:registration(same)}),prod.post('/api/members',{data:registration(same)})]);
 assert.deepEqual(together.map(r=>r.status()).sort(),[201,409],'same workspace');
 const across=await Promise.all([prod.post('/api/members',{data:registration(cross)}),demo.post('/api/members',{data:registration(cross)})]);
 assert.deepEqual(across.map(r=>r.status()).sort(),[201,409],'across workspaces');
 for(const e of [email,same,cross])assert.equal(result(await db.from('ff_registrations').select('id').eq('email',e)).length,1,`exactly one registration for ${e}`);
 pass('Two simultaneous registrations of one email, in one workspace or across both, create exactly one');
}finally{
 for(const e of emails)await db.from('ff_registrations').delete().eq('email',e).eq('status','awaiting_payment');
 for(const c of contexts)await c.dispose();demoServer.close();
}
