import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paymentConfig,verifySignature,paidEvent,checkoutURL } from '../src/paymongo.js';
const raw=Buffer.from('{"a":1}'), secret='unit-test-only', now=1700000000000;
const sig=createHmac('sha256',secret).update('1700000000.').update(raw).digest('hex');
test('raw webhook signature accepts correct bytes and rejects tampering, stale signatures and wrong mode',()=>{
  verifySignature(raw,`t=1700000000,te=${sig},li=`,secret,false,now);
  assert.throws(()=>verifySignature(Buffer.from('{"a":2}'),`t=1700000000,te=${sig}`,secret,false,now));
  assert.throws(()=>verifySignature(raw,`t=1700000000,te=${sig}`,secret,false,now+301000));
  assert.throws(()=>verifySignature(raw,`t=1700000000,te=${sig}`,secret,true,now));
});
test('test payments cannot settle production and live payments require explicit opt-in',()=>{
  const env={PAYMONGO_SECRET_KEY:'sk_test_fake',PAYMONGO_WEBHOOK_SECRET:'fake',SUPABASE_SECRET_KEY:'fake',APP_WORKSPACE:'demo'};
  assert.equal(paymentConfig(env).enabled,true);
  assert.equal(paymentConfig({...env,APP_WORKSPACE:'production'}).enabled,false);
  assert.equal(paymentConfig({...env,PAYMONGO_SECRET_KEY:'sk_live_fake'}).enabled,false);
  assert.equal(paymentConfig({...env,PAYMONGO_SECRET_KEY:'sk_live_fake',APP_WORKSPACE:'production',PAYMONGO_ALLOW_LIVE:'true'}).enabled,true);
});
function event(channel='gcash') {return {event_type:'send.webhook',data:{type:'checkout_session.payment.paid',livemode:false,data:{id:'cs_123',type:'checkout_session',attributes:{reference_number:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',payments:[{id:'pay_123',attributes:{status:'paid',amount:89900,currency:'PHP',source:{type:channel}}}]}}}};}
test('GCash and QR Ph confirmed events normalize, including legacy envelope',()=>{
  for(const channel of ['gcash','qrph'])assert.equal(paidEvent(event(channel),false).channel,channel);
  assert.equal(paidEvent({data:{attributes:event().data}},false).amount,89900);
  assert.equal(paidEvent({data:{attributes:{type:'payment.failed'}}},false),null);
});
test('mode mismatch, unsupported source, currency and ambiguous payments are rejected',()=>{
  assert.throws(()=>paidEvent(event(),true));assert.throws(()=>paidEvent(event('card'),false));
  const e=event();e.data.data.attributes.payments[0].attributes.currency='USD';assert.throws(()=>paidEvent(e,false));
  const other=event();other.data.data.attributes.payments.push(other.data.data.attributes.payments[0]);assert.throws(()=>paidEvent(other,false));
});
test('checkout redirects accept only the exact HTTPS provider hostname',()=>{
  assert.equal(checkoutURL('https://checkout.paymongo.com/test'),'https://checkout.paymongo.com/test');
  for(const url of ['javascript:alert(1)','https://checkout.paymongo.com.evil.test','https://evil.test','http://checkout.paymongo.com','https://user@checkout.paymongo.com'])assert.throws(()=>checkoutURL(url));
});
