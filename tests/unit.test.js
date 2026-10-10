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

test('a mismatched origin is still refused with 403 and told which address to open',async()=>{
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:'http://localhost:4173'};
  const server=http.createServer((req,res)=>handle(req,res,env));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const recover=(origin,email)=>fetch(base+'/api/recovery',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email})});
  try{
    // 127.0.0.1 vs localhost, another port, and another Vercel alias are all different origins.
    for(const origin of ['http://127.0.0.1:4173','http://localhost:4174','https://repready-abc123.vercel.app']){
      const response=await recover(origin,'member@example.test');
      assert.equal(response.status,403,origin);
      assert.equal((await response.json()).error,'This page was opened from a different address than the app expects. Open http://localhost:4173 and try again.');
    }
    // The exact origin passes the check and reaches the route's own validation (no Supabase call).
    const matching=await recover(env.APP_ORIGIN,'not-an-email');
    assert.equal(matching.status,400);
    assert.equal((await matching.json()).error,'Enter a valid email address.');
  }finally{server.close();}
});

test('on Vercel without APP_ORIGIN, the VERCEL_URL fallback is logged once',async()=>{
  const {configuration}=await import('../src/supabase.js');
  const warnings=[],original=console.warn;console.warn=message=>warnings.push(String(message));
  try{
    const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable',VERCEL:'1',VERCEL_URL:'repready-abc123.vercel.app'};
    assert.equal(configuration(env).origin,'https://repready-abc123.vercel.app');
    configuration(env);
    assert.equal(warnings.length,1,'warn once, not on every request');
    assert.match(warnings[0],/APP_ORIGIN is not set/);assert.match(warnings[0],/https:\/\/repready-abc123\.vercel\.app/);
    configuration({...env,APP_ORIGIN:'https://repready-gym.vercel.app'});
    assert.equal(warnings.length,1,'no warning when APP_ORIGIN is set');
  }finally{console.warn=original;}
});

test('the local dev server sends pages opened on another host to APP_ORIGIN, but never API calls',async()=>{
  const dev=await import('../src/dev.js');
  assert.equal(typeof dev.createDevServer,'function','src/dev.js must export createDevServer');
  const server=dev.createDevServer({APP_ORIGIN:'http://localhost:4173'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  // fetch cannot set Host, so use node:http to send exactly what a browser on another host would.
  const get=(path,host)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,headers:{host}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location}));});
    req.on('error',reject);req.end();
  });
  try{
    const page=await get('/?checkout=abc','127.0.0.1:4173');
    assert.equal(page.status,302);assert.equal(page.location,'http://localhost:4173/?checkout=abc');
    assert.equal((await get('/app.js','localhost:4174')).status,302,'another port is another origin');
    assert.equal((await get('/app.js','localhost:4173')).status,200,'the configured host is served normally');
    assert.equal((await get('/api/session','127.0.0.1:4173')).status,503,'API calls reach the handler unredirected');
  }finally{server.close();}
  assert.deepEqual(dev.startupMessages({APP_ORIGIN:'http://localhost:4173'},4173),['Open http://localhost:4173']);
  const mismatch=dev.startupMessages({APP_ORIGIN:'http://localhost:4173'},4174);
  assert.equal(mismatch[0],'Open http://localhost:4173');assert.match(mismatch[1],/port 4174.*port 4173/);
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

