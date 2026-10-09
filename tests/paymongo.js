import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {chromium} from 'playwright';
import {createClient} from '@supabase/supabase-js';
import {handle} from '../src/api.js';
import {POST as hostedWebhook} from '../api/paymongo-webhook.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// All credentials are generated in memory; mock transport never contacts PayMongo.
const env={...process.env,APP_WORKSPACE:'production',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex'),GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const db=serviceClient(env),fixtures=[],extraRegistrations=[];
async function fixture(role){
 const email='paymongo-'+role+'-'+randomUUID()+'@example.invalid',password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:role},user_metadata:{form_fitness:true,name:'LOCAL TEST '+role,phone:'09170000004',plan:'basic',start:today()}});assert.ifError(error);
 fixtures.push(data.user.id);return {id:data.user.id,email,password};
}
let staff,admin,other;
const memberPassword='Local9!'+randomBytes(24).toString('base64url');
const realFetch=globalThis.fetch,sessions=new Map();let count=0,origin,registrationId,memberId,browser;
let providerFailure=false,earlyWebhook=false,createReplyHook;let lastCreate;
globalThis.fetch=async(url,options)=>{
 if(!String(url).startsWith('https://api.paymongo.com/'))return realFetch(url,options);
 assert(options.headers.Authorization.startsWith('Basic '));
 if(options.method==='POST'){
  const a=JSON.parse(options.body).data.attributes;lastCreate=a;assert.equal(a.pass_on_fees,false);assert.equal(a.line_items[0].currency,'PHP');assert.equal(a.line_items[0].quantity,1);
  const id='cs_Local'+(++count),session={id,type:'checkout_session',attributes:{...a,livemode:false,status:'active',checkout_url:'https://checkout.paymongo.com/'+id,payments:[]}};sessions.set(id,session);if(earlyWebhook){pay(id,'gcash');const response=await webhook(session);assert.equal(response.status,200,await response.text());}if(createReplyHook)await createReplyHook(session);if(providerFailure)throw Error('Mock lost create response');return Response.json({data:{id:session.id,type:'checkout_session',attributes:{checkout_url:session.attributes.checkout_url,livemode:session.attributes.livemode,created_at:123,updated_at:123}}});
 }
 const id=String(url).split('/').at(-1);assert(sessions.has(id),'Existing session retrieved');return Response.json({data:sessions.get(id)});
};
const root=path.resolve('public');
const server=http.createServer(async(req,res)=>{if(req.url.startsWith('/api/'))return handle(req,res,{...env,APP_ORIGIN:origin});try{const file=path.resolve(root,'.'+new URL(req.url,origin).pathname);const target=file===root?path.join(root,'index.html'):file;assert(target.startsWith(root+path.sep));res.setHeader('Content-Type',target.endsWith('.js')?'application/javascript':target.endsWith('.css')?'text/css':'text/html');res.end(await readFile(target));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
let cookies='';
async function call(endpoint,body,status=200){const response=await realFetch(origin+'/api'+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookies},body:JSON.stringify(body)});if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const data=await response.json();assert.equal(response.status,status,data.error);return data;}
function pay(id,method){const s=sessions.get(id),amount=s.attributes.line_items[0].amount;s.attributes.payments=[{id:'pay_'+id.slice(3),attributes:{status:'paid',amount,currency:'PHP',livemode:false,source:{type:method}}}];}
async function webhook(session,{bad=false,stale=false,eventType='checkout_session.payment.paid',livemode=false}={}){const raw=JSON.stringify({data:{id:'evt_Local',attributes:{type:eventType,livemode,data:session}}});const timestamp=Math.floor(Date.now()/1000)-(stale?600:0),signature=createHmac('sha256',env.PAYMONGO_WEBHOOK_SECRET).update(timestamp+'.'+raw).digest('hex');return realFetch(origin+'/api/paymongo/webhook',{method:'POST',headers:{'Content-Type':'application/json','Paymongo-Signature':`t=${timestamp},te=${bad?'0'.repeat(64):signature},li=`},body:raw});}
try{
 staff=await fixture('staff');admin=await fixture('admin');other=await fixture('member');
 await call('/login',{email:staff.email,password:staff.password});
 const staffState=await realFetch(origin+'/api/state',{headers:{Cookie:cookies}}).then(r=>r.json());
 assert.equal(staffState.user.workspace,'production');assert.equal(staffState.paymongo.configured,true);assert.equal(staffState.paymongo.testMode,true);assert.deepEqual(staffState.paymongo.methods,['gcash','paymaya','grab_pay','card']);
 assert.equal(staffState.user.can.initiateOnlinePayment,true);assert.notEqual(staffState.user.can.recordOnlinePayment,true);
 const email='paymongo-local-'+randomUUID().slice(0,8)+'@example.invalid';
 const pending=await call('/members',{requestId:randomUUID(),name:'LOCAL TEST PayMongo',email,phone:'09170000004',plan:'basic',start:today()},201);registrationId=pending.registration.id;
 const request={kind:'registration',registrationId,emailConfirmed:true,method:'ewallet',requestId:randomUUID()};
 const key=env.PAYMONGO_SECRET_KEY;env.PAYMONGO_SECRET_KEY='';await call('/paymongo/checkout',request,503);env.PAYMONGO_SECRET_KEY=key;
 const first=await call('/paymongo/checkout',{...request,amount:1,price:1,total:1,amountCents:1});assert.equal(first.checkout.status,'pending');assert.equal((await call('/paymongo/checkout',request)).checkout.id,first.checkout.id);assert.equal(count,1);assert.equal(lastCreate.line_items[0].amount,pending.registration.amount_cents);assert.equal((await db.auth.admin.listUsers({perPage:1000})).data.users.some(u=>u.email===email),false,'No Auth account before verified payment');
 const row=result(await db.from('ff_checkouts').select('*').eq('id',first.checkout.id).single());assert.deepEqual(row.methods,['gcash','paymaya','grab_pay']);assert.equal(row.status,'pending');assert.equal(row.session_id,'cs_Local1');assert.equal(row.checkout_url,'https://checkout.paymongo.com/cs_Local1');assert.equal(row.review_reason,null,'Minimal V2 response binds without a reference mismatch');
 const unprivileged=createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});await unprivileged.auth.signInWithPassword({email:staff.email,password:staff.password});
 const forged=await unprivileged.rpc('ff_paymongo_settle',{body:{id:row.id,sessionId:row.session_id,amountCents:row.amount_cents,paymentId:'pay_Forged',method:'GCash'}});assert.equal(forged.error.code,'42501','Authenticated staff cannot forge provider settlement');
 await call('/registration-payment',{id:registrationId,amount:pending.registration.amount_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID()},400);
 assert.equal((await webhook(sessions.get(row.session_id),{bad:true})).status,401);assert.equal((await webhook(sessions.get(row.session_id),{stale:true})).status,401);
 assert.equal(result(await db.from('ff_registrations').select('status').eq('id',registrationId).single()).status,'awaiting_payment');
 pay(row.session_id,'gcash');
 const raw=JSON.stringify({event_type:'send.webhook',data:{type:'checkout_session.payment.paid',livemode:false,data:sessions.get(row.session_id)}}),t=Math.floor(Date.now()/1000),signature=createHmac('sha256',env.PAYMONGO_WEBHOOK_SECRET).update(t+'.'+raw).digest('hex');
 const previous={};for(const key of ['APP_ORIGIN','APP_WORKSPACE','PAYMONGO_ALLOW_LIVE','PAYMONGO_SECRET_KEY','PAYMONGO_WEBHOOK_SECRET']){previous[key]=process.env[key];process.env[key]=key==='APP_ORIGIN'?origin:env[key];}
 try{const response=await hostedWebhook(new Request(origin+'/api/paymongo/webhook',{method:'POST',headers:{'Content-Type':'application/json','Paymongo-Signature':`t=${t},te=${signature},li=`},body:raw}));assert.equal(response.status,200,await response.text());}
 finally{for(const key of Object.keys(previous)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
 for(let n=0;n<2;n++){const response=await webhook(sessions.get(row.session_id));assert.equal(response.status,200,await response.text());}
 const registered=result(await db.from('ff_registrations').select('*').eq('id',registrationId).single());memberId=registered.member_id;assert(memberId);assert.equal(registered.email_status,'sent');
 assert.equal(result(await db.from('ff_payments').select('*').eq('member_id',memberId)).length,1);
 const profile=result(await db.from('ff_profiles').select('role').eq('id',memberId).single());assert.equal(profile.role,'member');
 console.log('PASS: minimal V2 create without reference binds pending; e-wallet checkout, signed webhook, paid-first account/email, replay safety, cash collision guard and invalid/stale signatures');
 const next=result(await db.from('ff_memberships').select('*').eq('member_id',memberId).single()).end_date;const date=new Date(next+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1);
 const renewal=await call('/paymongo/checkout',{kind:'renewal',memberId,plan:'plus',start:date.toISOString().slice(0,10),method:'card',requestId:randomUUID()});
 const renewalRow=result(await db.from('ff_checkouts').select('*').eq('id',renewal.checkout.id).single());assert.deepEqual(renewalRow.methods,['card']);
 assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',renewalRow.invoice_id).single()).paid_cents,0,'Unverified renewal has no paid entitlement');
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',memberId)).length,1,'Unverified renewal creates no payment');
 const reusedRenewal=await call('/paymongo/checkout',{kind:'renewal',memberId,plan:'plus',start:date.toISOString().slice(0,10),method:'card',requestId:randomUUID()});assert.equal(reusedRenewal.checkout.id,renewalRow.id);assert.equal(result(await db.from('ff_memberships').select('id').eq('member_id',memberId)).length,2,'Repeat renewal reuses its unpaid cycle');
 await call('/payments',{invoiceId:renewalRow.invoice_id,amount:renewalRow.amount_cents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()},400);
 pay(renewalRow.session_id,'card');const session=sessions.get(renewalRow.session_id);session.attributes.payments[0].attributes.amount++;
 await call('/paymongo/status',{id:renewalRow.id},409);session.attributes.payments[0].attributes.amount--;
 for(let n=0;n<2;n++)assert.equal((await call('/paymongo/status',{id:renewalRow.id})).checkout.status,'paid');
 const cycles=result(await db.from('ff_memberships').select('*').eq('member_id',memberId));assert.equal(cycles.length,2);assert.equal(result(await db.from('ff_payments').select('*').eq('member_id',memberId)).length,2);
 console.log('PASS: card walk-in renewal, exact amount validation, invoice cash guard and duplicate reconciliation');
 // An invoice already created by the existing renewal flow is payable by the same gateway.
 const last=cycles.map(c=>c.end_date).sort().at(-1);const d=new Date(last+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);
 const invoice=await call('/renew',{memberId,plan:'basic',start:d.toISOString().slice(0,10)});
 const invoiceId=invoice.invoice?.id||invoice.invoiceId;
 assert(invoiceId,JSON.stringify(invoice));
 const recorded=await call('/paymongo/checkout',{kind:'invoice',invoiceId,method:'ewallet',requestId:randomUUID()});const recordedRow=result(await db.from('ff_checkouts').select('*').eq('id',recorded.checkout.id).single());pay(recordedRow.session_id,'paymaya');await call('/paymongo/status',{id:recordedRow.id});
 assert.equal(result(await db.from('ff_payments').select('*').eq('invoice_id',invoiceId).single()).method,'Maya');
 console.log('PASS: record-payment checkout settles an existing invoice using an e-wallet');
 await db.auth.admin.updateUserById(memberId,{password:memberPassword});
 const staffCookies=cookies;await call('/login',{email,password:memberPassword});
 await call('/paymongo/checkout',{...request,requestId:randomUUID()},403);
 await call('/paymongo/recover',{id:row.id,sessionId:row.session_id},403);
 const memberState=await realFetch(origin+'/api/state',{headers:{Cookie:cookies}}).then(x=>x.json());assert.equal(memberState.checkouts.length,2,'Registration checkout remains staff-only; own invoice checkouts visible');assert.equal(memberState.paymongo.configured,true);assert.equal(memberState.user.can.initiateOnlinePayment,true);assert.notEqual(memberState.user.can.recordOnlinePayment,true);
 const otherInvoiceBeforePayment=result(await db.from('ff_invoices').select('id').eq('member_id',other.id).single());
 const beforeDenied=count;await call('/paymongo/checkout',{kind:'invoice',invoiceId:otherInvoiceBeforePayment.id,method:'card',requestId:randomUUID()},403);assert.equal(count,beforeDenied,'Cross-member invoice is rejected before a provider request');
 // The member pays an invoice directly; an uncertain create never results in a replacement session.
 const end=result(await db.from('ff_memberships').select('end_date').eq('member_id',memberId).order('end_date',{ascending:false}).limit(1).single()).end_date;
 const start=new Date(end+'T12:00:00Z');start.setUTCDate(start.getUTCDate()+1);
 const ownInvoice=await call('/renew',{plan:'basic',start:start.toISOString().slice(0,10)});
 const ownRequest={kind:'invoice',invoiceId:ownInvoice.invoiceId,method:'card',requestId:randomUUID()};providerFailure=true;await call('/paymongo/checkout',ownRequest,502);providerFailure=false;
 const uncertain=await call('/paymongo/checkout',ownRequest);assert.equal(uncertain.checkout.status,'needs_review');const createdCount=count;
 assert.equal((await call('/paymongo/checkout',{...ownRequest,requestId:randomUUID()})).checkout.id,uncertain.checkout.id);assert.equal(count,createdCount);
 await call('/paymongo/recover',{id:uncertain.checkout.id,sessionId:'cs_Local'+count},403);
 await call('/login',{email:admin.email,password:admin.password});
 const recovered=await call('/paymongo/recover',{id:uncertain.checkout.id,sessionId:'cs_Local'+count});assert.equal(recovered.checkout.status,'pending');
 pay('cs_Local'+count,'card');await call('/login',{email,password:memberPassword});assert.equal((await call('/paymongo/status',{id:uncertain.checkout.id})).checkout.status,'paid');cookies=staffCookies;
 console.log('PASS: member self-payment, missing-key failure, uncertain checkout prevents double charge, and admin recovery verifies the existing session');
 // Configuration/request guards must fail before contacting the provider or writing a checkout.
 const beforeGuards=count;
 for(const change of [{PAYMONGO_SECRET_KEY:'sk_live_'+randomBytes(12).toString('hex')},{PAYMONGO_ALLOW_LIVE:'true'}]){
  const previous={};for(const key of Object.keys(change)){previous[key]=env[key];env[key]=change[key];}
  await call('/paymongo/checkout',request,503);
  Object.assign(env,previous);
 }
 await call('/paymongo/checkout',{...request,livemode:true},400);
 await call('/paymongo/checkout',{...request,method:'qrph'},400);
 await call('/paymongo/checkout',{kind:'invoice',invoiceId:randomUUID(),method:'card',requestId:randomUUID()},403);
 await call('/paymongo/checkout',{kind:'invoice',invoiceId,method:'card',requestId:randomUUID()},409);
 assert.equal(count,beforeGuards);
 const liveReplyRegistration=await call('/members',{requestId:randomUUID(),name:'LOCAL TEST Live rejection',email:'paymongo-live-reply-'+randomUUID()+'@example.invalid',phone:'09170000004',plan:'basic',start:today()},201);extraRegistrations.push(liveReplyRegistration.registration.id);
 createReplyHook=async s=>{s.attributes.livemode=true;};
 try{await call('/paymongo/checkout',{kind:'registration',registrationId:liveReplyRegistration.registration.id,emailConfirmed:true,method:'card',requestId:randomUUID()},409);}finally{createReplyHook=undefined;}
 const liveHeld=result(await db.from('ff_checkouts').select('status,livemode').eq('registration_id',liveReplyRegistration.registration.id).single());assert.equal(liveHeld.status,'needs_review');assert.equal(liveHeld.livemode,false);
 for(const rpc of ['ff_paymongo_settle','ff_paymongo_bind','ff_paymongo_review'])assert.equal((await unprivileged.rpc(rpc,{body:{id:row.id}})).error.code,'42501');
 assert((await unprivileged.from('ff_checkouts').update({status:'paid'}).eq('id',row.id)).error);
 const otherClient=createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 assert.ifError((await otherClient.auth.signInWithPassword(other)).error);
 assert.equal(result(await otherClient.from('ff_checkouts').select('id').eq('member_id',memberId)).length,0,'RLS denies another member checkouts');
 console.log('PASS: live/unsupported requests fail closed; paid/unknown invoices rejected; service-only RPCs and cross-member RLS');

 const otherInvoice=result(await db.from('ff_invoices').select('*').eq('member_id',other.id).single());
 // Pending manual submission prevents an online charge opportunity.
 await call('/login',other);
 const manualReference='LOCAL-'+randomUUID();
 const submission=result(await db.from('ff_submissions').insert({workspace:'production',member_id:other.id,invoice_id:otherInvoice.id,amount_cents:otherInvoice.amount_cents,method:'GCash',reference:manualReference,reference_key:'GCash:'+manualReference.replaceAll('-','').toUpperCase()}).select('id').single());
 await call('/paymongo/checkout',{kind:'invoice',invoiceId:otherInvoice.id,method:'card',requestId:randomUUID()},400);
 await call('/login',admin);await call('/review-payment',{id:submission.submission?.id||submission.id,approve:false});
 const testRequest={kind:'invoice',invoiceId:otherInvoice.id,method:'card',requestId:randomUUID()};
 const raced=await Promise.all([call('/paymongo/checkout',testRequest),call('/paymongo/checkout',{...testRequest,requestId:randomUUID()})]);
 assert.equal(raced[0].checkout.id,raced[1].checkout.id,'Target lock prevents duplicate concurrent creates');
 const testRow=result(await db.from('ff_checkouts').select('*').eq('id',raced[0].checkout.id).single()),testSession=sessions.get(testRow.session_id);
 await realFetch(origin+'/?payment_return=1&checkout='+testRow.id);assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',otherInvoice.id).single()).paid_cents,0,'Opening return URL is not proof');
 for(const status of ['pending','failed','cancelled','awaiting_payment_method']){pay(testRow.session_id,'card');testSession.attributes.payments[0].attributes.status=status;assert.equal((await call('/paymongo/status',{id:testRow.id})).checkout.status,'pending');}
 pay(testRow.session_id,'card');
 const original=structuredClone(testSession);
 for(const [change,category] of [[s=>s.attributes.reference_number=randomUUID(),'checkout_reference_mismatch'],[s=>s.attributes.payments[0].attributes.currency='USD','currency_mismatch'],[s=>s.attributes.payments[0].attributes.amount--,'amount_mismatch'],[s=>s.attributes.payments[0].attributes.amount++,'amount_mismatch'],[s=>s.attributes.payments[0].attributes.source.type='gcash','method_mismatch']]){
  Object.assign(testSession,structuredClone(original));change(testSession);assert.equal((await webhook(testSession)).status,409);
  const held=result(await db.from('ff_checkouts').select('*').eq('id',testRow.id).single());assert.equal(held.status,'needs_review');assert.equal(held.review_reason,category);assert(held.review_log.length>0);
  assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',otherInvoice.id).single()).paid_cents,0);
 }
 Object.assign(testSession,structuredClone(original));
 assert.equal((await webhook(testSession,{livemode:true})).status,409);
 const unknown=structuredClone(original);unknown.id='cs_Unknown';unknown.attributes.reference_number=randomUUID();assert.equal((await webhook(unknown)).status,404);
 const unknownSession=structuredClone(original);unknownSession.id='cs_Unknown';assert.equal((await webhook(unknownSession)).status,409,'Known reference cannot be rebound to another session');
 assert.equal((await webhook(testSession,{eventType:'payment.failed'})).status,200);
 testSession.attributes.payments[0].id=row.payment_id||'pay_'+row.session_id.slice(3);
 await call('/paymongo/status',{id:testRow.id},409);
 const rolledBack=result(await db.from('ff_checkouts').select('*').eq('id',testRow.id).single());assert.equal(rolledBack.payment_id,null);assert.equal(rolledBack.review_reason,'provider_reference_reused');
 assert.equal(result(await db.from('ff_payments').select('id').eq('invoice_id',otherInvoice.id)).length,0,'Unique provider ID rolls back payment/invoice/checkout together');
 const duplicateSession=await db.from('ff_checkouts').insert({id:randomUUID(),workspace:'production',created_by:admin.id,member_id:other.id,invoice_id:otherInvoice.id,amount_cents:otherInvoice.amount_cents,methods:['card'],livemode:false,status:'failed',session_id:row.session_id});assert.equal(duplicateSession.error.code,'23505');assert.match(duplicateSession.error.message,/session_id/);
 Object.assign(testSession,structuredClone(original));await Promise.all([webhook(testSession),webhook(testSession)]).then(responses=>responses.forEach(r=>assert.equal(r.status,200)));
 assert.equal(result(await db.from('ff_payments').select('id').eq('invoice_id',otherInvoice.id)).length,1);
 assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',otherInvoice.id).single()).paid_cents,otherInvoice.amount_cents);
 console.log('PASS: manual conflict, concurrent checkout reuse, return/failure non-settlement, persisted mismatches, unknown/live events, unique IDs and atomic concurrent settlement');

 // A signed payment can arrive before the create response has been saved.
 await call('/login',staff);
 const early=await call('/members',{requestId:randomUUID(),name:'LOCAL TEST Early',email:'paymongo-early-'+randomUUID()+'@example.invalid',phone:'09170000004',plan:'basic',start:today()},201);extraRegistrations.push(early.registration.id);
 earlyWebhook=true;
 let earlyResult;try{earlyResult=await call('/paymongo/checkout',{kind:'registration',registrationId:early.registration.id,emailConfirmed:true,method:'gcash',requestId:randomUUID()});}finally{earlyWebhook=false;}
 assert.equal(earlyResult.checkout.status,'paid');
 const earlyReg=result(await db.from('ff_registrations').select('*').eq('id',early.registration.id).single());fixtures.push(earlyReg.member_id);assert(earlyReg.member_id);
 for(let n=0;n<2;n++)assert.equal((await webhook(sessions.get(result(await db.from('ff_checkouts').select('session_id').eq('id',earlyResult.checkout.id).single()).session_id))).status,200);
 assert.equal(result(await db.from('ff_memberships').select('id').eq('member_id',earlyReg.member_id)).length,1);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',earlyReg.member_id)).length,1);
 console.log('PASS: early webhook binds the durable reference safely; account/cycle/invoice/payment provision once');
 // Reproduce the old unbound create-response mismatch, using the saved provider ID only.
 const oldCreate=await call('/members',{requestId:randomUUID(),name:'LOCAL TEST Old create recovery',email:'paymongo-recovery-'+randomUUID()+'@example.invalid',phone:'09170000004',plan:'basic',start:today()},201);extraRegistrations.push(oldCreate.registration.id);
 providerFailure=true;try{await call('/paymongo/checkout',{kind:'registration',registrationId:oldCreate.registration.id,emailConfirmed:true,method:'gcash',requestId:randomUUID()},502);}finally{providerFailure=false;}
 const savedSessionId='cs_Local'+count,oldRow=result(await db.from('ff_checkouts').select('*').eq('registration_id',oldCreate.registration.id).single());
 result(await db.rpc('ff_paymongo_review',{body:{id:oldRow.id,category:'checkout_reference_mismatch',sessionId:savedSessionId}}));
 await call('/login',admin);const oldSession=sessions.get(savedSessionId),realReference=oldSession.attributes.reference_number,createsBeforeRecovery=count;
 oldSession.attributes.reference_number=randomUUID();await call('/paymongo/recover',{id:oldRow.id,sessionId:savedSessionId},409);
 assert.equal(result(await db.from('ff_checkouts').select('session_id').eq('id',oldRow.id).single()).session_id,null,'Wrong GET reference cannot bind');
 oldSession.attributes.reference_number=realReference;
 const repaired=await call('/paymongo/recover',{id:oldRow.id});assert.equal(repaired.checkout.status,'pending');assert.equal(repaired.checkout.reviewReason,'');assert.equal(repaired.checkout.url,oldSession.attributes.checkout_url);assert.equal(count,createsBeforeRecovery,'Recovery performs GET only, never another POST');
 const repairedRow=result(await db.from('ff_checkouts').select('*').eq('id',oldRow.id).single());assert.equal(repairedRow.session_id,savedSessionId);assert.equal(repairedRow.review_details.sessionId,savedSessionId,'Recovery preserves the original audit details');
 assert.equal(result(await db.from('ff_registrations').select('status,member_id').eq('id',oldCreate.registration.id).single()).member_id,null,'Recovery alone cannot provision an unpaid registration');
 oldSession.attributes.status='expired';assert.equal((await call('/paymongo/status',{id:oldRow.id})).checkout.status,'expired');
 assert.equal(result(await db.from('ff_registrations').select('status').eq('id',oldCreate.registration.id).single()).status,'awaiting_payment');
 console.log('PASS: saved-ID recovery strictly verifies GET, preserves audit history, clears only the old creation error and never creates or credits a second checkout');
 await call('/login',staff);
 // Render all three selectors and a generated checkout QR in real Edge.
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();await page.route('https://checkout.paymongo.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Simulated PayMongo checkout</h1>'}));await page.goto(origin);await page.getByLabel('Email address',{exact:true}).fill(staff.email);await page.getByLabel('Password',{exact:true}).fill(staff.password);await page.getByRole('button',{name:'Log in',exact:true}).click();await page.getByRole('button',{name:'Add member',exact:true}).waitFor();
 await page.evaluate(()=>{const r=state.registrations.find(x=>x.name==='LOCAL TEST PayMongo');registrationCash({...r,status:'awaiting_payment'});});
 assert.equal(await page.locator('#registration-channel optgroup[label="Pay online (TEST MODE)"] option:not(:disabled)').count(),4,'Staff can choose all configured online methods without recordOnlinePayment');
 await page.selectOption('#registration-channel','card');assert.equal(await page.locator('#registration-cash-confirmed').isVisible(),false);assert.equal(await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).count(),1);
 await page.setViewportSize({width:390,height:844});await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/paymongo-first-methods.png'});await page.keyboard.press('Escape');
 await page.evaluate(id=>walkinRenew(id),memberId);await page.selectOption('#renewal-channel','grab_pay');assert.equal(await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).count(),1);await page.keyboard.press('Escape');
 await page.evaluate(()=>showPaymongo({id:'local',status:'pending',url:'https://checkout.paymongo.com/cs_Local',amount:999}));await page.waitForFunction(()=>document.getElementById('checkout-link-qr')?.width===210);
 await page.keyboard.press('Escape');
 await page.evaluate(()=>showPaymongo({id:'local',status:'pending',url:'https://checkout.paymongo.com.evil.example/x',amount:999}));assert.equal(await page.getByRole('link',{name:'Open secure checkout'}).count(),0);await page.keyboard.press('Escape');
 const latest=result(await db.from('ff_memberships').select('end_date').eq('member_id',memberId).order('end_date',{ascending:false}).limit(1).single()).end_date;
 const nextStart=new Date(latest+'T12:00:00Z');nextStart.setUTCDate(nextStart.getUTCDate()+1);
 const browserInvoice=await call('/renew',{memberId,plan:'basic',start:nextStart.toISOString().slice(0,10)});
 await page.evaluate(async id=>{await refreshData();pay(id);},browserInvoice.invoiceId);await page.selectOption('#invoice-channel','card');
 let releaseCreate;const createGate=new Promise(resolve=>{releaseCreate=resolve;});let uiRequests=0;
 await page.route(origin+'/api/paymongo/checkout',async route=>{uiRequests++;await createGate;await route.continue();});
 const continueButton=page.getByRole('button',{name:'Continue to secure checkout',exact:true});await continueButton.click();await page.waitForFunction(()=>document.querySelector('[form="payment-form"]').disabled);
 await page.evaluate(()=>document.getElementById('payment-form').requestSubmit());assert.equal(uiRequests,1,'A repeated submit while busy sends one checkout request');
 releaseCreate();await page.waitForURL('https://checkout.paymongo.com/**');assert.equal(uiRequests,1);await page.unroute(origin+'/api/paymongo/checkout');
 const browserRow=result(await db.from('ff_checkouts').select('*').eq('invoice_id',browserInvoice.invoiceId).single());await page.goto(origin+'/?checkout='+browserRow.id+'#/payments');await page.getByRole('button',{name:'Check payment status',exact:true}).waitFor();pay(browserRow.session_id,'card');await page.getByRole('button',{name:'Check payment status',exact:true}).click();await page.locator('#checkout-link-qr').waitFor({state:'detached'});
 assert.equal(result(await db.from('ff_invoices').select('amount_cents,paid_cents').eq('id',browserInvoice.invoiceId).single()).paid_cents,browserRow.amount_cents);
 await page.evaluate(id=>walkinRenew(id),memberId);await page.selectOption('#renewal-channel','grab_pay');await page.check('#walkin-verified');await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).click();await page.waitForURL('https://checkout.paymongo.com/**');
 const browserRenew=result(await db.from('ff_checkouts').select('*').eq('member_id',memberId).eq('status','pending').single());pay(browserRenew.session_id,'grab_pay');await page.goto(origin+'/?checkout='+browserRenew.id+'#/payments');await page.getByRole('button',{name:'Add member',exact:true}).waitFor();await page.waitForFunction(()=>state.checkouts.some(c=>c.id===new URL(location.href).searchParams.get('checkout')&&c.status==='paid'));
 assert.equal(result(await db.from('ff_payments').select('method').eq('invoice_id',browserRenew.invoice_id).single()).method,'GrabPay');
 console.log('PASS: staff/member isolation, mobile selectors, no cash checkbox on card checkout, and scannable hosted-checkout QR');
 console.log('PASS: actual record-payment card and walk-in e-wallet form submissions create and verify checkouts');
 const uiRegistration=await call('/members',{requestId:randomUUID(),name:'LOCAL TEST Browser first payment',email:'paymongo-browser-'+randomUUID()+'@example.invalid',phone:'09170000004',plan:'basic',start:today()},201);extraRegistrations.push(uiRegistration.registration.id);
 await page.evaluate(async id=>{await refreshData();registrationCash(state.registrations.find(r=>r.id===id));},uiRegistration.registration.id);await page.selectOption('#registration-channel','gcash');await page.check('#registration-email-confirmed');
 const createdResponse=page.waitForResponse(r=>r.url()===origin+'/api/paymongo/checkout');await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).click();assert.equal((await createdResponse).status(),200);await page.waitForURL('https://checkout.paymongo.com/**');
 const uiRow=result(await db.from('ff_checkouts').select('*').eq('registration_id',uiRegistration.registration.id).single());assert.equal(uiRow.status,'pending');assert.equal(new URL(page.url()).pathname,'/'+uiRow.session_id);
 pay(uiRow.session_id,'gcash');assert.equal((await webhook(sessions.get(uiRow.session_id))).status,200);
 const uiPaid=result(await db.from('ff_registrations').select('status,member_id').eq('id',uiRegistration.registration.id).single());assert.equal(uiPaid.status,'provisioned');assert(uiPaid.member_id);fixtures.push(uiPaid.member_id);
 assert.equal(result(await db.from('ff_payments').select('id').eq('member_id',uiPaid.member_id)).length,1);
 console.log('PASS: staff first-registration GCash form returns 200, redirects immediately and auto-provisions exactly once after a signed simulated webhook');
 const memberContext=await browser.newContext(),memberPage=await memberContext.newPage();await memberPage.goto(origin);await memberPage.getByLabel('Email address',{exact:true}).fill(other.email);await memberPage.getByLabel('Password',{exact:true}).fill(other.password);await memberPage.getByRole('button',{name:'Log in',exact:true}).click();await memberPage.waitForFunction(()=>currentUser?.role==='member');
 const manualInvoice=await call('/renew',{memberId:other.id,plan:'basic',start:date.toISOString().slice(0,10)});
 await memberPage.evaluate(async id=>{await refreshData();pay(id);},manualInvoice.invoiceId);
 assert.deepEqual(await memberPage.locator('#invoice-channel option').evaluateAll(options=>options.map(o=>o.value)),['gcash','paymaya','grab_pay','card']);
 assert.equal(await memberPage.locator('#invoice-channel option:not(:disabled)').count(),4,'Member owns the invoice and needs no staff/admin capability');
 await memberPage.getByRole('button',{name:'Cash / Manual payment',exact:true}).click();assert.equal(await memberPage.getByRole('button',{name:'Bank transfer',exact:true}).count(),1);
 await memberPage.keyboard.press('Escape');
 await memberPage.evaluate(()=>{state.paymongo.methods=['card'];pay(state.invoices.find(i=>balance(i)>0).id);});assert.equal(await memberPage.locator('#invoice-channel option').count(),1);assert.equal(await memberPage.locator('#invoice-channel').inputValue(),'card');
 await call('/login',other);
 const returnedCheckout=await call('/paymongo/checkout',{kind:'invoice',invoiceId:manualInvoice.invoiceId,method:'card',requestId:randomUUID()});assert.equal(returnedCheckout.checkout.status,'pending','Member initiates a fresh hosted checkout for their own invoice');
 const returnPage=await memberPage.context().newPage();await returnPage.goto(origin+'/?payment_return=1&checkout='+returnedCheckout.checkout.id+'#/payments');await returnPage.getByRole('button',{name:'Check payment status',exact:true}).waitFor();
 assert.match(await returnPage.locator('.modal-head p').innerText(),/Waiting for PayMongo/);
 assert.equal(result(await db.from('ff_invoices').select('paid_cents').eq('id',manualInvoice.invoiceId).single()).paid_cents,0,'Actual browser return page cannot settle an unpaid checkout');
 const returnRow=result(await db.from('ff_checkouts').select('session_id').eq('id',returnedCheckout.checkout.id).single());sessions.get(returnRow.session_id).attributes.status='expired';
 await returnPage.getByRole('button',{name:'Check payment status',exact:true}).click();await returnPage.getByRole('button',{name:'Check payment status',exact:true}).waitFor({state:'detached'});
 assert.equal(result(await db.from('ff_checkouts').select('status').eq('id',returnedCheckout.checkout.id).single()).status,'expired');
 assert.equal(result(await db.from('ff_payments').select('id').eq('invoice_id',manualInvoice.invoiceId)).length,0,'Verified expiry releases target without recording payment');
 console.log('PASS: member manual/method filtering UI, real browser return stays unpaid, and verified expiry records no credit');
}finally{
 if(browser)await browser.close();globalThis.fetch=realFetch;server.close();
 // Delete only UUIDs created by this suite, never historical/demo user records.
 for(const rid of [registrationId,...extraRegistrations].filter(Boolean))result(await db.from('ff_checkouts').delete().eq('registration_id',rid));
 for(const uid of [memberId,...fixtures].filter(Boolean))result(await db.from('ff_checkouts').delete().eq('member_id',uid));
 for(const rid of [registrationId,...extraRegistrations].filter(Boolean))result(await db.from('ff_registrations').delete().eq('id',rid));
 for(const uid of [memberId,...fixtures].filter(Boolean)){
  for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',uid));
 }
 for(const uid of [memberId,...fixtures].filter(Boolean)){
  result(await db.from('ff_profiles').delete().eq('id',uid));await db.auth.admin.deleteUser(uid);
 }
}
