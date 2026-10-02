import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname));
const db=serviceClient();const staff=JSON.parse(await readFile('.local/local-test-credentials.json','utf8')).accounts.find(a=>a.role==='staff');
const server=http.createServer((req,res)=>handle(req,res,{...process.env,APP_ORIGIN:origin}));let origin,registrationId,conflictId,memberId;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;let cookies='';
const call=async(path,body,status=200)=>{const response=await fetch(origin+'/api'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookies},body:JSON.stringify(body)});if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const data=await response.json();assert.equal(response.status,status,data.error);return data;};
try{
 await call('/login',{email:staff.email,password:staff.password});
 const email=`resilience-${randomUUID().slice(0,8)}@example.invalid`,requestId=randomUUID();
 const details={name:'LOCAL TEST Resilience',email,phone:'09170000007',plan:'basic',start:today(),requestId};
 const pending=await call('/members',details,201);registrationId=pending.registration.id;
 assert.equal((await call('/members',details,201)).registration.id,registrationId);
 await call('/members',{...details,name:'Different Name'},400);
 await call('/registration-payment',{id:registrationId,amount:pending.registration.amount_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID(),retryEmail:true,emailChecked:false},400);
 assert.equal(result(await db.from('ff_registrations').select('status').eq('id',registrationId).single()).status,'awaiting_payment','Invalid email retry must not record cash');
 // An external account appears after registration but before collection.
 const conflict=await db.auth.admin.createUser({email,password:'ConflictFixture2026!',email_confirm:true});assert.equal(conflict.error,null);conflictId=conflict.data.user.id;
 const payment={id:registrationId,amount:pending.registration.amount_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID()};
 const blocked=await call('/registration-payment',payment);assert.equal(blocked.accountReady,false);assert.equal(blocked.registration.status,'paid');
 assert.equal(result(await db.from('ff_registrations').select('*').eq('id',registrationId).single()).amount_cents,pending.registration.amount_cents);
 const removed=await db.auth.admin.deleteUser(conflictId);assert.equal(removed.error,null);conflictId=null;
 const finished=await call('/registration-fulfill',{id:registrationId});memberId=finished.registration.member_id;assert.equal(finished.accountReady,true);assert.equal(finished.invitationSent,true);
 const again=await call('/registration-payment',payment);assert.equal(again.registration.member_id,memberId);
 const payments=result(await db.from('ff_payments').select('*').eq('member_id',memberId));assert.equal(payments.length,1);assert.equal(payments[0].amount_cents,pending.registration.amount_cents);
 // Simulate a definite delivery failure and require staff acknowledgement for resend.
 result(await db.from('ff_registrations').update({email_status:'failed'}).eq('id',registrationId));
 await call('/registration-fulfill',{id:registrationId,retryEmail:true,emailChecked:false},400);
 const retried=await call('/registration-fulfill',{id:registrationId,retryEmail:true,emailChecked:true});assert.equal(retried.accountReady,true);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,1);
 console.log('PASS: pending registration retries are idempotent; account collision preserves cash; completion retries create one account/payment; email retry requires review');
}finally{
 server.close();if(registrationId)result(await db.from('ff_registrations').delete().eq('id',registrationId));if(conflictId)await db.auth.admin.deleteUser(conflictId);
 if(memberId){for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',memberId));result(await db.from('ff_profiles').delete().eq('id',memberId));await db.auth.admin.deleteUser(memberId);}
}
