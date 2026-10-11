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
// FEATURE-002: one password rule for the server and the screens. It matches Supabase Auth's
// "Lowercase, uppercase letters, digits and symbols" setting and its 72-character limit.
test('the password rule: 8–72 characters with an uppercase letter, a lowercase letter, a number and a keyboard symbol',async()=>{
  const rule=await import('../public/password-rule.js');
  assert.equal(rule.PASSWORD_MESSAGE,'Use at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol.');
  assert.deepEqual(rule.PASSWORD_CHECKS.map(check=>check.label),['8+ characters','Uppercase letter','Lowercase letter','Number','Symbol']);
  for(const value of ['Abcdef1!','Password1?','P4ssw0rd/x','correct-Horse7','Aa1!'+'x'.repeat(68)])assert.equal(password(value),value,value);
  for(const symbol of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')assert.equal(password('Abcdefg1'+symbol),'Abcdefg1'+symbol,`${symbol} counts as a symbol`);
  for(const [value,why] of [['abcdef1!','no uppercase letter'],['ABCDEF1!','no lowercase letter'],['Abcdefg!','no number'],['Abcdefg1','no symbol'],
    ['Abcde1!','7 characters'],['Aa1!'+'x'.repeat(69),'73 characters'],['Aa1!'+'x'.repeat(125),'129 characters'],['Aa1!'+'é'.repeat(35),'39 characters but 74 bytes'],
    ['Abcdefg1 ','a space is not a symbol'],['Abcdefg1₱','₱ is not a keyboard symbol'],['Ébcdefg1!','É is not A–Z'],['','empty'],[null,'missing'],[12345678,'not text']])
    assert.throws(()=>password(value),{message:rule.PASSWORD_MESSAGE},why);
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

// BUG-011: link scanners (Google Safe Browsing, Gmail, Brave) open email links before people do.
test('the callback never verifies on GET: every token link moves to the set-password screen with the token in the fragment',async()=>{
  const requests=[];
  const supabase=http.createServer(async(req,res)=>{for await(const chunk of req);requests.push(req.url);res.statusCode=500;res.end('{}');});
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:origin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const type of ['recovery','invite','signup','email']){
      // Scanners first, then the person: every visit gets the same redirect and nothing is used up.
      for(let visit=0;visit<3;visit++){
        const response=await fetch(`${origin}/api/auth/callback?token_hash=hash-${type}&type=${type}`,{redirect:'manual'});
        assert.equal(response.status,303,type);
        assert.equal(response.headers.get('location'),`${origin}/#/set-password?token_hash=hash-${type}&type=${type}`,type);
        assert.equal(response.headers.getSetCookie().length,0,'a visit never signs anyone in');
        assert.equal(response.headers.get('cache-control'),'private, no-store');
        assert.equal(response.headers.get('referrer-policy'),'no-referrer');
        assert.equal(await response.text(),'','the token is never echoed into a page');
      }
    }
    assert.deepEqual(requests,[],'a GET never reaches Supabase Auth');
  }finally{server.close();supabase.close();}
});

// A fake GoTrue whose token_hash links work exactly once, like the real one.
async function setupLinkServer({verifyStatus=0,rejectPassword=false,passwordError=null}={}){
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const userId='33333333-4444-5555-6666-777777777777',expires=Math.floor(Date.now()/1000)+3600;
  const user={id:userId,aud:'authenticated',role:'authenticated',email:'new-staff@example.invalid',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
  const state={requests:[],unused:new Set(['one-time']),password:null,rejectPassword,passwordError,
    session:{access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'88888888-9999-0000-1111-222222222222'})}.test-signature`,
      token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh-token',user},
    profile:{id:userId,workspace:'production',role:'staff',name:'New Staff',email:user.email,phone:'09170000009',enabled:true,goal:'',photo:'',created_at:new Date().toISOString()}};
  const supabase=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({method:req.method,path:url.pathname,scope:url.searchParams.get('scope'),body});
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/auth/v1/verify'){
      if(verifyStatus){res.statusCode=verifyStatus;return res.end(JSON.stringify({code:verifyStatus,msg:'unavailable'}));}
      if(state.unused.delete(body.token_hash))return res.end(JSON.stringify(state.session));
      res.statusCode=403;return res.end(JSON.stringify({code:403,error_code:'otp_expired',msg:'Email link is invalid or has expired'}));
    }
    if(url.pathname==='/auth/v1/user'&&req.method==='PUT'){
      if(state.passwordError){res.statusCode=state.passwordError.status;return res.end(JSON.stringify(state.passwordError.body));}
      if(state.rejectPassword){res.statusCode=422;return res.end(JSON.stringify({code:422,error_code:'same_password',msg:'New password should be different from the old password.'}));}
      state.password=body.password;return res.end(JSON.stringify(user));
    }
    if(url.pathname==='/auth/v1/user')return res.end(JSON.stringify(user));
    if(url.pathname==='/auth/v1/logout'){res.statusCode=204;return res.end();}
    if(url.pathname==='/rest/v1/ff_profiles')return res.end(JSON.stringify([state.profile]));
    res.statusCode=404;return res.end('{}');
  });
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${api.address().port}`;
  const save=(body,{from=origin,cookie=''}={})=>fetch(origin+'/api/auth/verify',{method:'POST',headers:{Origin:from,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  return {origin,state,save,close(){api.close();supabase.close();}};
}
const sessionCookies=response=>response.headers.getSetCookie().filter(value=>/-auth-token(\.\d+)?=[^;]/.test(value.split(';')[0]));
const verifyCalls=state=>state.requests.filter(r=>r.path==='/auth/v1/verify');

test('a scanned setup link still works: Save password verifies it and sets the password in one POST, once',async()=>{
  const s=await setupLinkServer();
  try{
    for(let visit=0;visit<3;visit++)assert.equal((await fetch(`${s.origin}/api/auth/callback?token_hash=one-time&type=recovery`,{redirect:'manual'})).status,303);
    assert.equal(s.state.requests.length,0,'opening the link checks nothing');
    const saved=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'StrongPassword2026!'});
    assert.equal(saved.status,200,(await saved.clone().json()).error);
    assert.deepEqual(await saved.json(),{ok:true});
    assert.equal(s.state.password,'StrongPassword2026!');
    assert(sessionCookies(saved).length&&sessionCookies(saved).every(value=>/HttpOnly/i.test(value)),'signed in with an HttpOnly session');
    assert.deepEqual(verifyCalls(s.state).map(({body})=>({type:body.type,token_hash:body.token_hash,code_verifier:body.code_verifier})),[{type:'recovery',token_hash:'one-time',code_verifier:undefined}],'verified once, with no PKCE verifier');
    const order=s.state.requests.map(r=>r.path==='/auth/v1/verify'?'verify':r.method==='PUT'?'set-password':r.path==='/auth/v1/logout'?'logout-'+r.scope:'').filter(Boolean);
    assert.deepEqual(order,['verify','set-password','logout-others'],'verify first, then the password, then other sessions end');
    // The same link again fails cleanly.
    const again=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'AnotherPassword2026!'});
    assert.equal(again.status,410);
    assert.deepEqual(await again.json(),{error:'This link expired or was already used — request a new one.'});
    assert.equal(sessionCookies(again).length,0,'no session');
    assert.equal(s.state.password,'StrongPassword2026!','the second attempt changes nothing');
    assert.equal(s.state.requests.filter(r=>r.method==='PUT').length,1);
  }finally{s.close();}
});