test('a ?code= reset link opened in the requesting browser signs in through the PKCE exchange',async()=>{
  const {createHash}=await import('node:crypto');
  const state={requests:[],challenge:null,method:null,redirectTo:null};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const userId='22222222-3333-4444-5555-666666666666',expires=Math.floor(Date.now()/1000)+3600;
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'77777777-8888-9999-0000-111111111111'})}.test-signature`,
    token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh-token',
    user:{id:userId,aud:'authenticated',role:'authenticated',email:'reset@example.invalid',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
  // A fake GoTrue that only accepts the exchange when the verifier matches the challenge sent with /recover.
  const supabase=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:url.pathname,grant:url.searchParams.get('grant_type'),body});
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/auth/v1/recover'){state.challenge=body.code_challenge;state.method=body.code_challenge_method;state.redirectTo=url.searchParams.get('redirect_to');return res.end('{}');}
    if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='pkce'){
      const derived=state.method==='plain'?body.code_verifier:createHash('sha256').update(body.code_verifier||'').digest('base64url');
      if(body.auth_code==='good-code'&&derived===state.challenge)return res.end(JSON.stringify(session));
      res.statusCode=404;return res.end(JSON.stringify({code:404,error_code:'flow_state_not_found',msg:'invalid flow state, no valid flow state found'}));
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  try{
    // Requesting the email from this browser stores the PKCE verifier as an HttpOnly cookie.
    const requested=await fetch(origin+'/api/recovery',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'reset@example.invalid'})});
    assert.equal(requested.status,200);
    const cookie=requested.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert.match(cookie,/code-verifier=/,'the verifier is stored in the requesting browser');
    assert.equal(state.redirectTo,origin+'/api/auth/callback','the link returns to the callback without extra parameters');
    // Supabase's default template sends the browser back with ?code= instead of token_hash.
    const opened=await fetch(`${origin}/api/auth/callback?code=good-code`,{redirect:'manual',headers:{cookie}});
    assert.equal(opened.status,303);
    assert.equal(opened.headers.get('location'),origin+'/#/set-password');
    assert(opened.headers.getSetCookie().some(value=>/-auth-token(\.\d+)?=/.test(value.split(';')[0])&&/HttpOnly/i.test(value)),'an HttpOnly session cookie is set');
    assert.equal(state.requests.find(r=>r.grant==='pkce').body.auth_code,'good-code');
    // A code the provider rejects shows the HTML page, never JSON.
    const rejected=await fetch(`${origin}/api/auth/callback?code=stale-code`,{redirect:'manual',headers:{cookie}});
    assert.equal(rejected.status,400);
    assert.match(await rejected.text(),/expired or was already used/);
  }finally{server.close();supabase.close();}
});

test('a ?code= link opened without the requesting browser\'s verifier fails with the expired page and a device hint',async()=>{
  let origin='';
  const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const query of ['?code=secret-code-1','?sb_flow_id=0123456789abcdef0123456789abcdef&code=secret-code-2']){
      const response=await fetch(origin+'/api/auth/callback'+query,{redirect:'manual'});
      assert.equal(response.status,400,query);
      assert.match(response.headers.get('content-type'),/text\/html/,query);
      const body=await response.text();
      assert.match(body,/expired or was already used/,query);
      assert.match(body,/If you opened this on a different device, open it on the device where you requested it, or request a new link\./,query);
      assert.doesNotMatch(body,/secret-code/,'the code must never be echoed into the page');
    }
  }finally{server.close();}
});

test('role capabilities are explicit and default-deny',async()=>{
  const {capabilitiesFor,userView}=await import('../src/state.js');
  const admin=capabilitiesFor('admin'),staff=capabilitiesFor('staff'),member=capabilitiesFor('member');
  for(const grant of ['roster','addMember','renew','recordCashPayment','initiateOnlinePayment','scan'])assert.equal(staff[grant],true,'staff should have '+grant);
  for(const deny of ['recordOnlinePayment','reviewPayment','manageMember','plans','paymentSettings','systemSettings'])assert.notEqual(staff[deny],true,'staff must not have '+deny);
  for(const grant of ['reviewPayment','plans','paymentSettings','systemSettings','manageMember','recordOnlinePayment'])assert.equal(admin[grant],true,'admin should have '+grant);
  assert.equal(admin.initiateOnlinePayment,true);
  assert.deepEqual(member,{initiateOnlinePayment:true},'a member can start an owned checkout, with no console capabilities');
  assert.deepEqual(capabilitiesFor('unknown-role'),{},'an unknown role is denied everything');
  assert.equal(staff.somethingNeverDefined,undefined,'an undeclared capability is never truthy');
  assert.deepEqual(userView({id:'x',role:'staff',name:'S',email:'s@example.invalid',workspace:'production'}).can,staff);
});

// A fake GoTrue/PostgREST pair so the real handler runs its authorization gate offline.
function fakeSupabase(state){
  return http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost');
    state.requests.push({method:req.method,path:url.pathname,body:raw?JSON.parse(raw):null});
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/auth/v1/verify')return res.end(JSON.stringify(state.session));
    if(url.pathname==='/auth/v1/user')return res.end(JSON.stringify(state.session.user));
    if(url.pathname==='/rest/v1/ff_profiles')return res.end(JSON.stringify([state.profile]));
    if(url.pathname==='/rest/v1/ff_plans')return res.end(JSON.stringify([{id:'basic',name:'Essential',days:30,features:['All strength equipment']}]));
    if(url.pathname==='/auth/v1/invite')return res.end(JSON.stringify({action_link:'https://example.invalid/link',email_otp:'',hashed_token:'fake-hash',redirect_to:'',verification_type:'invite',id:'99999999-0000-0000-0000-000000000000',email:'new-member@example.invalid',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}));
    if(url.pathname==='/rest/v1/rpc/ff_registration')return res.end(JSON.stringify({id:'99999999-0000-0000-0000-000000000001',status:'awaiting_payment',...JSON.parse(raw).body}));
    if(url.pathname==='/rest/v1/rpc/ff_command')return res.end(JSON.stringify({ok:true}));
    res.statusCode=404;return res.end('{}');
  });
}
async function consoleSession(role){
  const userId=`11111111-2222-3333-4444-55555555550${role==='admin'?1:role==='staff'?2:3}`;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires=Math.floor(Date.now()/1000)+3600;
  const accessToken=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'66666666-7777-8888-9999-000000000000'})}.signature`;
  const user={id:userId,aud:'authenticated',role:'authenticated',email:`${role}@example.invalid`,app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
  const state={requests:[],session:{access_token:accessToken,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh',user},
    profile:{id:userId,workspace:'production',role,name:`Test ${role}`,email:user.email,phone:'09170000001',enabled:true,goal:'',photo:'',created_at:new Date().toISOString()}};
  const supabase=fakeSupabase(state);
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable',SUPABASE_SECRET_KEY:'secret',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${api.address().port}`;
  const landing=await fetch(`${origin}/api/auth/callback?token_hash=seed&type=signup`,{redirect:'manual'});
  const cookie=landing.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return {origin,state,
    post:(path,body)=>fetch(origin+'/api'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body||{})}),
    close(){api.close();supabase.close();}};
}

