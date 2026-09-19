import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {request} from 'playwright';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
if(process.env.SUPABASE_URL!=='https://ivxbrhqqfgmhfpgpauzh.supabase.co')throw Error('Wrong project.');
const db=serviceClient();const created=[];const passed=[];let origin;
const env={...process.env,APP_WORKSPACE:'production',GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const server=http.createServer((req,res)=>handle(req,res,{...env,APP_ORIGIN:origin}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const admin=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}}),member=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin}});
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const call=async(ctx,path,body,status=200)=>{const response=await ctx.post('/api'+path,{data:body});const value=await response.json();assert.equal(response.status(),status,value.error||path);return value;};
const suffix=randomUUID().slice(0,8),password='Test9!'+randomBytes(24).toString('base64url');
// A mail client follows the confirmation link as a plain top-level GET and keeps the cookies
// it receives. Playwright throws on maxRedirects:0, so drive these groups with fetch instead.
const mailClient=()=>{
 const jar=new Map();
 const absorb=response=>{for(const raw of response.headers.getSetCookie()){const pair=raw.split(';')[0],split=pair.indexOf('=');jar.set(pair.slice(0,split).trim(),pair.slice(split+1));}return response;};
 const headers=extra=>({Origin:origin,...(jar.size?{Cookie:[...jar].map(([name,value])=>`${name}=${value}`).join('; ')}:{}),...extra});
 return {
  open:(type,tokenHash)=>fetch(`${origin}/api/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`,{redirect:'manual',headers:headers()}).then(absorb),
  get:path=>fetch(origin+'/api'+path,{headers:headers()}).then(absorb),
  post:(path,body)=>fetch(origin+'/api'+path,{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify(body)}).then(absorb)
 };
};
const hasSessionCookie=response=>response.headers.getSetCookie().some(cookie=>/httponly/i.test(cookie));
try{
 const email=`form-verification-admin-${suffix}@example.invalid`;
 const made=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',ff_role:'admin'},user_metadata:{form_fitness:true,name:'AUTH TEST Admin',phone:'09170000001'}});assert.equal(made.error,null);created.push(made.data.user.id);
 const profile=result(await db.from('ff_profiles').select('workspace,role').eq('id',made.data.user.id).single());assert.deepEqual(profile,{workspace:'production',role:'admin'});pass('Supported Auth createUser sees final trusted metadata through deferred provisioning');
 await call(admin,'/login',{email,password});
 for(const values of [{phone:''},{phone:'123'},{plan:'missing'}])await call(member,'/signup',{name:'AUTH TEST Signup',email:`form-verification-signup-${suffix}@example.invalid`,phone:'09170000003',password,plan:'basic',start:today(),...values},400);
 pass('Production signup endpoint rejects missing/invalid contacts and plan before sending mail');
 const memberEmail=`form-verification-member-${suffix}@example.invalid`;
 const invite=await call(admin,'/members',{name:'AUTH TEST Member',email:memberEmail,phone:'09170000002',plan:'basic',start:today()},201);created.push(invite.member.id);assert(invite.setupUrl);assert(!invite.password);
 const params=new URLSearchParams(invite.setupUrl.split('?')[1]);await call(member,'/auth/verify',{type:params.get('type'),tokenHash:params.get('token_hash')});
 await call(member,'/set-password',{newPassword:password});await call(member,'/logout',{});await call(member,'/login',{email:memberEmail,password});pass('Admin-created invitation, one-time verification, password setup and member login without email delivery');
 await call(member,'/auth/verify',{type:params.get('type'),tokenHash:params.get('token_hash')},400);pass('Invitation token cannot be reused');
 await call(member,'/logout',{});
 const recovery=await db.auth.admin.generateLink({type:'recovery',email:memberEmail});assert.equal(recovery.error,null);
 await call(member,'/auth/verify',{type:'recovery',tokenHash:recovery.data.properties.hashed_token});
 const nextPassword='Changed9!'+randomBytes(24).toString('base64url');await call(member,'/set-password',{newPassword:nextPassword});await call(member,'/logout',{});
 await call(member,'/login',{email:memberEmail,password},401);await call(member,'/login',{email:memberEmail,password:nextPassword});pass('Recovery verification and password replacement invalidate the previous password');
 await call(member,'/logout',{});
 // Recovery arriving as a hosted email link: GET navigation, no PKCE verifier present.
 const mailed=await db.auth.admin.generateLink({type:'recovery',email:memberEmail});assert.equal(mailed.error,null);
 const mailedHash=mailed.data.properties.hashed_token;
 const recoveryClient=mailClient();
 const landed=await recoveryClient.open('recovery',mailedHash);
 assert.equal(landed.status,303);assert.equal(landed.headers.get('location'),origin+'/#/set-password');
 assert(hasSessionCookie(landed),'The callback must issue an HttpOnly session cookie.');
 assert.equal((await (await recoveryClient.get('/session')).json()).user.email,memberEmail);
 const linkedPassword='Linked9!'+randomBytes(24).toString('base64url');
 const saved=await recoveryClient.post('/set-password',{newPassword:linkedPassword});assert.equal(saved.status,200);
 pass('Recovery email link verifies token_hash by GET navigation and issues an HttpOnly session');
 const replayed=await recoveryClient.open('recovery',mailedHash);
 assert.equal(replayed.status,400);assert.match(replayed.headers.get('content-type'),/text\/html/);
 assert.doesNotMatch(await replayed.text(),new RegExp(mailedHash.slice(0,12)),'The page must never echo the token.');
 pass('A reused confirmation link is refused with an HTML page, never a JSON body');
 // Signup confirmation already has a password, so it must land signed in, not on the setup form.
 const confirmEmail=`form-verification-confirm-${suffix}@example.invalid`;
 const signupLink=await db.auth.admin.generateLink({type:'signup',email:confirmEmail,password,
  options:{data:{form_fitness:true,name:'AUTH TEST Confirm',phone:'09170000004',plan:'basic',start:today(),goal:'Improve fitness'}}});
 assert.equal(signupLink.error,null);created.push(signupLink.data.user.id);
 const confirmClient=mailClient();
 const confirmed=await confirmClient.open('signup',signupLink.data.properties.hashed_token);
 assert.equal(confirmed.status,303);assert.equal(confirmed.headers.get('location'),origin+'/');
 assert(hasSessionCookie(confirmed),'Signup confirmation must issue an HttpOnly session cookie.');
 const confirmedSession=await (await confirmClient.get('/session')).json();
 assert.equal(confirmedSession.user.email,confirmEmail);assert.equal(confirmedSession.user.role,'member');
 pass('Signup confirmation lands on the dashboard with a live session, not the password setup form');
 const rejected=await confirmClient.open('bogus','irrelevant');
 assert.equal(rejected.status,400);assert.match(rejected.headers.get('content-type'),/text\/html/);
 pass('An unsupported confirmation type is refused before any Supabase call');
 await call(admin,'/logout',{});
}finally{
 await admin.dispose();await member.dispose();server.close();
 for(const id of created.reverse()){
  for(const table of ['ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));
  result(await db.from('ff_profiles').delete().eq('id',id));
  const {error}=await db.auth.admin.deleteUser(id);if(error)throw Error('Test Auth cleanup failed.');
 }
 await mkdir('test-results',{recursive:true});await writeFile('test-results/auth-results.json',JSON.stringify({time:new Date().toISOString(),passed,mailSent:false,temporaryAccountsRemoved:created.length},null,2));
}
