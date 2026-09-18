import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { serviceClient, result } from '../src/supabase.js';
import { today, contacts } from '../src/validation.js';

if(process.env.APP_WORKSPACE!=='demo')throw Error('Refusing demo setup: set APP_WORKSPACE=demo in the isolated demo environment.');
const emails=['DEMO_ADMIN_EMAIL','DEMO_CUSTOMER_EMAIL','DEMO_SECOND_CUSTOMER_EMAIL'].map(key=>process.env[key]?.trim().toLowerCase());
if(emails.some(x=>!x)||new Set(emails).size!==3)throw Error('Set three distinct demo email addresses you control. No invitations will be sent.');
const db=serviceClient();
const target=new URL(process.env.SUPABASE_URL).hostname;
if(!/^(ivxbrhqqfgmhfpgpauzh\.supabase\.co|localhost|127\.0\.0\.1)$/.test(target))throw Error('Unexpected Supabase project. Refusing seed.');
const credentialPath=path.resolve('.local/demo-credentials.json');
await mkdir('.local',{recursive:true});
let saved={};try{saved=JSON.parse(await readFile(credentialPath,'utf8'));}catch{}
const users=[];
for(let page=1;;page++){const {data,error}=await db.auth.admin.listUsers({page,perPage:1000});if(error)throw Error('Unable to list Auth users.');users.push(...data.users);if(data.users.length<1000)break;}
const credentials={project:target,workspace:'demo',createdAt:new Date().toISOString(),accounts:[]};
for(let index=0;index<emails.length;index++){
  const email=emails[index],role=index===0?'admin':'member',name=['DEMO Administrator','DEMO Customer','DEMO Isolation Customer'][index];
  contacts({name,email,phone:`0917000000${index}`});
  const existing=users.find(u=>u.email?.toLowerCase()===email);
  if(existing&&(existing.app_metadata?.ff_workspace!=='demo'||existing.app_metadata?.ff_seed!=='form-fitness'))throw Error('A supplied email belongs to an account outside this demo seed. Nothing will overwrite it.');
  const old=saved.accounts?.find(a=>a.email===email);
  const password=process.argv.includes('--reset')||!old?`Form9!${randomBytes(24).toString('base64url')}`:old.password;
  let user=existing;
  if(!user){const response=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'demo',ff_role:role,ff_seed:'form-fitness'},user_metadata:{form_fitness:true,name,phone:`0917000000${index}`,plan:'basic',start:today()}});if(response.error)throw Error('Demo Auth account creation failed. Check project logs without exposing credentials.');user=response.data.user;}
  else if(password!==old?.password||process.argv.includes('--reset')){const {error}=await db.auth.admin.updateUserById(user.id,{password});if(error)throw Error('Demo password reset failed.');}
  const profile=result(await db.from('ff_profiles').select('*').eq('id',user.id).single());
  if(profile.workspace!=='demo'||profile.role!==role)throw Error('Existing demo profile does not match the expected role.');
  credentials.accounts.push({email,password,id:user.id,role});
}
await writeFile(credentialPath,JSON.stringify(credentials,null,2),{mode:0o600});
if(process.platform==='win32'){
  const user=process.env.USERDOMAIN+'\\'+process.env.USERNAME;
  const locked=spawnSync('icacls',[credentialPath,'/inheritance:r','/grant:r',`${user}:(F)`],{encoding:'utf8'});
  if(locked.status!==0)throw Error('Credentials saved, but Windows ACL restriction failed. Restrict .local/demo-credentials.json before continuing.');
}
const admin=credentials.accounts[0];
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
if((await client.auth.signInWithPassword(admin)).error)throw Error('Demo admin sign-in failed.');
const rpc=async(action,body)=>result(await client.rpc('ff_command',{action,body}));
const member=credentials.accounts[1];
let cycles=result(await db.from('ff_memberships').select('*').eq('workspace','demo').eq('member_id',member.id).order('start_date'));
let active=cycles.find(c=>c.start_date<=today()&&c.end_date>=today());
if(!active){await rpc('renew',{memberId:member.id,plan:'basic',start:today()});cycles=result(await db.from('ff_memberships').select('*').eq('workspace','demo').eq('member_id',member.id).order('start_date'));active=cycles.find(c=>c.start_date<=today()&&c.end_date>=today());}
const invoice=result(await db.from('ff_invoices').select('*').eq('membership_id',active.id).single());
if(invoice.paid_cents<invoice.amount_cents)await rpc('payments',{invoiceId:invoice.id,amountCents:invoice.amount_cents-invoice.paid_cents,method:'Cash',idempotencyKey:invoice.id,verified:true,date:today()});
const future=new Date(active.end_date+'T12:00:00Z');future.setUTCDate(future.getUTCDate()+1);const start=future.toISOString().slice(0,10);
let next=cycles.find(c=>c.start_date===start);
if(!next){await rpc('renew',{memberId:member.id,plan:'plus',start});next=result(await db.from('ff_memberships').select('*').eq('member_id',member.id).eq('start_date',start).single());}
const nextInvoice=result(await db.from('ff_invoices').select('*').eq('membership_id',next.id).single());
const reference='DEMO-'+createHash('sha256').update(nextInvoice.id).digest('hex').slice(0,16).toUpperCase();
if(!result(await db.from('ff_submissions').select('id').eq('workspace','demo').eq('reference_key','GCash:'+reference.replaceAll('-','')).maybeSingle())){
  result(await db.from('ff_submissions').insert({workspace:'demo',member_id:member.id,invoice_id:nextInvoice.id,amount_cents:50000,method:'GCash',reference,reference_key:'GCash:'+reference.replaceAll('-',''),status:'pending'}));
}
await client.auth.signOut();
console.log('Demo accounts and sample records are ready. Outbound demo mail is suppressed.');
console.log('Credentials saved only in .local/demo-credentials.json with restricted local access. No passwords are printed.');