test('API authorization gate matches the staff permission matrix',async()=>{
  const staff=await consoleSession('staff');
  try{
    for(const path of ['/plans','/review-payment','/settings/payments','/settings/email','/manage-member','/email-retry']){
      const response=await staff.post(path,{});
      assert.equal(response.status,403,`staff must be refused ${path}`);
      assert.match((await response.json()).error,/Administrator access is required/,path);
    }
    for(const path of ['/scan','/check-in','/payments','/renew'])
      assert.notEqual((await staff.post(path,{})).status,403,`staff must pass the gate for ${path}`);
  }finally{staff.close();}
});

test('members and administrators keep their existing access',async()=>{
  const member=await consoleSession('member');
  try{
    for(const path of ['/scan','/check-in','/payments','/members']){
      const response=await member.post(path,{});
      assert.equal(response.status,403,`a member must be refused ${path}`);
      assert.match((await response.json()).error,/Gym staff access is required/,path);
    }
    for(const path of ['/plans','/review-payment','/manage-member']){
      const response=await member.post(path,{});
      assert.equal(response.status,403,path);
      assert.match((await response.json()).error,/Administrator access is required/,path);
    }
  }finally{member.close();}
  const admin=await consoleSession('admin');
  try{
    for(const path of ['/plans','/review-payment','/settings/payments','/manage-member','/email-retry','/scan','/check-in','/payments','/members'])
      assert.notEqual((await admin.post(path,{})).status,403,`an administrator must keep ${path}`);
  }finally{admin.close();}
});

test('staff registration saves pending details without an Auth account or email',async()=>{
 const staff=await consoleSession('staff');
 try{
  const start=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const base={name:'New Member',email:'new-member@example.invalid',phone:'09170000009',plan:'basic',start,goal:'Improve fitness',requestId:'99999999-0000-0000-0000-000000000009'};
  const response=await staff.post('/members',base);assert.equal(response.status,201);const value=await response.json();assert.equal(value.accountReady,false);assert.equal(value.invitationSent,false);assert.equal(value.registration.status,'awaiting_payment');
  const call=staff.state.requests.find(entry=>entry.path==='/rest/v1/rpc/ff_registration');assert.equal(call.body.action,'create');
  assert.equal(staff.state.requests.some(entry=>entry.path==='/auth/v1/invite'||entry.path==='/auth/v1/admin/users'),false);
  for(const escalation of [{role:'admin'},{ff_role:'staff'},{workspace:'demo'},{app_metadata:{ff_role:'admin'}}])assert.equal((await staff.post('/members',{...base,...escalation})).status,400);
  assert.equal((await staff.post('/signup',base)).status,403);
 }finally{staff.close();}
});

test('the staff shell relabels the admin console without changing its markup',async()=>{
  const {readFile}=await import('node:fs/promises');
  const app=await readFile('public/app.js','utf8'),connected=await readFile('public/connected.js','utf8');
  // The override is a monkey patch over app.js output, so it breaks silently if app.js is reworded.
  for(const source of ["'Gym Admin'","'Gym administrator'","'Admin workspace'",'>Admin view</button>'])
    assert(app.includes(source),`app.js must still emit ${source}, or the staff label override is stale`);
  const block=connected.slice(connected.indexOf("if(currentUser?.role==='staff')"));
  const pairs=[...block.slice(0,block.indexOf(';')).matchAll(/\.replace\('([^']*)','([^']*)'\)/g)].map(m=>[m[1],m[2]]);
  assert.equal(pairs.length,4,'expected exactly four label replacements');
  const admin='<span class="avatar ">GA</span><div><strong>Gym administrator</strong><small>Admin workspace</small></div>'+
    '<div class="mode-switch"><button data-action="mode" data-mode="admin" class="active" aria-pressed="true">Admin view</button>'+
    '<button data-action="mode" data-mode="member" class="" aria-pressed="false">Member view</button></div>';
  let staff=admin;
  for(const [from,to] of pairs){assert(staff.includes(from),`the admin shell must contain ${from}`);staff=staff.replace(from,to);}
  for(const label of ['>GS</span>','<strong>Gym staff</strong>','<small>Staff workspace</small>','>Staff view</button>'])
    assert(staff.includes(label),`the staff shell must contain ${label}`);
  for(const label of ['Gym administrator','Admin workspace','>Admin view<','>GA</span>'])
    assert(!staff.includes(label),`the staff shell must not contain ${label}`);
  assert.equal((staff.match(/</g)||[]).length,(admin.match(/</g)||[]).length,'tag count must be identical');
  assert.equal((staff.match(/class="[^"]*"/g)||[]).join('|'),(admin.match(/class="[^"]*"/g)||[]).join('|'),'class attributes must be identical');
  assert.equal(staff.length,admin.length-8,'only label text changed (Gym administrator -> Gym staff)');
});