test('Save password refuses a bad request before the link is checked, so the link stays usable',async()=>{
  const s=await setupLinkServer();
  try{
    const good={type:'recovery',tokenHash:'one-time',newPassword:'StrongPassword2026!'};
    for(const [body,status] of [[{...good,newPassword:'short'},400],[{...good,newPassword:'abcdefghijklmn'},400],[{type:'recovery',tokenHash:'one-time'},400],
      [{...good,type:'email_change'},400],[{...good,type:'bogus'},400],[{...good,tokenHash:''},400],[{...good,tokenHash:42},400]]){
      const response=await s.save(body);
      assert.equal(response.status,status,JSON.stringify(body));
    }
    assert.equal((await s.save(good,{from:'https://evil.example'})).status,403,'another site cannot submit it');
    assert.equal(s.state.requests.length,0,'none of these reached Supabase Auth');
    assert.equal((await s.save(good)).status,200,'the link still works afterwards');
  }finally{s.close();}
});

test('if the link worked but the password is refused, the person is signed in and can save again',async()=>{
  const s=await setupLinkServer({rejectPassword:true});
  try{
    const refused=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'StrongPassword2026!'});
    assert.equal(refused.status,422);
    assert.deepEqual(await refused.json(),{error:'Choose a password different from your current one.'},'BUG-012: the real reason');
    const cookie=sessionCookies(refused).map(value=>value.split(';')[0]).join('; ');
    assert(cookie,'the verified session is kept for the retry');
    s.state.rejectPassword=false;
    const retry=await fetch(s.origin+'/api/set-password',{method:'POST',headers:{Origin:s.origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({newPassword:'DifferentPassword2026!'})});
    assert.equal(retry.status,200,(await retry.clone().json()).error);
    assert.equal(s.state.password,'DifferentPassword2026!');
    assert.equal(verifyCalls(s.state).length,1,'the retry does not need the link again');
  }finally{s.close();}
});

