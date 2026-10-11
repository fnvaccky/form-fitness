import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {request} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
if(!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname))throw Error('Auth fixtures and invitation emails run only against a local stack.');
const db=serviceClient();const created=[];const passed=[];let origin;
const env={...process.env,APP_WORKSPACE:'production',GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const server=http.createServer((req,res)=>handle(req,res,{...env,APP_ORIGIN:origin}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const admin=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}}),member=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const call=async(ctx,path,body,status=200)=>{const response=await ctx.post('/api'+path,{data:body});const value=await response.json();assert.equal(response.status(),status,value.error||path);return value;};
const suffix=randomUUID().slice(0,8),password='Test9!'+randomBytes(24).toString('base64url'),fresh=label=>label+'9!'+randomBytes(24).toString('base64url');
const LINK_USED='This link expired or was already used — request a new one.';
// A mail client or a link scanner opens an emailed link as a plain top-level GET and keeps the cookies
// it receives. Playwright throws on maxRedirects:0, so drive these groups with fetch instead.
const mailClient=()=>{
 const jar=new Map();
 const absorb=response=>{for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0],split=pair.indexOf('=');jar.set(pair.slice(0,split).trim(),pair.slice(split+1));}return response;};
 const headers=extra=>({Origin:origin,...(jar.size?{Cookie:[...jar].map(([name,value])=>`${name}=${value}`).join('; ')}:{}),...extra});
 return {
  open:params=>fetch(`${origin}/api/auth/callback?${new URLSearchParams(params)}`,{redirect:'manual',headers:headers()}).then(absorb),
  get:path=>fetch(origin+'/api'+path,{headers:headers()}).then(absorb),
  post:(path,body)=>fetch(origin+'/api'+path,{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify(body)}).then(absorb)
 };
};
const hasSessionCookie=response=>response.headers.getSetCookie().some(cookie=>/-auth-token(\.\d+)?=[^;]/.test(cookie.split(';')[0])&&/httponly/i.test(cookie));
// Local Auth mail is captured by Mailpit. Newest first; skip a message already used.
async function mailFor(email,after,skip=''){
 for(let i=0;i<30;i++){
  const list=await (await fetch('http://127.0.0.1:54324/api/v1/messages?limit=50')).json();
  for(const item of list.messages||[])if(item.ID!==skip&&Date.parse(item.Created)>=after&&JSON.stringify(item.To).toLowerCase().includes(email))return (await fetch('http://127.0.0.1:54324/api/v1/message/'+item.ID)).json();
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 return null;
}
const linkToken=mail=>new URL(mail.HTML.match(/href="([^"]*token_hash=[^"]+)"/)[1].replaceAll('&amp;','&')).searchParams.get('token_hash');
try{
 const email=`form-verification-admin-${suffix}@example.invalid`;
 const made=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:'admin'},user_metadata:{form_fitness:true,name:'AUTH TEST Admin',phone:'09170000001'}});assert.equal(made.error,null);created.push(made.data.user.id);
 const profile=result(await db.from('ff_profiles').select('workspace,role').eq('id',made.data.user.id).single());assert.deepEqual(profile,{workspace:'production',role:'admin'});pass('Supported Auth createUser sees final trusted metadata through deferred provisioning');
 await call(admin,'/login',{email,password});
 for(const values of [{phone:''},{phone:'123'},{plan:'missing'}])await call(member,'/signup',{name:'AUTH TEST Signup',email:`form-verification-signup-${suffix}@example.invalid`,phone:'09170000003',password,plan:'basic',start:today(),...values},403);
 pass('Production signup endpoint rejects missing/invalid contacts and plan before sending mail');
 const memberEmail=`form-verification-member-${suffix}@example.invalid`;
 const pending=await call(admin,'/members',{name:'AUTH TEST Member',email:memberEmail,phone:'09170000002',plan:'basic',start:today(),requestId:randomUUID()},201);
 assert.equal(pending.accountReady,false);assert.equal(pending.invitationSent,false);
 const paid=await call(admin,'/registration-payment',{id:pending.registration.id,amount:pending.registration.amount_cents/100,method:'Cash',verified:true,emailConfirmed:true,idempotencyKey:randomUUID()});
 assert.equal(paid.accountReady,true);assert.equal(paid.invitationSent,true);created.push(paid.registration.member_id);
 const setup=await db.auth.admin.generateLink({type:'recovery',email:memberEmail});assert.equal(setup.error,null);const setupHash=setup.data.properties.hashed_token;
 await call(member,'/auth/verify',{type:'recovery',tokenHash:setupHash,newPassword:password});
 await call(member,'/logout',{});await call(member,'/login',{email:memberEmail,password});pass('First payment creates the account and sends setup email; Save password verifies the link and sets the password in one POST');
 await call(member,'/logout',{});
 assert.deepEqual(await call(member,'/auth/verify',{type:'recovery',tokenHash:setupHash,newPassword:fresh('Reused')},410),{error:LINK_USED});pass('Invitation token cannot be reused');
 const recovery=await db.auth.admin.generateLink({type:'recovery',email:memberEmail});assert.equal(recovery.error,null);
 const nextPassword=fresh('Changed');await call(member,'/auth/verify',{type:'recovery',tokenHash:recovery.data.properties.hashed_token,newPassword:nextPassword});await call(member,'/logout',{});
 await call(member,'/login',{email:memberEmail,password},401);await call(member,'/login',{email:memberEmail,password:nextPassword});pass('Recovery verification and password replacement invalidate the previous password');
 await call(member,'/logout',{});
 // BUG-011: a link scanner (Google Safe Browsing, Gmail, Brave) opens the emailed link before the person does.
 const mailed=await db.auth.admin.generateLink({type:'recovery',email:memberEmail});assert.equal(mailed.error,null);
 const mailedHash=mailed.data.properties.hashed_token;
 const scanner=mailClient();
 for(let visit=0;visit<2;visit++){
  const scanned=await scanner.open({token_hash:mailedHash,type:'recovery'});
  assert.equal(scanned.status,303);assert.equal(scanned.headers.get('location'),`${origin}/#/set-password?token_hash=${mailedHash}&type=recovery`);
  assert(!hasSessionCookie(scanned),'A visit must not sign anyone in.');
  assert.equal(await scanned.text(),'','The token is never echoed into a page.');
 }
 assert.equal((await (await scanner.get('/session')).json()).user,null);
 pass('A scanner opening the setup link only gets a redirect to the set-password screen, with no session');
 const person=mailClient();
 assert.equal((await person.open({token_hash:mailedHash,type:'recovery'})).status,303);
 const linkedPassword=fresh('Linked');
 const saved=await person.post('/auth/verify',{type:'recovery',tokenHash:mailedHash,newPassword:linkedPassword});
 assert.equal(saved.status,200,(await saved.clone().json()).error);assert(hasSessionCookie(saved),'Save password signs the person in with an HttpOnly session.');
 assert.equal((await (await person.get('/session')).json()).user.email,memberEmail);
 await call(member,'/login',{email:memberEmail,password:linkedPassword});await call(member,'/logout',{});
 pass('After the scans, the link still works: Save password verifies it and sets the password in one POST');
 const replayPassword=fresh('Replay');
 const replayed=await mailClient().post('/auth/verify',{type:'recovery',tokenHash:mailedHash,newPassword:replayPassword});
 assert.equal(replayed.status,410);assert.deepEqual(await replayed.json(),{error:LINK_USED});assert(!hasSessionCookie(replayed),'No session from a used link.');
 await call(member,'/login',{email:memberEmail,password:replayPassword},401);await call(member,'/login',{email:memberEmail,password:linkedPassword});await call(member,'/logout',{});
 pass('A second Save with the same link fails cleanly: 410, no session, and the password stays as first saved');
 // Forgot password from the app uses PKCE. Supabase's own template returns ?code=, which only the browser
 // that asked can exchange; a scanner trying the code first gets the expired page and uses nothing up.
 const asking=mailClient(),askedAt=Date.now()-2000;
 assert.equal((await asking.post('/recovery',{email:memberEmail})).status,200);
 const first=await mailFor(memberEmail,askedAt);assert(first,'Recovery email captured locally');
 const viaSupabase=await fetch(`${process.env.SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(linkToken(first))}&type=recovery&redirect_to=${encodeURIComponent(origin+'/api/auth/callback')}`,{redirect:'manual'});
 const code=new URL(viaSupabase.headers.get('location')).searchParams.get('code');assert(code,'Supabase hands back ?code=');
 const scannedCode=await mailClient().open({code});
 assert.equal(scannedCode.status,400);assert.match(scannedCode.headers.get('content-type'),/text\/html/);assert(!hasSessionCookie(scannedCode));
 const exchanged=await asking.open({code});
 assert.equal(exchanged.status,303);assert.equal(exchanged.headers.get('location'),origin+'/#/set-password');assert(hasSessionCookie(exchanged),'The ?code= exchange signs the asking browser in.');
 const codePassword=fresh('Code');assert.equal((await asking.post('/set-password',{newPassword:codePassword})).status,200);
 await call(member,'/login',{email:memberEmail,password:codePassword});await call(member,'/logout',{});
 pass('The ?code= fallback still works in the browser that asked, even after a scanner tried the code first');
 // The same Forgot password email opened on another device: its PKCE token_hash works through Save password.
 await new Promise(resolve=>setTimeout(resolve,1500));
 const secondAt=Date.now()-500;
 assert.equal((await mailClient().post('/recovery',{email:memberEmail})).status,200);
 const second=await mailFor(memberEmail,secondAt,first.ID);assert(second,'Second recovery email captured locally');
 const pkceHash=linkToken(second);assert(pkceHash.startsWith('pkce_'),'Forgot password links carry a PKCE token');
 const phone=mailClient();assert.equal((await phone.open({token_hash:pkceHash,type:'recovery'})).status,303);
 const phonePassword=fresh('Phone');
 const fromPhone=await phone.post('/auth/verify',{type:'recovery',tokenHash:pkceHash,newPassword:phonePassword});
 assert.equal(fromPhone.status,200,(await fromPhone.clone().json()).error);
 await call(member,'/login',{email:memberEmail,password:phonePassword});await call(member,'/logout',{});
 pass('A Forgot password link opened on another device works through Save password, without the PKCE verifier');
 const rejected=await mailClient().open({token_hash:'irrelevant',type:'bogus'});
 assert.equal(rejected.status,400);assert.match(rejected.headers.get('content-type'),/text\/html/);
 pass('An unsupported confirmation type is refused before any Supabase call');
 await call(admin,'/logout',{});
}finally{
 await admin.dispose();await member.dispose();server.close();
 for(const id of created.reverse()){
  result(await db.from('ff_registrations').delete().eq('member_id',id));
  for(const table of ['ff_checkins','ff_submissions','ff_payments','ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));
  result(await db.from('ff_profiles').delete().eq('id',id));
  const {error}=await db.auth.admin.deleteUser(id);if(error)throw Error('Test Auth cleanup failed.');
 }
 await mkdir('test-results',{recursive:true});await writeFile('test-results/auth-results.json',JSON.stringify({time:new Date().toISOString(),passed,mailSent:false,temporaryAccountsRemoved:created.length},null,2));
}