test('payment email distinguishes partial balances from pass eligibility',async()=>{
 const {paymentEmail}=await import('../src/notifications.js');
 const cycle={start_date:'2026-10-02',end_date:'2026-10-31'},plan={name:'Essential',features:['All strength equipment','Locker room access']};
 const partial=paymentEmail('Payment confirmed',{amount_cents:89900,paid_cents:10000},cycle,plan,'http://localhost:4173');
 assert.match(partial,/Remaining balance: PHP 799.00/);assert.match(partial,/Full payment is required/);assert.match(partial,/All strength equipment/);
 const full=paymentEmail('Payment confirmed',{amount_cents:89900,paid_cents:89900},cycle,plan,'http://localhost:4173');
 assert.match(full,/fully paid/);assert.match(full,/during the membership dates/);assert.match(full,/http:\/\/localhost:4173\/#\/member\/overview/);assert.doesNotMatch(full,/Remaining balance/);
});

test('a repeat same-day check-in maps to 409 like the other already-recorded conflicts',async()=>{
 const {result}=await import('../src/supabase.js');
 const status=message=>{try{result({data:null,error:{code:'P0001',message}});}catch(error){return error.status;}};
 assert.equal(status('Already checked in today.'),409);
 assert.equal(status('This pass was already used.'),409);
 assert.equal(status('Invalid member pass.'),400);
});

test('scanning a member already checked in today shows the recorded visit and blocks confirmation',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=(await readFile('public/connected.js','utf8')).match(/^async function verifyScanned\(token\)\{.*$/m)?.[0];
 assert(source,'verifyScanned must stay a single top-level function in connected.js');
 const render=async alreadyCheckedInAt=>{
  let modal;const member={id:'M-1',name:'Test Member',phone:'09170000004',plan:'basic',end:'2026-10-31',photo:''};
  const sandbox={api:async()=>({member,expires:0,alreadyCheckedInAt}),closeModal(){},openModal:(title,subtitle,body,foot)=>{modal={body,foot};},
   avatar:()=>'',esc:s=>String(s),badge:s=>`<span class="badge">${s}</span>`,planOf:()=>({name:'Basic'}),date:d=>d,btn:label=>`<button>${label}</button>`};
  vm.runInNewContext(source,sandbox);await sandbox.verifyScanned('FORM2.token');return modal;
 };
 const fresh=await render(null);
 assert.doesNotMatch(fresh.body,/Already recorded/);assert.doesNotMatch(fresh.foot,/disabled/);
 // The database returns microsecond timestamptz JSON; 06:05 UTC is 14:05 in Manila.
 const repeat=await render('2026-10-09T06:05:00.123456+00:00');
 assert.match(repeat.body,/<span class="badge">Already recorded<\/span>/);
 assert.match(repeat.body,/Checked in today at 14:05 \(Manila time\)\. Another scan will not add a visit\./);
 assert.match(repeat.foot,/<button class="button primary" type="submit" form="checkin-form" disabled>Confirm check-in<\/button>/);
});

test('owner login is gone from the session API and the connected UI',async()=>{
 const {readFile}=await import('node:fs/promises');
 const session=await consoleSession('member');
 try{assert.equal('canOwnerLogin' in await (await fetch(session.origin+'/api/session')).json(),false,'nothing reads canOwnerLogin');}
 finally{session.close();}
 const connected=await readFile('public/connected.js','utf8'),css=await readFile('public/connected.css','utf8');
 for(const leftover of ['owner-login','ownerLoginAllowed','canOwnerLogin'])assert(!connected.includes(leftover),`connected.js still contains ${leftover}`);
 assert(!css.includes('.owner-login'),'connected.css still styles the removed owner-login card');
});

test('connected.js text patches still match app.js in the order they run',async()=>{
 const {readFile}=await import('node:fs/promises');
 const app=await readFile('public/app.js','utf8'),connected=await readFile('public/connected.js','utf8');
 // A reworded app.js string, or an earlier patch consuming a later target, would otherwise fail silently.
 const chains=[...connected.matchAll(/base[A-Z]\w*\(\)((?:\.replace(?:All)?\('[^']*','[^']*'\))+)/g)].map(m=>m[1]);
 assert(chains.length>=4,'expected the header, payments, overview and membership patch chains');
 for(const chain of chains){
  let text=app;
  for(const [,all,from,to] of chain.matchAll(/\.replace(All)?\('([^']*)','([^']*)'\)/g)){
   assert(text.includes(from),`connected.js patch '${from}' no longer matches app.js at its turn`);
   text=all?text.replaceAll(from,to):text.replace(from,to);
  }
 }
});

test('app.js no longer carries the classroom wording the connected app can still show',async()=>{
 const {readFile}=await import('node:fs/promises');
 const app=await readFile('public/app.js','utf8');
 assert.doesNotMatch(app,/classroom/i);
 for(const phrase of ['Class demo guide','DEMO PAYMENT RECEIPT','Confirm demo payment','aria-label="Demo view"',"'Demo payment','pay'"])
  assert(!app.includes(phrase),`app.js still contains ${phrase}`);
});

// Loads public/paymongo.js into a sandbox whose provider call always returns a redirectable checkout.
async function paymongoSandbox(forms){
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const button={disabled:true},firstModalForm={id:'recover-checkout-form',dataset:{},querySelector:()=>null},listeners={},timers=[],assigned=[];let apiCalls=0;
 const sandbox={URL,state:{invoices:[{id:'inv-1'}]},paymentIntent:'intent-1',can:()=>true,currentUser:{role:'staff'},refreshData:async()=>{},
  api:async()=>{apiCalls++;return {checkout:{id:'chk-1',status:'pending',reviewReason:'',url:'https://checkout.paymongo.com/cs_test'}};},
  window:{addEventListener:(type,fn)=>{listeners[type]=fn;},location:{assign:url=>assigned.push(url)}},
  document:{visibilityState:'visible',querySelector:selector=>selector==='.modal form'?firstModalForm:selector.startsWith('button[form=')?button:null,
   querySelectorAll:()=>forms.filter(form=>form.dataset.redirecting||form.dataset.submitting)},
  setTimeout:(fn,ms)=>timers.push({fn,ms,cleared:false}),clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;}};
 vm.runInNewContext(await readFile('public/paymongo.js','utf8'),sandbox);
 const start=form=>sandbox.startPaymongo({kind:'invoice',invoiceId:'inv-1',method:'gcash'},form);
 return {sandbox,button,firstModalForm,listeners,timers,assigned,start,apiCalls:()=>apiCalls};
}

