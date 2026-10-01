import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail } from './validation.js';
import { serviceClient, result } from './supabase.js';

export function paymentConfig(env) {
  const key=env.PAYMONGO_SECRET_KEY||'';
  const live=key.startsWith('sk_live_');
  const valid=live || key.startsWith('sk_test_');
  const workspace=env.APP_WORKSPACE||'production';
  const enabled=!!(valid && env.PAYMONGO_WEBHOOK_SECRET && env.SUPABASE_SECRET_KEY &&
    (live ? workspace==='production' && env.PAYMONGO_ALLOW_LIVE==='true' : workspace==='demo'));
  return {enabled,live,mode:live?'live':'test'};
}

export function verifySignature(raw, header, secret, live, now=Date.now()) {
  if(typeof header!=='string')fail('Missing payment signature.',400);
  const parts=Object.fromEntries(header.split(',').map(p=>p.trim().split('=')));
  const stamp=Number(parts.t),signature=parts[live?'li':'te'];
  if(!Number.isInteger(stamp)||Math.abs(now/1000-stamp)>300||! /^[a-f0-9]{64}$/i.test(signature||''))fail('Invalid payment signature.',400);
  const expected=createHmac('sha256',secret).update(parts.t+'.').update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))fail('Invalid payment signature.',400);
}

export function paidEvent(event,live) {
  const attributes=event.event_type==='send.webhook'?event.data:event.data?.attributes;
  if(attributes?.type!=='checkout_session.payment.paid')return null;
  const session=attributes.data, a=session?.attributes;
  if(attributes.livemode!==live || session?.type!=='checkout_session' || !/^cs_[A-Za-z0-9]+$/.test(session.id||''))fail('Invalid payment event.',400);
  const payments=a?.payments?.filter(p=>p.attributes?.status==='paid');
  if(payments?.length!==1)fail('Payment needs reconciliation.',400);
  const p=payments[0], v=p.attributes;
  if(!/^pay_[A-Za-z0-9]+$/.test(p.id||'') || v.currency!=='PHP' || !Number.isSafeInteger(v.amount) || v.amount<=0 || !['gcash','qrph'].includes(v.source?.type) || !/^[0-9a-f-]{36}$/i.test(a.reference_number||''))fail('Invalid payment details.',400);
  return {attempt_id:a.reference_number,session_id:session.id,provider_payment_id:p.id,amount:v.amount,channel:v.source.type,is_live:live};
}

export function checkoutURL(value) {
  let url;try{url=new URL(value);}catch{fail('Invalid checkout URL.',502);}
  if(url.protocol!=='https:'||url.hostname!=='checkout.paymongo.com'||url.username||url.password||url.port)fail('Invalid checkout URL.',502);
  return url.href;
}

export async function createCheckout(profile,invoiceId,env,fetcher=fetch) {
  const config=paymentConfig(env);
  if(!config.enabled)fail('Online payments are not configured for this workspace. Contact the gym.',503);
  if(profile.role!=='member'||!profile.enabled)fail('An active member account is required.',403);
  if(!/^[0-9a-f-]{36}$/i.test(invoiceId||''))fail('Select a valid invoice.');
  const db=serviceClient(env), candidate=randomUUID();
  const attempt=result(await db.rpc('ff_paymongo_reserve',{invoice:invoiceId,member:profile.id,w:profile.workspace,is_live:config.live,candidate}));
  if(attempt.checkout_url)return {url:checkoutURL(attempt.checkout_url),mode:config.mode};
  if(attempt.id!==candidate)fail('Checkout is being prepared or needs staff reconciliation. Do not pay again.',409);
  // Never automatically retry creation after a timeout: the provider may have created a session.
  let response;
  try {
    response=await fetcher('https://api.paymongo.com/v2/checkout_sessions',{
      method:'POST',signal:AbortSignal.timeout(20000),
      headers:{Authorization:'Basic '+Buffer.from(env.PAYMONGO_SECRET_KEY+':').toString('base64'),'Content-Type':'application/json'},
      body:JSON.stringify({data:{attributes:{
        line_items:[{name:'RepReady membership',amount:attempt.amount_cents,currency:'PHP',quantity:1}],
        payment_method_types:['gcash','qrph'],reference_number:attempt.id,
        success_url:env.APP_ORIGIN+'/?payment_return=1',cancel_url:env.APP_ORIGIN+'/?payment_return=cancelled',
        send_email_receipt:false,pass_on_fees:false,metadata:{attempt_id:attempt.id}
      }}})
    });
  }catch{fail('Checkout could not be confirmed. Contact staff before trying another payment.',502);}
  if(!response.ok)fail('The payment provider could not create checkout. Staff must review this attempt before you retry.',502);
  const session=(await response.json()).data;
  if(!/^cs_[A-Za-z0-9]+$/.test(session?.id||''))fail('Invalid payment provider response.',502);
  const url=checkoutURL(session.attributes?.checkout_url);
  result(await db.from('ff_paymongo_attempts').update({session_id:session.id,checkout_url:url}).eq('id',attempt.id));
  return {url,mode:config.mode};
}

export async function receiveWebhook(req,env) {
  const config=paymentConfig(env);if(!config.enabled)fail('Payment webhook is not configured.',503);
  let raw;
  if(Buffer.isBuffer(req.body))raw=req.body;
  else if(typeof req.body==='string')raw=Buffer.from(req.body);
  else if(req.body!==undefined)fail('Raw webhook body is required.',400);
  else {const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>262144)fail('Webhook is too large.',413);chunks.push(Buffer.from(chunk));}raw=Buffer.concat(chunks);}
  if(raw.length>262144)fail('Webhook is too large.',413);
  verifySignature(raw,req.headers['paymongo-signature'],env.PAYMONGO_WEBHOOK_SECRET,config.live);
  let event;try{event=JSON.parse(raw.toString());}catch{fail('Invalid webhook JSON.');}
  const payment=paidEvent(event,config.live);
  if(!payment)return {received:true};
  const outcome=result(await serviceClient(env).rpc('ff_paymongo_settle',payment));
  return {received:true,status:outcome};
}
