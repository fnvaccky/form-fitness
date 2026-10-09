import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {paymongoConfiguration,requirePaymongoTestMode} from '../src/paymongo-config.js';
import {validCheckoutUrl,validateCreatedSession,validateSession,verifySignature,handleWebhook} from '../src/paymongo.js';

// Ephemeral synthetic signing/configuration values; no merchant credentials or network calls.
const env={APP_WORKSPACE:'production',PAYMONGO_ALLOW_LIVE:'false',PAYMONGO_SECRET_KEY:'sk_test_'+randomBytes(24).toString('hex'),PAYMONGO_WEBHOOK_SECRET:randomBytes(32).toString('hex')};
const id=randomUUID(),row={id,workspace:'production',livemode:false,session_id:'cs_Unit',amount_cents:89900,status:'pending',methods:['gcash','paymaya','grab_pay','card']};
const session=()=>({id:row.session_id,attributes:{reference_number:id,livemode:false,payments:[{id:'pay_Unit',attributes:{livemode:false,status:'paid',amount:89900,currency:'PHP',source:{type:'gcash'}}}]}});
const header=(raw,t=Math.floor(Date.now()/1000))=>`t=${t},te=${createHmac('sha256',env.PAYMONGO_WEBHOOK_SECRET).update(t+'.').update(raw).digest('hex')},li=`;

