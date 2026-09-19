import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { contacts,password,startDate,cents,imageData } from '../src/validation.js';
import { handle } from '../src/api.js';
import { flushEmails } from '../src/notifications.js';
import { validateExport } from '../scripts/validate-d1-export.js';

test('required contacts and Philippine mobile normalization',()=>{
  const valid={name:'Test Member',email:'member@example.test',phone:'+63 917 123 4567'};
  assert.equal(contacts(valid).phone,'09171234567');
  for(const field of ['name','email','phone'])assert.throws(()=>contacts({...valid,[field]:''}));
  for(const phone of ['12345','+14155555555','099999999999','0917123456'])assert.throws(()=>contacts({...valid,phone}));
  for(const email of ['x','x@x','a b@x.test','<a>@x.test'])assert.throws(()=>contacts({...valid,email}));
});
test('password and exact calendar dates',()=>{
  assert.equal(password('StrongPassword2026!'),'StrongPassword2026!');
  for(const value of ['short','abcdefghijkl','123456789012',null])assert.throws(()=>password(value));
  assert.equal(startDate('2026-09-18','2026-09-18'),'2026-09-18');
  for(const value of ['',undefined,'2026-02-30','2026-09-17','2027-09-19'])assert.throws(()=>startDate(value,'2026-09-18'));
});
test('money is converted through decimal digits to integer centavos',()=>{
  assert.equal(cents('0.29'),29);assert.equal(cents('899.01'),89901);assert.equal(cents(1499),149900);
  for(const value of ['1e3','1.001',-1,0,NaN,Infinity,'100000.01',0.1+0.2])assert.throws(()=>cents(value));
});
test('image validation rejects mismatched types and oversized uploads',()=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  assert.equal(imageData(png).contentType,'image/png');
  assert.throws(()=>imageData(png.replace('image/png','image/jpeg')));
  assert.throws(()=>imageData('data:image/svg+xml;base64,PHN2Zz4='));
  assert.throws(()=>imageData('data:image/png;base64,'+'A'.repeat(900001)));
});
test('notification queue fails closed for demo and missing Gmail configuration',async()=>{
  assert.deepEqual(await flushEmails({APP_WORKSPACE:'demo'}),{status:'suppressed',count:0});
  assert.deepEqual(await flushEmails({APP_WORKSPACE:'production'}),{status:'unconfigured',count:0});
});
test('D1 transfer validation reconciles centavos and rejects discarded relationships or hashes',()=>{
 const empty={members:[],invoices:[],payments:[],submissions:[],checkins:[],settings:[],outbox:[]};
 assert.equal(validateExport(empty).paidCents,0);
 const fixture={...empty,members:[{id:'M1'}],invoices:[{id:'I1',member_id:'M1',amount:89900,paid:40000}],payments:[{id:'P1',member_id:'M1',invoice_id:'I1',amount:40000,reference_key:'TEST:1'}]};
 assert.equal(validateExport(fixture).paidCents,40000);
 assert.throws(()=>validateExport({...fixture,accounts:[{password_hash:'never-transfer'}]}));
 assert.throws(()=>validateExport({...fixture,payments:[]}));
 assert.throws(()=>validateExport({...fixture,members:[]}));
 assert.throws(()=>validateExport({...fixture,payments:[...fixture.payments,{...fixture.payments[0],id:'P2'}]}));
});
test('API rejects missing configuration, wrong origins and malformed bodies without contacting Supabase',async()=>{
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:'http://localhost:4173'};
  const server=http.createServer((req,res)=>handle(req,res,req.url==='/api/unconfigured'?{}:env));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(origin+'/api/unconfigured')).status,503);
    assert.equal((await fetch(origin+'/api/payments',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(origin+'/api/payments',{method:'POST',headers:{origin:env.APP_ORIGIN,'content-type':'application/json'},body:'{'})).status,400);
    assert.equal((await fetch(origin+'/api/payments',{method:'POST',headers:{origin:env.APP_ORIGIN,'content-type':'application/json'},body:'[]'})).status,400);
    assert.equal((await fetch(origin+'/api/payments',{method:'DELETE'})).status,405);
  }finally{server.close();}
});