test('a cancelled checkout navigation or a Back/bfcache return re-arms online payment',async()=>{
 const form={id:'payment-form',dataset:{},querySelector:()=>null},p=await paymongoSandbox([form]);
 await p.start(form);
 assert.equal(p.assigned.length,1);assert.equal(form.dataset.redirecting,'true');
 await p.start(form);
 assert.equal(p.apiCalls(),1,'a second start while redirecting sends nothing');
 form.dataset.submitting='true';
 assert.equal(typeof p.listeners.pageshow,'function','paymongo.js must listen for pageshow');
 p.listeners.pageshow({persisted:true});
 assert.equal(form.dataset.redirecting,undefined);assert.equal(form.dataset.submitting,undefined);assert.equal(p.button.disabled,false);
 await p.start(form);
 assert.equal(p.apiCalls(),2,'payment works again after returning');
});

test('the in-flight safety reset fires after about 10 s and only while the page is still visible',async()=>{
 const form={id:'payment-form',dataset:{},querySelector:()=>null},p=await paymongoSandbox([form]);
 await p.start(form);
 const timer=p.timers.find(t=>t.ms>=9000&&t.ms<=11000);
 assert(timer,'startPaymongo must schedule a ~10 s safety reset');
 p.sandbox.document.visibilityState='hidden';timer.fn();await p.start(form);
 assert.equal(p.apiCalls(),1,'a hidden page (navigation committed) stays locked');
 p.sandbox.document.visibilityState='visible';timer.fn();await p.start(form);
 assert.equal(p.apiCalls(),2,'a page still visible after ~10 s is re-armed');
});

test('a stale safety timer is cleared, so it cannot re-arm a newer checkout attempt',async()=>{
 const form={id:'payment-form',dataset:{},querySelector:()=>null},p=await paymongoSandbox([form]);
 await p.start(form);
 const stale=p.timers.at(-1);
 // The page is frozen in the back/forward cache with this timer pending, then restored.
 p.listeners.pageshow({persisted:true});
 assert.equal(stale.cleared,true,'returning to the page clears the pending safety timer');
 await p.start(form);
 assert.equal(p.apiCalls(),2);
 // A browser never runs a cleared timer; an uncleared one would fire now and unlock attempt 2 early.
 if(!stale.cleared)stale.fn();
 await p.start(form);
 assert.equal(p.apiCalls(),2,'the second attempt stays locked');
});

test('starting a new checkout attempt clears any safety timer still pending',async()=>{
 const vm=await import('node:vm');
 const form={id:'payment-form',dataset:{},querySelector:()=>null},p=await paymongoSandbox([form]);
 await p.start(form);
 const pending=p.timers.at(-1);
 // Simulates any path that re-arms checkout without resetPaymongoStart().
 vm.runInContext('paymongoStarting=false',p.sandbox);
 await p.start(form);
 assert.equal(pending.cleared,true,'a new attempt clears the previous attempt\'s timer');
});

test('checkout marks the form that was submitted, not the first form in the modal',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const submitted={id:'payment-form',dataset:{},querySelector:()=>null},p=await paymongoSandbox([submitted]);
 await p.start(submitted);
 assert.equal(submitted.dataset.redirecting,'true');assert.equal(p.firstModalForm.dataset.redirecting,undefined);
 const connected=await readFile('public/connected.js','utf8'),paymongo=await readFile('public/paymongo.js','utf8');
 const ctx={document:{querySelector:()=>null},toast(){}};
 vm.runInNewContext(connected.match(/^async function runForm\(form,operation\)\{.*$/m)[0],ctx);
 let received;const form={id:'x',dataset:{},querySelector:()=>null};await ctx.runForm(form,f=>{received=f;});
 assert.equal(received,form,'runForm hands the submitting form to its operation');
 const calls=[...(connected+paymongo).matchAll(/startPaymongo\((\{[^{}]*\})(,form)?\)/g)];
 assert.equal(calls.length,4,'expected the registration, walk-in, record-payment and member checkout entry points');
 for(const call of calls)assert(call[2],`a checkout entry point does not pass the submitting form: ${call[1].slice(0,50)}`);
});

