import {createHmac,timingSafeEqual} from 'node:crypto';
import {serviceClient,result} from './supabase.js';
import {fail,HttpError} from './validation.js';
import {fulfillRegistration} from './onboarding.js';
import {requirePaymongoTestMode,PAYMONGO_METHODS as METHODS} from './paymongo-config.js';

const SESSION_ID=/^cs_[a-zA-Z0-9]+$/;
const PAYMENT_ID=/^pay_[a-zA-Z0-9]+$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validCheckoutUrl(value){
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='checkout.paymongo.com'&&!url.username&&!url.password&&!url.port;}catch{return false;}
}
function testResource(resource){
 if(resource?.livemode!==false)fail('Only PayMongo test resources are accepted.',409);
}
function testCheckout(row,env){
 requirePaymongoTestMode(env);
 if(row?.workspace!==(env.APP_WORKSPACE||'production')||row.livemode!==false)fail('PayMongo checkout does not match the current workspace or test mode.',409);
}
async function provider(env,path,body){
 requirePaymongoTestMode(env);
 let response;
 try{response=await fetch('https://api.paymongo.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(env.PAYMONGO_SECRET_KEY+':').toString('base64'),'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify({data:{attributes:body}})}:{}),signal:AbortSignal.timeout(15000)});}catch{fail('PayMongo could not be reached. Check the existing checkout before trying again.',502);}
 let value;try{value=await response.json();}catch{fail('PayMongo returned an unreadable response. Check the existing checkout.',502);}
 if(!response.ok){const error=new HttpError(502,'PayMongo could not complete this request.');error.definiteRejection=[400,401,403,422].includes(response.status);throw error;}
 return value.data;
}
export function checkoutView(row){
 return {id:row.id,status:row.status,url:validCheckoutUrl(row.checkout_url)?row.checkout_url:'',registrationId:row.registration_id,invoiceId:row.invoice_id,amount:row.amount_cents/100,reviewReason:row.review_reason||''};
}
function observation(session,payment){
 const a=payment?.attributes||{};
 return {sessionId:SESSION_ID.test(session?.id||'')?session.id:null,paymentId:PAYMENT_ID.test(payment?.id||'')?payment.id:null,
 amountCents:Number.isSafeInteger(a.amount)?a.amount:null,currency:typeof a.currency==='string'?a.currency.slice(0,10):null,
 source:typeof a.source?.type==='string'?a.source.type.slice(0,30):null,livemode:typeof a.livemode==='boolean'?a.livemode:null};
}
class VerificationError extends HttpError{
 constructor(category,details){super(409,'Payment requires staff review. Do not submit another payment.');this.category=category;this.details=details;}
}
function mismatch(category,session,payment){throw new VerificationError(category,observation(session,payment));}
export function validateSession(session,row,allowed=Object.keys(METHODS)){
 const a=session?.attributes;
 testResource(a);
 if(session?.id!==row.session_id||a.reference_number!==row.id||!['production','demo'].includes(row.workspace)||row.livemode!==false)mismatch('checkout_reference_mismatch',session);
 if(a.payment_intent?.attributes?.livemode===true)fail('Live payment resources are forbidden.',409);
 if(!Array.isArray(a.payments)&&a.payments!==undefined)mismatch('invalid_payment_collection',session);
 const all=a.payments||[];
 if(all.some(p=>p.attributes?.livemode===true))fail('Live payment resources are forbidden.',409);
 const payments=all.filter(p=>p.attributes?.status==='paid');
 if(!payments.length)return null;
 if(payments.length!==1)mismatch('multiple_paid_payments',session,payments[0]);
 const payment=payments[0],p=payment.attributes;
 if(!PAYMENT_ID.test(payment.id||''))mismatch('invalid_payment_id',session,payment);
 if(p.livemode!==false)mismatch('invalid_test_mode',session,payment);
 if(!Number.isSafeInteger(p.amount)||p.amount!==row.amount_cents)mismatch('amount_mismatch',session,payment);
 if(p.currency!=='PHP')mismatch('currency_mismatch',session,payment);
 if(!Object.hasOwn(METHODS,p.source?.type||'')||!row.methods.includes(p.source.type)||!allowed.includes(p.source.type))mismatch('method_mismatch',session,payment);
 if(row.status==='paid'&&row.payment_id!==payment.id)mismatch('additional_paid_reference',session,payment);
 return {paymentId:payment.id,source:p.source.type,amountCents:p.amount,currency:p.currency,livemode:false,status:'paid',reference:row.id};
}
async function review(db,row,error){
 if(error instanceof VerificationError)result(await db.rpc('ff_paymongo_review',{body:{id:row.id,category:error.category,...error.details}}));
 throw error;
}
async function bind(db,row,session){
 if(session.attributes.checkout_url!==undefined&&!validCheckoutUrl(session.attributes.checkout_url))mismatch('invalid_checkout_url',session);
 return result(await db.rpc('ff_paymongo_bind',{body:{id:row.id,sessionId:session.id,...(session.attributes.checkout_url?{url:session.attributes.checkout_url}:{})}}));
}
async function settle(db,row,session,env){
 const config=requirePaymongoTestMode(env);testCheckout(row,env);
 try{
  const paid=validateSession(session,row,config.methods);
  if(!paid)return row;
  const response=await db.rpc('ff_paymongo_settle',{body:{id:row.id,sessionId:row.session_id,...paid}});
  if(response.error){
   if(['23505','P0001'].includes(response.error.code))mismatch(response.error.code==='23505'?'provider_reference_reused':'settlement_conflict',session,session.attributes.payments.find(p=>p.attributes?.status==='paid'));
   return result(response);
  }
  return response.data;
 }catch(error){return review(db,row,error);}
}
async function completed(row,env,origin){
 let outcome;
 if(row.status==='paid'&&row.registration_id){
  const db=serviceClient(env),registration=result(await db.from('ff_registrations').select('*').eq('id',row.registration_id).eq('workspace',env.APP_WORKSPACE||'production').single());
  try{outcome=await fulfillRegistration(registration,env,origin);}catch{outcome={accountReady:!!registration.member_id,invitationSent:false,message:'Test payment confirmed. Account/email completion needs retry; do not pay again.'};}
 }
 // Notifications follow settlement; workspace-specific delivery policy remains unchanged.
 return {checkout:checkoutView(row),...(outcome||{})};
}
export async function createCheckout(client,body,env,origin){
 const config=requirePaymongoTestMode(env);
 if((body.livemode!==undefined&&body.livemode!==false)||body.liveMode===true||body.allowLive===true)fail('Live mode is forbidden.',400);
 const methods=Object.hasOwn(METHODS,body.method||'')?config.methods.filter(x=>x===body.method):body.method==='ewallet'?config.methods.filter(x=>x!=='card'):[];
 if(!methods.length)fail('This online payment method is not available.');
 // Deliberate allowlist: client prices/totals and claims never reach the financial RPC.
 const request={kind:body.kind,requestId:body.requestId,methods,livemode:false};
 for(const key of ['registrationId','invoiceId','memberId','plan','start','emailConfirmed'])if(body[key]!==undefined)request[key]=body[key];
 const prepared=result(await client.rpc('ff_paymongo_prepare',{body:request}));let row=prepared.checkout;
 testCheckout(row,env);
 if(!prepared.create){
  if(['failed','expired'].includes(row.status))fail('This checkout is closed. Reopen the payment screen to start another attempt.',409);
  return {checkout:checkoutView(row)};
 }
 const db=serviceClient(env);
 try{
  const session=await provider(env,'/v2/checkout_sessions',{line_items:[{name:prepared.description,amount:row.amount_cents,currency:'PHP',quantity:1}],payment_method_types:methods,
   billing:{name:prepared.name,email:prepared.email},reference_number:row.id,metadata:{repready_checkout:row.id},send_email_receipt:true,pass_on_fees:false,
   success_url:origin+'/?checkout='+row.id+'#/payments',cancel_url:origin+'/?checkout='+row.id+'#/payments'});
  if(!SESSION_ID.test(session?.id||'')||!validCheckoutUrl(session?.attributes?.checkout_url))mismatch('invalid_checkout_url',session);
  testResource(session.attributes);
  validateSession(session,{...row,session_id:session.id},config.methods);
  row=await bind(db,row,session);
 }catch(error){
  const existing=result(await db.from('ff_checkouts').select('*').eq('id',row.id).eq('workspace',env.APP_WORKSPACE||'production').single());
  if(existing.session_id){
   if(error instanceof VerificationError)return review(db,existing,error);
   if(error instanceof HttpError&&error.status===409)throw error;
   return {checkout:checkoutView(existing)};
  }
  if(error instanceof VerificationError)return review(db,row,error);
  if(error.definiteRejection)result(await db.from('ff_checkouts').update({status:'failed'}).eq('id',row.id).eq('status','creating'));
  else result(await db.rpc('ff_paymongo_review',{body:{id:row.id,category:'creation_outcome_uncertain'}}));
  if(error instanceof HttpError&&error.status===409)throw error;
  fail(error.definiteRejection?'PayMongo rejected checkout creation. Reopen payment after checking configuration.':'Checkout creation needs review. Do not submit another payment; recover the existing session.',502);
 }
 return {checkout:checkoutView(row)};
}
export async function reconcileCheckout(row,env,origin){
 testCheckout(row,env);const db=serviceClient(env);
 if(row.status==='creating'&&!row.session_id&&Date.parse(row.created_at)<Date.now()-120000)row=result(await db.rpc('ff_paymongo_review',{body:{id:row.id,category:'stale_creation_claim'}}));
 if(row.session_id){
  const session=await provider(env,'/v1/checkout_sessions/'+encodeURIComponent(row.session_id));
  try{
   const paid=validateSession(session,row,requirePaymongoTestMode(env).methods);
   if(paid)row=await settle(db,row,session,env);
   else if(row.status!=='paid'&&session.attributes.status==='expired')row=result(await db.from('ff_checkouts').update({status:'expired'}).eq('id',row.id).neq('status','paid').select('*').maybeSingle())||result(await db.from('ff_checkouts').select('*').eq('id',row.id).single());
  }catch(error){return review(db,row,error);}
 }
 return completed(row,env,origin);
}
export async function recoverCheckout(row,sessionId,env,origin){
 testCheckout(row,env);
 if(row.session_id||!['creating','needs_review'].includes(row.status)||!SESSION_ID.test(sessionId||''))fail('This checkout cannot be rebound.');
 const db=serviceClient(env),session=await provider(env,'/v1/checkout_sessions/'+sessionId);
 try{
  validateSession(session,{...row,session_id:sessionId},requirePaymongoTestMode(env).methods);
  if(!validCheckoutUrl(session.attributes.checkout_url))mismatch('invalid_checkout_url',session);
  row=await bind(db,row,session);
 }catch(error){return review(db,row,error);}
 return reconcileCheckout(row,env,origin);
}
export function verifySignature(raw,header,env,now=Date.now()){
 requirePaymongoTestMode(env);
 const parts={};
 for(const item of String(header||'').split(',')){
  const match=/^\s*(t|te|li)=([^,]*)\s*$/.exec(item);
  if(!match||Object.hasOwn(parts,match[1]))fail('Invalid PayMongo webhook signature.',401);
  parts[match[1]]=match[2].trim();
 }
 if(!/^\d+$/.test(parts.t||'')||!/^[a-f0-9]{64}$/i.test(parts.te||'')||parts.li)fail('Invalid PayMongo test webhook signature.',401);
 const timestamp=Number(parts.t);
 if(!Number.isSafeInteger(timestamp)||Math.abs(now/1000-timestamp)>300)fail('Invalid PayMongo webhook timestamp.',401);
 const expected=createHmac('sha256',env.PAYMONGO_WEBHOOK_SECRET).update(parts.t+'.').update(raw).digest();
 if(!timingSafeEqual(expected,Buffer.from(parts.te,'hex')))fail('Invalid PayMongo webhook signature.',401);
}
export async function handleWebhook(req,res,env,origin){
 requirePaymongoTestMode(env);
 if(req.method!=='POST')fail('Method not allowed.',405);
 const chunks=[];let size=0;
 if(req.body!==undefined){if(typeof req.body!=='string'&&!Buffer.isBuffer(req.body))fail('Webhook requires the original request bytes.',400);chunks.push(Buffer.from(req.body));size=chunks[0].length;}
 else for await(const chunk of req){size+=chunk.length;if(size>1000000)fail('Webhook is too large.',413);chunks.push(Buffer.from(chunk));}
 if(size>1000000)fail('Webhook is too large.',413);
 const raw=Buffer.concat(chunks);verifySignature(raw,req.headers['paymongo-signature'],env);
 let payload;try{payload=JSON.parse(raw.toString());}catch{fail('Invalid webhook payload.');}
 const event=payload.data?.attributes||payload.data;
 if(!event||typeof event.type!=='string')fail('Invalid webhook event.');
 testResource(event);
 if(event.type!=='checkout_session.payment.paid'){res.statusCode=200;return res.end(JSON.stringify({ok:true,ignored:true}));}
 const session=event.data;
 if(!SESSION_ID.test(session?.id||''))fail('Invalid checkout event.');
 testResource(session.attributes);
 const db=serviceClient(env);
 let row=result(await db.from('ff_checkouts').select('*').eq('session_id',session.id).eq('workspace',env.APP_WORKSPACE||'production').maybeSingle());
 if(!row&&UUID.test(session.attributes.reference_number||''))row=result(await db.from('ff_checkouts').select('*').eq('id',session.attributes.reference_number).eq('workspace',env.APP_WORKSPACE||'production').maybeSingle());
 if(!row)fail('Unknown PayMongo checkout. No payment was recorded.',404);
 testCheckout(row,env);
 let verifiedSession=session;
 try{
  const candidate={...row,session_id:row.session_id||session.id};
  if(!validateSession(verifiedSession,candidate,requirePaymongoTestMode(env).methods)){
   verifiedSession=await provider(env,'/v1/checkout_sessions/'+session.id);
   if(!validateSession(verifiedSession,candidate,requirePaymongoTestMode(env).methods))fail('Paid event is awaiting verification. Retry delivery.',503);
  }
  if(!row.session_id)row=await bind(db,row,verifiedSession);
  row=await settle(db,row,verifiedSession,env);
 }catch(error){return review(db,row,error);}
 await completed(row,env,origin);
 res.statusCode=200;res.end(JSON.stringify({ok:true}));
}