test('notification sender records acceptance, rejects duplicate claims and preserves uncertain delivery',async()=>{
  const rows=[
    {id:'accepted',recipient:'accepted@example.invalid'},
    {id:'failed',recipient:'failed@example.invalid'},
    {id:'uncertain',recipient:'uncertain@example.invalid'},
    {id:'claimed-elsewhere',recipient:'duplicate@example.invalid'}
  ].map(r=>({...r,status:'queued',subject:'Test only',body:'No live transport is used.'}));
  const patches=[],sent=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify(rows));return;}
    const patch=JSON.parse(raw);patches.push(patch);
    const id=url.searchParams.get('id')?.slice(3);
    if(patch.status==='sending'){res.end(JSON.stringify(id==='claimed-elsewhere'?[]:[{id}]));return;}
    const row=rows.find(r=>r.id===id);if(row)Object.assign(row,patch);
    res.end('[]');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const transport={sendMail:async message=>{sent.push(message.to);if(message.to.startsWith('failed'))throw Object.assign(Error('test'),{code:'EAUTH'});if(message.to.startsWith('uncertain'))throw Object.assign(Error('test'),{code:'ETIMEDOUT'});return {accepted:[message.to]};},close(){}};
    await flushEmails({APP_WORKSPACE:'production',SUPABASE_URL:`http://127.0.0.1:${server.address().port}`,SUPABASE_SECRET_KEY:'test-key',GMAIL_ADDRESS:'sender@example.invalid',GMAIL_APP_PASSWORD:'test-placeholder'},transport);
    assert.equal(rows[0].status,'sent');assert.equal(rows[1].status,'failed');assert.equal(rows[2].status,'needs_review');
    assert.equal(sent.length,3);assert(!sent.includes('duplicate@example.invalid'));
    assert.equal(patches[0].status,'needs_review');
  }finally{server.close();}
});

// Email links are opened by top-level browser navigation, so failures must render a page.
test('email confirmation callback rejects malformed links with an HTML page, never JSON',async()=>{
  let origin='';
  const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const query of ['','?type=signup','?token_hash=abc','?token_hash=abc&type=bogus','?token_hash=abc&type=email_change']){
      const response=await fetch(origin+'/api/auth/callback'+query,{redirect:'manual'});
      assert.equal(response.status,400,query);
      assert.match(response.headers.get('content-type'),/text\/html/,query);
      const body=await response.text();
      assert.match(body,/<!doctype html>/i,query);
      assert.doesNotMatch(body,/^\s*\{/,query);
      assert.doesNotMatch(body,/abc/,'the token must never be echoed into the page');
    }
  }finally{server.close();}
});

test('email confirmation callback verifies token_hash without PKCE and routes by type',async()=>{
  const requests=[];
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const userId='11111111-2222-3333-4444-555555555555';
  const expires=Math.floor(Date.now()/1000)+3600;
  const accessToken=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'66666666-7777-8888-9999-000000000000'})}.test-signature`;
  const supabase=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({url:req.url,body:raw?JSON.parse(raw):null});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({access_token:accessToken,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh-token',
      user:{id:userId,aud:'authenticated',role:'authenticated',email:'confirm@example.invalid',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}}));
  });
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const [type,destination] of [['signup','/'],['email','/'],['recovery','/#/set-password'],['invite','/#/set-password']]){
      const response=await fetch(`${origin}/api/auth/callback?token_hash=hash-${type}&type=${type}`,{redirect:'manual'});
      assert.equal(response.status,303,type);
      assert.equal(response.headers.get('location'),origin+destination,type);
      assert(response.headers.getSetCookie().some(cookie=>/HttpOnly/i.test(cookie)),`${type} must set an HttpOnly session cookie`);
      const sent=requests.at(-1);
      assert.match(sent.url,/\/auth\/v1\/verify/,type);
      assert.equal(sent.body.token_hash,`hash-${type}`,type);
      assert.equal(sent.body.type,type);
      assert.equal(sent.body.code_verifier,undefined,'token_hash verification must not depend on a PKCE verifier');
    }
  }finally{server.close();supabase.close();}
});