test('PayMongo test configuration works in a production-named workspace and exposes no secrets',()=>{
 assert.equal(paymongoConfiguration(env).configured,true);
 assert.equal(paymongoConfiguration(env).testMode,true);
 assert.deepEqual(paymongoConfiguration(env).methods,['gcash','paymaya','grab_pay','card']);
 for(const workspace of ['production','demo',undefined])assert.equal(requirePaymongoTestMode({...env,APP_WORKSPACE:workspace}).configured,true);
 for(const change of [{PAYMONGO_SECRET_KEY:'sk_live_'+randomBytes(12).toString('hex')},{PAYMONGO_ALLOW_LIVE:'true'},{PAYMONGO_WEBHOOK_SECRET:''},{PAYMONGO_SECRET_KEY:''},{PAYMONGO_METHODS:'unknown'}]){
  assert.equal(paymongoConfiguration({...env,...change}).configured,false);assert.throws(()=>requirePaymongoTestMode({...env,...change}));
 }
 const publicConfig=JSON.stringify(paymongoConfiguration(env));assert(!publicConfig.includes(env.PAYMONGO_SECRET_KEY));assert(!publicConfig.includes(env.PAYMONGO_WEBHOOK_SECRET));
 assert.deepEqual(paymongoConfiguration({...env,PAYMONGO_METHODS:'card,gcash,card'}).methods,['card','gcash']);
 assert.equal(paymongoConfiguration({...env,PAYMONGO_METHODS:'gcash,unknown'}).configured,true);
 assert.deepEqual(paymongoConfiguration({...env,PAYMONGO_METHODS:'gcash,unknown'}).methods,['gcash']);
});
test('signature validates exact raw bytes, not reserialized JSON',()=>{
 const raw=Buffer.from('{ "unicode": "₱", "data": {} }\n');verifySignature(raw,header(raw),env);
 assert.throws(()=>verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw))),header(raw),env));
 assert.throws(()=>verifySignature(Buffer.concat([raw,Buffer.from(' ')]),header(raw),env));
});
test('missing, malformed, incorrect, stale, future and live signatures fail',()=>{
 const raw=Buffer.from('{}'),t=Math.floor(Date.now()/1000);
 for(const value of [undefined,'t=no,te=abc',`t=${t},te=${'0'.repeat(64)},li=`,header(raw,t-301),header(raw,t+301),`t=${t},li=${'a'.repeat(64)}`,header(raw)+',t='+t,header(raw).replace('li=','li='+'a'.repeat(64))])assert.throws(()=>verifySignature(raw,value,env));
});
test('checkout URLs require HTTPS, exact hostname and no credentials',()=>{
 assert(validCheckoutUrl('https://checkout.paymongo.com/cs_Unit'));
 for(const url of ['http://checkout.paymongo.com/x','javascript:alert(1)','data:text/plain,x','https://checkout.paymongo.com.evil.example/x','https://evil.example/x','https://user:pass@checkout.paymongo.com/x','https://checkout.paymongo.com:8443/x','/checkout',null])assert.equal(validCheckoutUrl(url),false);
});
test('all four enabled provider sources verify a paid PHP snapshot',()=>{
 for(const source of row.methods){const s=session();s.attributes.payments[0].attributes.source.type=source;assert.equal(validateSession(s,row,row.methods).source,source);}
});
test('V2 creation accepts the minimal response without verification-time fields',()=>{
 const created={id:'cs_Minimal',type:'checkout_session',attributes:{checkout_url:'https://checkout.paymongo.com/cs_Minimal',livemode:false,created_at:123,updated_at:123}};
 assert.doesNotThrow(()=>validateCreatedSession(created));
 assert.throws(()=>validateSession(created,{...row,session_id:created.id}),/could not be confirmed/,'GET/webhook still requires the exact reference');
});
test('V2 creation still rejects invalid session IDs, missing attributes, unsafe URLs and live resources',()=>{
 const created=()=>({id:'cs_Minimal',attributes:{checkout_url:'https://checkout.paymongo.com/cs_Minimal',livemode:false}});
 for(const change of [s=>s.id='bad',s=>delete s.attributes,s=>s.attributes=[],s=>delete s.attributes.checkout_url,s=>s.attributes.checkout_url='https://checkout.paymongo.com.evil.example/x',s=>s.attributes.livemode=true,s=>delete s.attributes.livemode]){
  const s=created();change(s);assert.throws(()=>validateCreatedSession(s));
 }
});
test('failed, pending, cancelled, expired and awaiting-method payments cannot settle',()=>{
 for(const status of ['failed','pending','cancelled','expired','awaiting_payment_method']){const s=session();s.attributes.payments[0].attributes.status=status;assert.equal(validateSession(s,row,row.methods),null);}
});
test('session, reference, amount, currency, method and mode mismatches are rejected',()=>{
 const changes=[s=>s.id='cs_Other',s=>s.attributes.reference_number=randomUUID(),s=>s.attributes.livemode=true,s=>delete s.attributes.livemode,s=>s.attributes.payments[0].attributes.livemode=true,s=>s.attributes.payments[0].attributes.amount--,s=>s.attributes.payments[0].attributes.amount++,s=>s.attributes.payments[0].attributes.amount='89900',s=>s.attributes.payments[0].attributes.currency='USD',s=>s.attributes.payments[0].attributes.source.type='qrph',s=>s.attributes.payments[0].id='bad'];
 for(const change of changes){const s=session();change(s);assert.throws(()=>validateSession(s,row,row.methods));}
 assert.throws(()=>validateSession(session(),row,['card']));
 assert.throws(()=>validateSession(session(),{...row,methods:['card']},row.methods));
});
test('additional paid references cannot overwrite an already settled checkout',()=>{
 assert.equal(validateSession(session(),{...row,status:'paid',payment_id:'pay_Unit'},row.methods).paymentId,'pay_Unit');
 assert.throws(()=>validateSession(session(),{...row,status:'paid',payment_id:'pay_Other'},row.methods));
 const s=session();s.attributes.payments.push({...s.attributes.payments[0],id:'pay_Second'});assert.throws(()=>validateSession(s,row,row.methods));
});
test('unrelated signed test events are acknowledged; live events are rejected',async()=>{
 const raw=Buffer.from(JSON.stringify({data:{attributes:{type:'payment.failed',livemode:false}}}));
 const res={end(value){this.body=JSON.parse(value);}};
 await handleWebhook({method:'POST',body:raw,headers:{'paymongo-signature':header(raw)}},res,env,'https://example.invalid');assert.equal(res.statusCode,200);assert.equal(res.body.ignored,true);
 const live=Buffer.from(JSON.stringify({data:{attributes:{type:'payment.failed',livemode:true}}}));
 await assert.rejects(()=>handleWebhook({method:'POST',body:live,headers:{'paymongo-signature':header(live)}},{},env,''));
 await assert.rejects(()=>handleWebhook({method:'POST',body:{data:{}},headers:{}},{},env,''));
});
