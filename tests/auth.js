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
 await call(member,'/logout',{});await call(admin,'/logout',{});
}finally{
 await admin.dispose();await member.dispose();server.close();
 for(const id of created.reverse()){
  for(const table of ['ff_notifications','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));
  result(await db.from('ff_profiles').delete().eq('id',id));
  const {error}=await db.auth.admin.deleteUser(id);if(error)throw Error('Test Auth cleanup failed.');
 }
 await mkdir('test-results',{recursive:true});await writeFile('test-results/auth-results.json',JSON.stringify({time:new Date().toISOString(),passed,mailSent:false,temporaryAccountsRemoved:created.length},null,2));
}