test('"Already recorded" uses the existing amber badge colours, not the Active green',async()=>{
 const {readFile}=await import('node:fs/promises');
 const amber=(await readFile('public/styles.css','utf8')).match(/\.badge\.pending,\.badge\.partial,\.badge\.unpaid\{([^}]*)\}/)[1];
 const rule=(await readFile('public/connected.css','utf8')).match(/\.badge\.already\{([^}]*)\}/)?.[1];
 assert(rule,'connected.css must style .badge.already');
 const declarations=css=>Object.fromEntries(css.split(';').filter(Boolean).map(d=>d.split(':')));
 assert.deepEqual(declarations(rule),declarations(amber));
});

test('the hosted pre-flight script is one read-only transaction of SELECT statements',async()=>{
 const {readFile}=await import('node:fs/promises');
 const sql=await readFile('scripts/hosted-preflight.sql','utf8');
 assert.match(sql,/do not run against production without the owner/i);
 const statements=sql.replace(/--.*$/gm,'').split(';').map(s=>s.trim().replace(/\s+/g,' ').toLowerCase()).filter(Boolean);
 assert.deepEqual(statements.slice(0,2),['begin','set transaction read only']);
 assert.equal(statements.at(-1),'rollback');
 const body=statements.slice(2,-1);
 assert(body.length>=6,'expected a SELECT for each report section');
 for(const statement of body)assert.match(statement,/^select\b/,`not a SELECT: ${statement.slice(0,60)}`);
});

// Staff management (Task 08).
test('only administrators get the manageStaff capability',async()=>{
 const {capabilitiesFor}=await import('../src/state.js');
 assert.equal(capabilitiesFor('admin').manageStaff,true);
 for(const role of ['staff','member','unknown',undefined])assert.equal(capabilitiesFor(role).manageStaff,undefined);
});
test('the staff list goes to administrators only, with admin and staff profiles and no other fields',async()=>{
 const {staffFor}=await import('../src/state.js');
 const row=(id,role,enabled=true)=>({id,role,enabled,name:'Test '+role,email:id+'@example.test',phone:'09170000001',created_at:'2026-10-01T20:00:00Z',photo:'demo/x/photo/p.png',goal:'Goal',workspace:'production'});
 const profiles=[row('a','admin'),row('s','staff',false),row('m','member')];
 assert.equal(staffFor({role:'staff'},profiles),undefined);
 assert.equal(staffFor({role:'member'},profiles),undefined);
 const list=staffFor({role:'admin'},profiles);
 assert.deepEqual(list.map(s=>s.id),['a','s']);
 assert.deepEqual(Object.keys(list[0]).sort(),['added','email','enabled','id','name','phone','role']);
 assert.equal(list[0].added,'2026-10-02','Added date is the Manila calendar day');
 assert.equal(list[1].enabled,false);
});
test('a staff setup link can be resent once per minute',async()=>{
 const {resendRetryAfter}=await import('../src/staff.js');
 const now=Date.parse('2026-10-10T08:00:00Z'),ago=ms=>new Date(now-ms).toISOString();
 assert.equal(resendRetryAfter(null,now),0,'never sent');
 assert.equal(resendRetryAfter('not a date',now),0);
 assert.equal(resendRetryAfter(ago(10000),now),50);
 assert.equal(resendRetryAfter(ago(59500),now),1,'partial seconds round up');
 assert.equal(resendRetryAfter(ago(60000),now),0);
 assert.equal(resendRetryAfter(ago(3600000),now),0);
});