// BUG-012: when Supabase Auth refuses a new password, say why, on the link, its retry and Change password.
// The error bodies are Supabase Auth's own (v2.197). Nothing echoes the password.
const AUTH_REFUSALS={
  weakLength:{status:422,body:{code:422,error_code:'weak_password',msg:'Password should be at least 12 characters.',weak_password:{reasons:['length']}}},
  weakKinds:{status:422,body:{code:422,error_code:'weak_password',msg:"Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789, !@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~.",weak_password:{reasons:['characters']}}},
  weakBoth:{status:422,body:{code:422,error_code:'weak_password',msg:"Password should be at least 12 characters. Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789.",weak_password:{reasons:['length','characters']}}},
  breached:{status:422,body:{code:422,error_code:'weak_password',msg:'Password is known to be weak and easy to guess, please choose a different one.',weak_password:{reasons:['pwned']}}},
  samePassword:{status:422,body:{code:422,error_code:'same_password',msg:'New password should be different from the old password.'}},
  sessionGone:{status:403,body:{code:403,error_code:'session_not_found',msg:'Session from session_id claim in JWT does not exist'}},
  reauthenticate:{status:400,body:{code:400,error_code:'reauthentication_needed',msg:'Password update requires reauthentication'}}
};
const REFUSAL_MESSAGES={
  weakLength:'The account server needs at least 12 characters.',
  weakKinds:'The account server needs a lowercase letter, an uppercase letter, a number and a symbol.',
  weakBoth:'The account server needs at least 12 characters, with a lowercase letter, an uppercase letter and a number.',
  breached:'The account server refuses this password because it is known to be weak or breached. Choose a different one.',
  samePassword:'Choose a password different from your current one.'
};
const EXPIRED=['sessionGone','reauthenticate'],LINK_EXPIRED='Your link expired. Request a new one.',SIGN_IN_EXPIRED='Your sign-in expired. Sign in again, then change your password.';
test('Save password from a link says why the account server refused the password',async()=>{
  for(const [name,refusal] of Object.entries(AUTH_REFUSALS)){
    const s=await setupLinkServer({passwordError:refusal});
    try{
      const response=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'Secret9!pass'}),text=await response.text();
      assert.equal(response.status,EXPIRED.includes(name)?410:422,name);
      assert.deepEqual(JSON.parse(text),{error:EXPIRED.includes(name)?LINK_EXPIRED:REFUSAL_MESSAGES[name]},name);
      assert(!text.includes('Secret9!pass'),'the password is never echoed');
    }finally{s.close();}
  }
});
test('the retry and Change password give the same reasons',async()=>{
  for(const [name,refusal] of Object.entries(AUTH_REFUSALS)){
    const t=await consoleSession('member',{routes:{'/auth/v1/user':(req,res)=>{
      // consoleSession('member') signs in as this user; GET reads it, PUT (the password change) is refused.
      if(req.method!=='PUT')return res.end(JSON.stringify({id:'11111111-2222-3333-4444-555555555503',aud:'authenticated',role:'authenticated',email:'member@example.invalid',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}));
      res.statusCode=refusal.status;res.end(JSON.stringify(refusal.body));}}});
    try{
      const retry=await t.post('/set-password',{newPassword:'Secret9!pass'}),retryText=await retry.text();
      assert.equal(retry.status,EXPIRED.includes(name)?410:400,'retry '+name);
      assert.deepEqual(JSON.parse(retryText),{error:EXPIRED.includes(name)?LINK_EXPIRED:REFUSAL_MESSAGES[name]},'retry '+name);
      const change=await t.post('/password',{currentPassword:'fake-password',newPassword:'Secret9!pass'}),changeText=await change.text();
      assert.equal(change.status,EXPIRED.includes(name)?401:400,'change '+name);
      assert.deepEqual(JSON.parse(changeText),{error:EXPIRED.includes(name)?SIGN_IN_EXPIRED:REFUSAL_MESSAGES[name]},'change '+name);
      assert(!retryText.includes('Secret9!pass')&&!changeText.includes('Secret9!pass'),'the password is never echoed');
    }finally{t.close();}
  }
});
test('an unknown account-server refusal keeps the generic message',async()=>{
  const s=await setupLinkServer({passwordError:{status:500,body:{code:500,msg:'Internal error'}}});
  try{
    const response=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'Secret9!pass'});
    assert.equal(response.status,422);
    assert.match((await response.json()).error,/link worked, but this password couldn.t be saved/);
  }finally{s.close();}
});
test('the app password rule is 8 characters plus all four character kinds, and the local Auth settings match it',async()=>{
  const {readFile}=await import('node:fs/promises');
  const rule=await import('../public/password-rule.js'),config=await readFile('supabase/config.toml','utf8');
  assert.equal(rule.PASSWORD_MIN,8);
  assert.deepEqual(rule.PASSWORD_CHECKS.map(check=>check.label),['8+ characters','Uppercase letter','Lowercase letter','Number','Symbol']);
  // The hosted project must use the same values (DEPLOYMENT.md); otherwise Supabase refuses passwords the app accepts (BUG-012).
  assert.match(config,/^minimum_password_length = 8$/m);
  assert.match(config,/^password_requirements = "lower_upper_letters_digits_symbols"$/m);
});
test('the set-password screen shows an expired link, with Forgot password, after the link or its retry',async()=>{
  const {readFile}=await import('node:fs/promises');
  const connected=await readFile('public/connected.js','utf8');
  const handler=connected.slice(connected.indexOf("'setup-password-form':"),connected.indexOf("'renew-form':"));
  assert.equal(handler.split('return setupLinkExpired(e.message)').length-1,2,'both the link save and the retry');
  assert.match(connected,/function setupLinkExpired\(message='This link expired or was already used — request a new one\.'\)/);
});
test('Save password reports a busy or unreachable Auth server as retryable, not as an expired link',async()=>{
  for(const [verifyStatus,status] of [[429,429],[500,503],[502,503]]){
    const s=await setupLinkServer({verifyStatus});
    try{
      const response=await s.save({type:'recovery',tokenHash:'one-time',newPassword:'StrongPassword2026!'});
      assert.equal(response.status,status,String(verifyStatus));
      assert.doesNotMatch((await response.json()).error,/expired/);
      assert.equal(s.state.password,null);
    }finally{s.close();}
  }
});

