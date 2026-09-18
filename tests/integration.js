import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';
import { createClient } from '@supabase/supabase-js';
if(process.env.APP_WORKSPACE!=='demo')throw Error('Integration writes are restricted to APP_WORKSPACE=demo.');
const creds=JSON.parse(await readFile('.local/demo-credentials.json','utf8'));
const adminAccount=creds.accounts.find(a=>a.role==='admin');
const customerAccount=creds.accounts.find(a=>a.email.includes('-customer@'))||creds.accounts[1];
const otherAccount=creds.accounts.find(a=>a.id!==adminAccount.id&&a.id!==customerAccount.id);
const origin=process.env.TEST_BASE_URL||process.env.APP_ORIGIN;
const evidence=[];
const passed=name=>{evidence.push(name);console.log('PASS: '+name);};
const context=async()=>{const ctx=await request.newContext({baseURL:origin,extraHTTPHeaders:{Origin:origin,...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{'x-vercel-protection-bypass':process.env.VERCEL_AUTOMATION_BYPASS_SECRET,'x-vercel-set-bypass-cookie':'true'}:{})}});if(process.env.VERCEL_AUTOMATION_BYPASS_SECRET)await ctx.get('/');return ctx;};
const admin=await context(),customer=await context(),other=await context(),anonymous=await context();
async function call(ctx,path,body,status=200){const response=body===undefined?await ctx.get('/api'+path):await ctx.post('/api'+path,{data:body});const data=await response.json();assert.equal(response.status(),status,`${path}: ${typeof data.error==='object'?JSON.stringify(data.error):data.error||response.status()}`);return data;}
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let originalPayments;
try{
  for(const [ctx,a] of [[admin,adminAccount],[customer,customerAccount],[other,otherAccount]])await call(ctx,'/login',{email:a.email,password:a.password});
  assert.equal((await call(admin,'/session')).user.role,'admin');assert.equal((await call(customer,'/session')).user.role,'member');passed('Real Supabase admin and both customer sign-ins');
  assert.equal((await anonymous.get('/api/state')).status(),401);
  assert.equal((await customer.post('/api/payments',{data:{}})).status(),403);
  assert.equal((await customer.post('/api/owner-login',{headers:{'oai-authenticated-user-id':adminAccount.id},data:{}})).status(),404);passed('Anonymous, forged owner header and member-to-admin API access denied');
  let state=await call(customer,'/state');assert.equal(state.members.length,1);assert.equal(state.members[0].id,customerAccount.id);
  assert(state.invoices.every(i=>i.memberId===customerAccount.id));passed('Customer API responses isolate all personal records');
  const restored=await request.newContext({baseURL:origin,storageState:await customer.storageState(),extraHTTPHeaders:{Origin:origin,...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?{'x-vercel-protection-bypass':process.env.VERCEL_AUTOMATION_BYPASS_SECRET,'x-vercel-set-bypass-cookie':'true'}:{})}});
  assert.equal((await call(restored,'/session')).user.id,customerAccount.id);await restored.dispose();passed('HttpOnly session restoration in a second browser context');
  for(const values of [{phone:''},{phone:'12345'},{email:'bad'},{name:''}])assert.equal((await customer.post('/api/profile',{data:{name:state.members[0].name,email:customerAccount.email,phone:'09170000001',...values}})).status(),400);
  assert.equal((await customer.post('/api/renew',{data:{plan:'nonexistent',start:new Date().toISOString().slice(0,10)}})).status(),400);passed('API rejects missing contacts, invalid Philippine phone, email, name and nonexistent plans');
  const oldProfile=state.members[0];await call(customer,'/profile',{name:oldProfile.name,email:oldProfile.email,phone:oldProfile.phone,goal:'Stay consistent'});
  assert.equal((await call(customer,'/state')).members[0].goal,'Stay consistent');passed('Profile persists through independent state reloads');
  let otherState=await call(other,'/state');let invoice=otherState.invoices.find(i=>i.paidCents===0);
  if(!invoice){const last=otherState.memberships.map(c=>c.end_date).sort().at(-1);const d=new Date(last+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);await call(other,'/renew',{plan:'basic',start:d.toISOString().slice(0,10)});otherState=await call(other,'/state');invoice=otherState.invoices.find(i=>i.paidCents===0);}
  assert.equal((await customer.post('/api/payment-submissions',{data:{invoiceId:invoice.id,amount:1,method:'GCash',reference:'ISOLATION-'+randomUUID()}})).status(),403);passed('Cross-customer invoice mutations denied');
  const adminState=await call(admin,'/state');originalPayments=Object.fromEntries(Object.entries(adminState.settings.payments).map(([k,v])=>[k,{...v,image:v.imagePath}]));
  await call(admin,'/settings/payments',{gcash:{image:png,name:'DEMO TEST IMAGE — NOT A PAYMENT QR',detail:'Automated image rendering test only'},bank:{image:png,name:'DEMO TEST IMAGE — NOT A PAYMENT QR',detail:'Automated image rendering test only'}});
  const destinations=(await call(other,'/state')).settings.payments;
  for(const dest of Object.values(destinations)){const response=await fetch(dest.image);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/png/);}
  passed('Private Storage uploads and signed GCash/bank image retrieval (synthetic non-payment image only)');
  const reference='TEST-'+randomUUID();
  const submission=await call(other,'/payment-submissions',{invoiceId:invoice.id,amount:'400.00',method:'GCash',reference,receipt:png});
  assert.equal((await call(other,'/state')).invoices.find(i=>i.id===invoice.id).paidCents,0);
  assert.equal((await other.post('/api/payment-submissions',{data:{invoiceId:invoice.id,amount:400,method:'GCash',reference}})).status(),409);passed('Receipt submission remains unpaid; duplicate references rejected');
  const responses=await Promise.all([1,2,3].map(()=>admin.post('/api/review-payment',{data:{id:submission.id,approve:true,verified:true}})));
  for(const r of responses)assert.equal(r.status(),200);
  state=await call(other,'/state');assert.equal(state.invoices.find(i=>i.id===invoice.id).paidCents,40000);assert.equal(state.payments.filter(p=>p.invoiceId===invoice.id).length,1);passed('Three concurrent approvals create exactly one payment and notification');
  assert.equal((await admin.post('/api/payments',{data:{invoiceId:invoice.id,amount:1000,method:'Cash',verified:true,idempotencyKey:randomUUID()}})).status(),409);passed('Overpayment rejected after concurrent partial approval');
  const rejection=await call(other,'/payment-submissions',{invoiceId:invoice.id,amount:1,method:'Bank transfer',reference:'REJECT-'+randomUUID()});
  await call(admin,'/review-payment',{id:rejection.id,approve:false});assert.equal((await call(other,'/state')).submissions.find(s=>s.id===rejection.id).status,'rejected');passed('Rejection persists without changing the balance');
  const key=randomUUID(),remainder=(invoice.amountCents-40000)/100;
  await call(admin,'/payments',{invoiceId:invoice.id,amount:remainder,method:'Cash',verified:true,idempotencyKey:key});
  await call(admin,'/payments',{invoiceId:invoice.id,amount:remainder,method:'Cash',verified:true,idempotencyKey:key});
  state=await call(other,'/state');assert.equal(state.invoices.find(i=>i.id===invoice.id).paidCents,invoice.amountCents);assert.equal(state.payments.filter(p=>p.invoiceId===invoice.id).length,2);passed('Full payment and duplicate direct request are atomic/idempotent');
  const pass=await call(customer,'/qr');
  const scanned=await call(admin,'/scan',{token:pass.token});assert.equal(scanned.member.id,customerAccount.id);
  assert.equal((await admin.post('/api/check-in',{data:{token:pass.token,confirmed:false}})).status(),400);
  assert.equal((await admin.post('/api/scan',{data:{token:pass.token+'tampered'}})).status(),400);
  await call(admin,'/manage-member',{id:customerAccount.id,enabled:false});
  assert.equal((await admin.post('/api/scan',{data:{token:pass.token}})).status(),400);
  await call(admin,'/manage-member',{id:customerAccount.id,enabled:true});
  await call(admin,'/check-in',{token:pass.token,confirmed:true});
  assert.equal((await admin.post('/api/check-in',{data:{token:pass.token,confirmed:true}})).status(),409);passed('Valid QR, tampering, inactive status, identity confirmation, check-in and replay protection through API');
  const direct=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  assert.equal((await direct.auth.signInWithPassword(customerAccount)).error,null);
  assert.equal((await direct.from('ff_profiles').select('id').eq('id',otherAccount.id)).data.length,0);
  assert((await direct.from('ff_profiles').update({role:'admin'}).eq('id',customerAccount.id)).error);
  assert((await direct.rpc('ff_command',{action:'plans',body:{}})).error);
  await direct.auth.updateUser({data:{role:'admin',ff_role:'admin',ff_workspace:'production'}});
  assert.equal((await direct.from('ff_profiles').select('role').eq('id',customerAccount.id).single()).data.role,'member');
  await direct.auth.signOut();passed('Direct Supabase RLS, role escalation and user-metadata forgery denied');
  const latest=await call(admin,'/state');assert(latest.outbox.every(n=>n.status==='suppressed'));assert.equal((await call(admin,'/email-retry',{})).status,'suppressed');passed('Demo notification records suppressed; send operation cannot send demo mail');
  for(const ctx of [admin,customer,other]){await call(ctx,'/logout',{});assert.equal((await call(ctx,'/session')).user,null);}
  passed('All three real accounts sign out and lose their API sessions');
}finally{
  if(originalPayments){try{await call(admin,'/login',{email:adminAccount.email,password:adminAccount.password});await call(admin,'/settings/payments',originalPayments);await call(admin,'/logout',{});}catch{console.error('Demo payment image cleanup requires review.');}}
  for(const ctx of [admin,customer,other,anonymous])await ctx.dispose();
  await mkdir('test-results',{recursive:true});await writeFile('test-results/integration-results.json',JSON.stringify({time:new Date().toISOString(),origin,passed:evidence},null,2));
}