async function staffSandbox({role='admin',tab='roster',staff}={}){
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const listeners={},modals=[],toasts=[],calls=[];
 const caps={admin:{manageStaff:true,roster:true},staff:{roster:true},member:{}}[role];
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const sandbox={
  memberTab:tab,currentUser:{role},can:name=>caps[name]===true,
  state:{staff:staff||[
   {id:'a1',name:'Ana Admin',email:'ana@example.test',phone:'09170000001',role:'admin',enabled:true,added:'2026-09-19'},
   {id:'s1',name:'Sam Staff',email:'sam@example.test',phone:'09170000002',role:'staff',enabled:true,added:'2026-10-10'},
   {id:'s2',name:'Dee Disabled',email:'dee@example.test',phone:'09170000003',role:'staff',enabled:false,added:'2026-10-09'}]},
  members:()=>'<div class="page-heading">HEAD</div><div class="tabs" role="tablist" aria-label="Membership sections"><button class="tab active" data-action="member-tab" data-tab="roster">Member directory<span>2</span></button><button class="tab" data-action="member-tab" data-tab="plans">Membership plans</button></div><section class="panel">ROSTER</section>',
  esc,icon:name=>`<svg data-icon="${name}"></svg>`,badge:status=>`<span class="badge ${status.toLowerCase()}">${esc(status)}</span>`,
  avatar:m=>`<span class="avatar">${esc(m.name.slice(0,2))}</span>`,date:d=>'D:'+d,
  btn:(label,action,cls='',extra='',ico='')=>`<button class="button ${cls}" data-action="${action}" ${extra}>${label}</button>`,
  field:(label,name,value='',type='text',extra='',hint='')=>`<label for="${name}">${label}</label><input id="${name}" type="${type}" value="${esc(value)}" ${extra}>${hint}`,
  openModal:(title,subtitle,body,foot='')=>modals.push({title,subtitle,body,foot}),closeModal:()=>{},toast:message=>toasts.push(message),
  validateContactFields:()=>{},refreshData:async()=>{},render:()=>{},
  api:async(path,body)=>{calls.push({path,body});return sandbox.apiReply||{};},
  runForm:async(form,operation)=>operation(form),
  document:{addEventListener:(type,fn)=>{listeners[type]=fn;},getElementById:id=>({value:{'staff-name':'New Person','staff-email':'new@example.test','staff-phone':'09170000004','staff-edit-id':'s1','staff-edit-name':'Sam Renamed','staff-edit-phone':'09170000005'}[id]||''})}
 };
 vm.runInNewContext(await readFile('public/staff.js','utf8'),sandbox);
 const click=(action,id)=>listeners.click({target:{closest:()=>({dataset:{action,id},disabled:false})},preventDefault(){},stopImmediatePropagation(){}});
 const submit=async id=>{const form={id,dataset:{}};await listeners.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});};
 return {sandbox,listeners,modals,toasts,calls,click,submit};
}
test('the Staff tab is shown to administrators only',async()=>{
 const admin=await staffSandbox({role:'admin'});
 const html=admin.sandbox.members();
 assert.match(html,/data-tab="staff"[^>]*>Staff<span>3<\/span>/,'Staff tab with a count badge');
 assert(html.indexOf('data-tab="staff"')>html.indexOf('data-tab="plans"'),'Staff comes after Membership plans');
 for(const role of ['staff','member']){
  const other=await staffSandbox({role,tab:'staff'});
  const page=other.sandbox.members();
  assert.doesNotMatch(page,/data-tab="staff"/,`${role} sees no Staff tab`);
  assert.doesNotMatch(page,/staff-add|Add staff/,`${role} gets no staff controls`);
  assert.equal(other.sandbox.memberTab,'roster','a stale Staff tab falls back to the directory');
 }
});
test('the staff table lists people and keeps administrators read-only',async()=>{
 const {sandbox}=await staffSandbox({tab:'staff'});
 const html=sandbox.members();
 for(const heading of ['Name','Email','Mobile','Role','Status','Added'])assert(html.includes(`<th>${heading}</th>`),heading);
 assert.match(html,/id="staff-search"/);assert.match(html,/data-action="staff-add"/);
 assert.doesNotMatch(html,/ROSTER/,'the member directory is not shown on the Staff tab');
 const rows=Object.fromEntries([...html.matchAll(/<tr data-staff="([^"]+)">(.*?)<\/tr>/g)].map(m=>[m[1],m[2]]));
 assert.match(rows.a1,/Admins can(&#39;|’|')t be changed here/);
 assert.doesNotMatch(rows.a1,/data-action="staff-/,'no actions on an admin row');
 assert.match(rows.a1,/badge admin/);assert.match(rows.s1,/badge staff/);
 for(const action of ['staff-edit','staff-toggle','staff-resend'])assert.match(rows.s1,new RegExp(`data-action="${action}"`));
 assert.match(rows.s1,/badge active/);assert.match(rows.s1,/>Disable</);
 assert.match(rows.s2,/badge disabled/);assert.match(rows.s2,/>Enable</);
});
test('disabling staff asks for confirmation and says they are signed out immediately',async()=>{
 const t=await staffSandbox({tab:'staff'});
 t.click('staff-toggle','s1');
 assert.equal(t.modals.length,1);assert.match(t.modals[0].body+t.modals[0].subtitle,/signed out immediately/);
 assert.equal(t.calls.length,0,'nothing changes before confirming');
 t.click('staff-confirm-toggle','s1');await new Promise(r=>setImmediate(r));
 assert.deepEqual(JSON.parse(JSON.stringify(t.calls[0])),{path:'/staff/enable',body:{id:'s1',enabled:false}});
});
test('adding staff explains their access and reports when the setup email needs a resend',async()=>{
 const t=await staffSandbox({tab:'staff'});
 t.click('staff-add');
 const form=t.modals[0].body;
 assert.match(form,/They(&#39;|’|')ll get an email to set their own password/);
 assert.match(form,/can(&#39;|’|')t change plans, settings or approve transfers/);
 t.sandbox.apiReply={staff:{id:'s3',name:'New Person',email:'new@example.test'},setupEmailSent:false,message:'Account created; setup email needs a resend.'};
 await t.submit('staff-create-form');
 assert.deepEqual(JSON.parse(JSON.stringify(t.calls[0])),{path:'/staff',body:{name:'New Person',email:'new@example.test',phone:'09170000004'}});
 assert.match(t.modals.at(-1).body,/Account created; setup email needs a resend/);
});
test('editing staff never sends an email change',async()=>{
 const t=await staffSandbox({tab:'staff'});
 t.click('staff-edit','s1');
 assert.match(t.modals[0].body,/Email changes require re-creating the account/);
 assert.match(t.modals[0].body,/id="staff-edit-email"[^>]*readonly/);
 await t.submit('staff-edit-form');
 assert.equal(t.calls[0].path,'/staff/update');assert.deepEqual(Object.keys(t.calls[0].body).sort(),['id','name','phone']);
});

// BUG-009: email links that land on the wrong host or path.
test('a token link on any path is forwarded to the callback and kept out of history',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=await readFile('public/auth-link.js','utf8');
 const run=(pathname,search)=>{
  const calls={replace:[],replaceState:[]};
  const ctx={URLSearchParams,location:{pathname,search,hash:'',replace:url=>calls.replace.push(url)},history:{replaceState:(state,title,url)=>calls.replaceState.push(url)}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  return {forwarded:vm.runInContext('authLinkForwarded',ctx),calls};
 };
 for(const [path,type] of [['/','recovery'],['/','invite'],['/members','signup'],['/some/deep/path','email']]){
  const r=run(path,`?token_hash=abc123&type=${type}`);
  assert.equal(r.forwarded,true,`${path} ${type}`);
  assert.deepEqual(r.calls.replace,[`/api/auth/callback?token_hash=abc123&type=${type}`]);
  assert(r.calls.replaceState.length===1&&!r.calls.replaceState[0].includes('abc123'),'the token is stripped from the current history entry');
 }
 for(const [path,search] of [['/',''],['/','?token_hash=abc123'],['/','?token_hash=abc123&type=bogus'],['/','?type=recovery'],['/api/auth/callback','?token_hash=abc123&type=recovery']]){
  const r=run(path,search);
  assert.equal(r.forwarded,false,`${path}${search}`);assert.equal(r.calls.replace.length,0);
 }
});
test('the sign-in page never renders while a token link is being forwarded',async()=>{
 const {readFile}=await import('node:fs/promises');
 const html=await readFile('public/index.html','utf8'),connected=await readFile('public/connected.js','utf8');
 assert.equal([...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1])[0],'/auth-link.js','auth-link.js runs before every other script');
 assert.match(connected,/async function boot\(\)\{if\(authLinkForwarded\)return;/,'boot renders nothing after forwarding');
});
test('a callback opened on another host is redirected to APP_ORIGIN before any verification',async()=>{
 const verified=[];
 const supabase=http.createServer(async(req,res)=>{for await(const chunk of req);verified.push(req.url);res.statusCode=500;res.end('{}');});
 await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
 const appOrigin='https://repready-gym.example';
 const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:appOrigin}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const get=(path,host)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path,headers:{host}},res=>{res.resume();resolve(res);}).on('error',reject));
 try{
  for(const host of ['form-fitness-achillespasuncion-2666.vercel.app','evil.example',`127.0.0.1:${server.address().port}`]){
   for(const query of ['?token_hash=abc123&type=recovery','?token_hash=abc123&type=invite','?code=pkce-code']){
    const res=await get('/api/auth/callback'+query,host);
    assert.equal(res.statusCode,302,`${host}${query}`);
    assert.equal(res.headers.location,appOrigin+'/api/auth/callback'+query,'the fixed APP_ORIGIN, with the query intact');
    assert.equal(res.headers['set-cookie'],undefined,'no session cookie on the wrong host');
   }
  }
  assert.equal(verified.length,0,'nothing is verified on the wrong host');
 }finally{server.close();supabase.close();}
});
test('a callback on the APP_ORIGIN host still verifies as before',async()=>{
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const expires=Math.floor(Date.now()/1000)+3600,userId='11111111-2222-3333-4444-555555555555';
 const accessToken=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'66666666-7777-8888-9999-000000000000'})}.test-signature`;
 const verified=[];
 const supabase=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;verified.push(JSON.parse(raw||'{}'));res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({access_token:accessToken,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh-token',user:{id:userId,aud:'authenticated',role:'authenticated',email:'right-host@example.invalid',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}}));});
 await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
 let appOrigin='';
 const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:appOrigin}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 appOrigin=`http://repready.test:${server.address().port}`;
 try{
  const res=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/api/auth/callback?token_hash=right-host&type=recovery',headers:{host:new URL(appOrigin).host}},r=>{r.resume();resolve(r);}).on('error',reject));
  assert.equal(res.statusCode,303);assert.equal(res.headers.location,appOrigin+'/#/set-password');
  assert((res.headers['set-cookie']||[]).some(cookie=>/HttpOnly/i.test(cookie)),'session cookie set on the real host');
  assert.equal(verified.at(-1).token_hash,'right-host');
 }finally{server.close();supabase.close();}
});
test('the setup email greets an account without a name properly',async()=>{
 const {readFile}=await import('node:fs/promises');
 const template=await readFile('supabase/templates/recovery.html','utf8');
 assert(template.includes('{{ if .Data.name }}Hello {{ .Data.name }},{{ else }}Hello,{{ end }}'));
 assert.equal(template.split('{{ .Data.name }}').length-1,1,'the name is printed only inside the conditional');
});