// FEATURE-002: the browser checks the rule too, but a request that skips the page gets the same answer.
test('the API refuses a weak password even when the browser check is bypassed',async()=>{
  const {PASSWORD_MESSAGE}=await import('../public/password-rule.js');
  const session=await consoleSession('member');
  try{
    for(const [path,body] of [['/set-password',{newPassword:'abcdefgh1234'}],['/set-password',{newPassword:'Abcdefg1'}],['/password',{currentPassword:'fake-password',newPassword:'abcdefgh1234'}]]){
      const before=session.state.requests.length;
      const response=await session.post(path,body);
      assert.equal(response.status,400,`${path} ${body.newPassword}`);
      assert.deepEqual(await response.json(),{error:PASSWORD_MESSAGE});
      assert(!session.state.requests.slice(before).some(r=>r.path.startsWith('/auth/v1/')&&r.method!=='GET'),'Supabase Auth is never asked to change it');
    }
    const enough=await session.post('/set-password',{newPassword:'Abcdef1!'});
    assert.equal(enough.status,200,'8 characters with every kind is enough');
  }finally{session.close();}
  const link=await setupLinkServer();
  try{
    const weak=await link.save({type:'recovery',tokenHash:'one-time',newPassword:'abcdefgh1234'});
    assert.equal(weak.status,400);assert.deepEqual(await weak.json(),{error:PASSWORD_MESSAGE});
    assert.equal(link.state.requests.length,0,'the setup link is not used up');
  }finally{link.close();}
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
  for(const deny of ['recordOnlinePayment','reviewPayment','manageMember','plans','paymentSettings','systemSettings','cancelCheckout'])assert.notEqual(staff[deny],true,'staff must not have '+deny);
  for(const grant of ['reviewPayment','plans','paymentSettings','systemSettings','manageMember','recordOnlinePayment','cancelCheckout'])assert.equal(admin[grant],true,'admin should have '+grant);
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
    if(state.routes?.[url.pathname])return state.routes[url.pathname]({method:req.method,body:raw?JSON.parse(raw):null},res);
    if(url.pathname==='/auth/v1/token')return res.end(JSON.stringify(state.session));
    if(url.pathname==='/auth/v1/user')return res.end(JSON.stringify(state.session.user));
    if(url.pathname==='/auth/v1/logout'){res.statusCode=204;return res.end();}
    if(url.pathname==='/rest/v1/ff_profiles')return res.end(JSON.stringify([state.profile]));
    if(url.pathname==='/rest/v1/ff_plans')return res.end(JSON.stringify([{id:'basic',name:'Essential',days:30,features:['All strength equipment']}]));
    if(url.pathname==='/auth/v1/invite')return res.end(JSON.stringify({action_link:'https://example.invalid/link',email_otp:'',hashed_token:'fake-hash',redirect_to:'',verification_type:'invite',id:'99999999-0000-0000-0000-000000000000',email:'new-member@example.invalid',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}));
    if(url.pathname==='/rest/v1/rpc/ff_registration')return res.end(JSON.stringify({id:'99999999-0000-0000-0000-000000000001',status:'awaiting_payment',...JSON.parse(raw).body}));
    if(url.pathname==='/rest/v1/rpc/ff_command')return res.end(JSON.stringify({ok:true}));
    res.statusCode=404;return res.end('{}');
  });
}
async function consoleSession(role,{env:extraEnv={},routes}={}){
  const userId=`11111111-2222-3333-4444-55555555550${role==='admin'?1:role==='staff'?2:3}`;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires=Math.floor(Date.now()/1000)+3600;
  const accessToken=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:userId,aud:'authenticated',exp:expires,session_id:'66666666-7777-8888-9999-000000000000'})}.signature`;
  const user={id:userId,aud:'authenticated',role:'authenticated',email:`${role}@example.invalid`,app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
  const state={requests:[],session:{access_token:accessToken,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh',user},
    profile:{id:userId,workspace:'production',role,name:`Test ${role}`,email:user.email,phone:'09170000001',enabled:true,goal:'',photo:'',created_at:new Date().toISOString()},routes};
  const supabase=fakeSupabase(state);
  await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
  let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable',SUPABASE_SECRET_KEY:'secret',APP_ORIGIN:origin,APP_WORKSPACE:'production',...extraEnv}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${api.address().port}`;
  const landing=await fetch(`${origin}/api/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'fake-password'})});
  assert.equal(landing.status,200,'the fake session signs in');
  const cookie=landing.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return {origin,state,
    post:(path,body)=>fetch(origin+'/api'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body||{})}),
    close(){api.close();supabase.close();}};
}

// Task 09 Part B: Cancel checkout, offline. PayMongo is a stub and the database calls go to the fake.
// The stuck shape: needs_review, never bound, its PayMongo session id saved at review.
async function cancelHarness(role,{status='active',expireStatus=200,afterExpire,reference}={}){
  const row={id:'44444444-5555-6666-7777-888888888888',workspace:'production',livemode:false,status:'needs_review',session_id:null,review_reason:'checkout_reference_mismatch',
    review_details:{category:'checkout_reference_mismatch',sessionId:'cs_UnitStuck'},amount_cents:89900,methods:['card'],invoice_id:'55555555-6666-7777-8888-999999999999',
    registration_id:null,member_id:null,checkout_url:null,review_log:[],created_at:new Date().toISOString()};
  const session={id:'cs_UnitStuck',type:'checkout_session',attributes:{livemode:false,status,reference_number:reference||row.id,payments:[]}};
  const calls=[],cancelRpc=[],realFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    if(!String(url).startsWith('https://api.paymongo.com/'))return realFetch(url,options);
    const path=new URL(url).pathname;calls.push({method:options.method||'GET',path,body:options.body,auth:options.headers?.Authorization});
    if(path.endsWith('/expire')){
      if(expireStatus!==200)return Response.json({errors:[{code:'unit_refused',detail:'Refused by the stub.'}]},{status:expireStatus});
      session.attributes.status='expired';afterExpire?.(session);return Response.json({data:session});
    }
    return Response.json({data:session});
  };
  const t=await consoleSession(role,{env:{PAYMONGO_SECRET_KEY:'sk_test_unitstub',PAYMONGO_WEBHOOK_SECRET:'unit-webhook-secret',PAYMONGO_ALLOW_LIVE:'false'},routes:{
    '/rest/v1/ff_checkouts':(req,res)=>res.end(JSON.stringify([row])),
    '/rest/v1/rpc/ff_paymongo_cancel':(req,res)=>{cancelRpc.push(req.body);res.end(JSON.stringify(req.body.action==='check'?row:{...row,status:'expired',session_id:req.body.body.sessionId,review_reason:null}));},
    '/rest/v1/rpc/ff_paymongo_review':(req,res)=>res.end(JSON.stringify({...row,review_reason:req.body.body.category}))}});
  return {...t,row,calls,cancelRpc,cancel:()=>t.post('/paymongo/cancel',{id:row.id}),close(){globalThis.fetch=realFetch;t.close();}};
}
const callList=calls=>calls.map(call=>`${call.method} ${call.path}`);
test('only administrators can cancel a checkout: staff and members are refused before PayMongo is asked',async()=>{
  for(const role of ['staff','member']){
    const t=await cancelHarness(role);
    try{
      const response=await t.cancel();
      assert.equal(response.status,403,role);
      assert.deepEqual(t.calls,[],'PayMongo is never contacted');assert.deepEqual(t.cancelRpc,[],'the database is never asked');
    }finally{t.close();}
  }
});
test('Cancel checkout re-reads the session, expires it with a bodyless POST, confirms it, then records it',async()=>{
  const t=await cancelHarness('admin');
  try{
    const response=await t.cancel(),body=await response.json();
    assert.equal(response.status,200,body.error);
    assert.equal(body.cancelled,true);assert.equal(body.checkout.status,'expired');
    assert.deepEqual(callList(t.calls),['GET /v1/checkout_sessions/cs_UnitStuck','POST /v1/checkout_sessions/cs_UnitStuck/expire','GET /v1/checkout_sessions/cs_UnitStuck']);
    assert.equal(t.calls[1].body,undefined,'the expire call has no body');assert.match(t.calls[1].auth,/^Basic /);
    assert.deepEqual(t.cancelRpc.map(c=>c.action),['check','expire'],'the database checks first and records only after PayMongo confirms');
    assert.deepEqual(t.cancelRpc[1].body,{id:t.row.id,sessionId:'cs_UnitStuck',providerStatus:200,via:'expire'});
  }finally{t.close();}
});
test('a checkout PayMongo already expired is only closed here',async()=>{
  const t=await cancelHarness('admin',{status:'expired'});
  try{
    const response=await t.cancel(),body=await response.json();
    assert.equal(response.status,200,body.error);assert.equal(body.cancelled,true);
    assert.deepEqual(callList(t.calls),['GET /v1/checkout_sessions/cs_UnitStuck'],'no expire call');
    assert.deepEqual(t.cancelRpc[1].body,{id:t.row.id,sessionId:'cs_UnitStuck',providerStatus:200,via:'already_expired'});
  }finally{t.close();}
});
test('if PayMongo does not confirm the expiry, the checkout is left unchanged and the error is shown',async()=>{
  // 500: the call failed. 400 with the session still active: PayMongo refused, e.g. a payment is in progress.
  // 200 but a fresh read still says active: uncertain.
  for(const [options,status] of [[{expireStatus:500},502],[{expireStatus:400},409],[{afterExpire:session=>{session.attributes.status='active';}},502]]){
    const t=await cancelHarness('admin',options);
    try{
      const response=await t.cancel(),body=await response.json();
      assert.equal(response.status,status,JSON.stringify(options));
      assert.match(body.error,/Nothing was changed/);
      assert.deepEqual(t.cancelRpc.map(c=>c.action),['check'],'no expiry is recorded');
    }finally{t.close();}
  }
});
test('a PayMongo session that does not belong to the checkout is never expired',async()=>{
  const t=await cancelHarness('admin',{reference:'99999999-8888-7777-6666-555555555555'});
  try{
    const response=await t.cancel();
    assert.equal(response.status,409);
    assert.deepEqual(callList(t.calls),['GET /v1/checkout_sessions/cs_UnitStuck'],'no expire call');
    assert.deepEqual(t.cancelRpc.map(c=>c.action),['check']);
    assert(t.state.requests.some(r=>r.path==='/rest/v1/rpc/ff_paymongo_review'&&r.body.body.category==='checkout_reference_mismatch'),'flagged for review like every other mismatch');
  }finally{t.close();}
});
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
  // Vercel's rewrite adds __path and path to the query; the redirect carries only the original query.
  for(const path of ['/api/auth/callback?token_hash=abc123&type=recovery&__path=auth%2Fcallback&path=auth%2Fcallback','/api?__path=auth%2Fcallback&token_hash=abc123&type=recovery&path=auth%2Fcallback']){
   const res=await get(path,'form-fitness-achillespasuncion-2666.vercel.app');
   assert.equal(res.statusCode,302,path);
   assert.equal(res.headers.location,appOrigin+'/api/auth/callback?token_hash=abc123&type=recovery',path);
  }
  assert.equal(verified.length,0,'nothing is verified on the wrong host');
 }finally{server.close();supabase.close();}
});
test('a callback on the APP_ORIGIN host moves to the set-password screen without verifying',async()=>{
 const verified=[];
 const supabase=http.createServer(async(req,res)=>{for await(const chunk of req);verified.push(req.url);res.statusCode=500;res.end('{}');});
 await new Promise(resolve=>supabase.listen(0,'127.0.0.1',resolve));
 let appOrigin='';
 const server=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${supabase.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-placeholder',APP_ORIGIN:appOrigin}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 appOrigin=`http://repready.test:${server.address().port}`;
 try{
  const res=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/api/auth/callback?token_hash=right-host&type=recovery',headers:{host:new URL(appOrigin).host}},r=>{r.resume();resolve(r);}).on('error',reject));
  assert.equal(res.statusCode,303);assert.equal(res.headers.location,appOrigin+'/#/set-password?token_hash=right-host&type=recovery');
  assert.equal(res.headers['set-cookie'],undefined,'no session from a visit');
  assert.equal(verified.length,0,'nothing is verified');
 }finally{server.close();supabase.close();}
});
// Runs public/auth-link.js the way the page does: first, before any other script.
async function authLinkRun(pathname,search,hash){
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const calls={replace:[],replaceState:[]};
 const ctx={URLSearchParams,location:{pathname,search,hash,replace:url=>calls.replace.push(url)},history:{replaceState:(state,title,url)=>calls.replaceState.push(url)}};
 vm.createContext(ctx);vm.runInContext(await readFile('public/auth-link.js','utf8'),ctx);
 return {forwarded:vm.runInContext('authLinkForwarded',ctx),setupLink:JSON.parse(JSON.stringify(vm.runInContext('setupLink',ctx))),calls};
}
test('the set-password token is read from the fragment once, kept in memory and removed from the address bar',async()=>{
 for(const type of ['recovery','invite','signup','email']){
  const r=await authLinkRun('/','',`#/set-password?token_hash=abc123&type=${type}`);
  assert.equal(r.forwarded,false);
  assert.deepEqual(r.setupLink,{tokenHash:'abc123',type},type);
  assert.deepEqual(r.calls.replaceState,['/#/set-password'],'the token leaves the current history entry');
  assert.equal(r.calls.replace.length,0,'no navigation, so no request ever carries the token');
 }
 for(const hash of ['#/set-password?token_hash=abc123&type=bogus','#/set-password?type=recovery','#/set-password?token_hash=abc123']){
  const r=await authLinkRun('/','',hash);
  assert.equal(r.setupLink,null,hash);assert.deepEqual(r.calls.replaceState,['/#/set-password'],'stripped even when unusable');
 }
 for(const hash of ['','#/set-password','#/admin/members','#/member/overview?token_hash=abc123&type=recovery']){
  const r=await authLinkRun('/','',hash);
  assert.equal(r.setupLink,null,hash);assert.equal(r.calls.replaceState.length,0,`${hash} is left alone`);
 }
 const forwarded=await authLinkRun('/','?token_hash=abc123&type=recovery','#/set-password?token_hash=other&type=recovery');
 assert.equal(forwarded.forwarded,true);assert.equal(forwarded.setupLink,null,'a forwarded page reads nothing');
});
test('the set-password screen checks the link only when Save password is pressed',async()=>{
 const {readFile}=await import('node:fs/promises');
 const connected=await readFile('public/connected.js','utf8');
 const setup=connected.slice(connected.indexOf('async function passwordSetup(){'),connected.indexOf('selectPlan=function'));
 assert(setup.length>0&&!setup.includes("api('/auth/verify'"),'opening the screen calls no API with the token');
 assert(!/location\.hash/.test(setup),'the screen uses the token captured by auth-link.js, not the address bar');
 const handler=connected.slice(connected.indexOf("'setup-password-form':"),connected.indexOf("'renew-form':"));
 assert.match(handler,/api\('\/auth\/verify',\{\.\.\.link,newPassword\}\)/,'Save password sends the token with the new password in one POST');
 assert.match(handler,/status===410/,'an expired link gets its own screen');
 assert.match(connected,/This link expired or was already used — request a new one/);
 assert.match(connected,/btn\('Forgot password','forgot-password'/,'with a button that opens Forgot password');
});
// Task 09 Part A: leftovers that made the app look inconsistent to people and to phishing checks.
test('shipped pages carry no FORM branding and no Google app-password form',async()=>{
 const {readFile,readdir}=await import('node:fs/promises');
 const shipped=[...(await readdir('public')).filter(name=>/\.(js|html|css|svg)$/.test(name)).map(name=>'public/'+name),
  ...(await readdir('supabase/templates')).map(name=>'supabase/templates/'+name)];
 assert(shipped.includes('public/connected.js')&&shipped.includes('public/index.html'));
 for(const file of shipped){
  // FORM2. is the QR token prefix and FORM_QR a script global: data formats, never shown to anyone.
  const text=await readFile(file,'utf8'),rest=text.replace(/FORM2\.|FORM_QR/g,''),leftover=rest.match(/\bFORM\b/g)||rest.match(/form[ -]?fitness/gi);
  assert.equal(leftover,null,`${file} still says ${leftover}`);
  for(const marker of ['gmail-password','gmail-settings-form','Google app password','myaccount.google.com','disconnect-email'])
   assert(!text.includes(marker),`${file} still contains ${marker}`);
 }
 const connected=await readFile('public/connected.js','utf8');
 const headline=connected.match(/<h1>(Your next chapter.*?)<\/h1>/)[1];
 assert.equal(headline.replace(/<br>/g,'').replace(/\s+/g,' '),'Your next chapter starts here.','phones hide the line break, so the words need their own space');
});
test('the favicon is the RepReady R mark in the sidebar colours, with an apple-touch-icon',async()=>{
 const {readFile}=await import('node:fs/promises');
 const svg=await readFile('public/favicon.svg','utf8'),html=await readFile('public/index.html','utf8');
 assert.match(svg,/fill="#183e33"/,'the sidebar mark background (--ink)');assert.match(svg,/fill="#dcf0c6"/,'the sidebar mark letter (--lime)');
 assert(!svg.includes('M19 17h29v8H28v7h17v8H28v12h-9z'),'the old F is gone');
 assert.match(html,/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
 assert.match(html,/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
 const png=await readFile('public/apple-touch-icon.png');
 assert.equal(png.subarray(1,4).toString(),'PNG');assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[180,180],'180 × 180');
});
test('the setup email greets an account without a name properly',async()=>{
 const {readFile}=await import('node:fs/promises');
 const template=await readFile('supabase/templates/recovery.html','utf8');
 assert(template.includes('{{ if .Data.name }}Hello {{ .Data.name }},{{ else }}Hello,{{ end }}'));
 assert.equal(template.split('{{ .Data.name }}').length-1,1,'the name is printed only inside the conditional');
});
