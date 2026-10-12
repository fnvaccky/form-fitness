// Resets RepReady test data: deletes ALL member data in the production workspace of the linked Supabase
// project, or of the local stack with --local. In order: preview, backup to .local/backups/, close open
// PayMongo checkouts (test mode only), delete in one transaction (PART 2 of scripts/reset-test-data.sql),
// remove the members' storage files, verify. A real run needs --confirm "DELETE ALL MEMBERS"; --dry-run
// rehearses every step, only reads PayMongo, leaves storage alone and rolls the delete back.
// Keys and secrets are never printed.
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';

export const CONFIRM='DELETE ALL MEMBERS';
const WORKSPACE='production',BUCKET='form-fitness-private',OPEN=['creating','pending','needs_review'];
const SQL_FILE=path.resolve('scripts/reset-test-data.sql');
const CONFIRM_LINE="confirm constant text := 'type DELETE ALL MEMBERS here';";
const CLOSED_LINE="closed constant jsonb := '[]';";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION=/^cs_[A-Za-z0-9]+$/;

export function parseArgs(argv){
 const args={dryRun:false,local:false,confirm:null};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--dry-run')args.dryRun=true;
  else if(a==='--local')args.local=true;
  else if(a==='--confirm')args.confirm=argv[++i]??'';
  else if(a.startsWith('--confirm='))args.confirm=a.slice('--confirm='.length);
  else throw Error(`Unknown option ${a}. Use --confirm "${CONFIRM}", --dry-run and optionally --local.`);
 }
 if(!args.dryRun&&args.confirm!==CONFIRM)
  throw Error(`This deletes ALL member data and can't be undone. To run it, add --confirm "${CONFIRM}" exactly. To rehearse it without deleting anything, use --dry-run.`);
 return args;
}

// PART 1 and PART 2 of the SQL file; this script runs exactly the SQL that the SQL Editor runs.
export function sqlParts(text){
 const t=text.replace(/\r\n/g,'\n'),one=t.indexOf('-- ===== PART 1'),two=t.indexOf('-- ===== PART 2');
 if(one<0||two<one)throw Error('scripts/reset-test-data.sql is missing its PART 1 / PART 2 markers.');
 return {preview:t.slice(t.indexOf('\n',one)+1,two).trim().replace(/;\s*$/,''),remove:t.slice(t.indexOf('\n',two)+1).trim()};
}
// PART 2 with the confirmation typed in and the checkouts this run closed at PayMongo.
export function deleteSql(remove,closed){
 if(!closed.every(id=>UUID.test(id)))throw Error('Unexpected checkout id.');
 const once=(sql,from,to)=>{if(sql.split(from).length!==2)throw Error(`PART 2 of scripts/reset-test-data.sql no longer contains: ${from}`);return sql.replace(from,()=>to);};
 return once(once(remove,CONFIRM_LINE,`confirm constant text := '${CONFIRM}';`),CLOSED_LINE,`closed constant jsonb := '${JSON.stringify(closed)}';`);
}

// Every open checkout is read at PayMongo first, in test mode only, and its session must be ours
// (reference_number is the checkout id). A paid one is only listed: the reset wipes it without recording
// it. An active one is expired and read again to confirm. Anything uncertain stops the reset before
// anything is deleted. A dry run only reads.
export async function closeCheckouts(checkouts,{key,dryRun=false,fetchImpl=fetch}){
 const out={closed:[],paid:[],expired:[],alreadyExpired:[],wouldExpire:[]};
 if(!checkouts.length)return out;
 if(!/^sk_test_[A-Za-z0-9_-]+$/.test(key||''))throw Error('Open checkouts need PAYMONGO_SECRET_KEY to be a PayMongo test key (sk_test_…). Nothing was deleted.');
 const headers={Authorization:'Basic '+Buffer.from(key+':').toString('base64'),Accept:'application/json'};
 const call=async(sessionId,suffix='',method='GET')=>{
  const response=await fetchImpl('https://api.paymongo.com/v1/checkout_sessions/'+encodeURIComponent(sessionId)+suffix,{method,headers});
  let data=null;try{data=await response.json();}catch{}
  return {status:response.status,data};
 };
 for(const checkout of checkouts){
  const sessionId=checkout.session_id||checkout.review_details?.sessionId;
  if(!SESSION.test(sessionId||''))throw Error(`Checkout ${checkout.id} has no PayMongo session to check. Cancel it from the admin screen first. Nothing was deleted.`);
  const read=async()=>{
   const {status,data}=await call(sessionId);
   const session=data?.data;
   if(status!==200||session?.id!==sessionId)throw Error(`PayMongo answered HTTP ${status} for checkout ${checkout.id}. Nothing was deleted.`);
   if(session.attributes?.livemode!==false)throw Error(`Checkout ${checkout.id}'s PayMongo session is not in test mode. Nothing was deleted.`);
   if(session.attributes?.reference_number!==checkout.id)throw Error(`Checkout ${checkout.id}'s PayMongo session belongs to another checkout. Nothing was deleted.`);
   return {session,paid:(session.attributes.payments||[]).find(p=>p.attributes?.status==='paid')};
  };
  const paidRecord=paid=>({id:checkout.id,sessionId,amount:(paid.attributes.amount||0)/100,method:paid.attributes.source?.type||'',
   paidAt:paid.attributes.paid_at?new Date(paid.attributes.paid_at*1000).toISOString():''});
  let {session,paid}=await read();
  if(paid){out.paid.push(paidRecord(paid));out.closed.push(checkout.id);continue;}
  if(session.attributes.status==='expired'){out.alreadyExpired.push(checkout.id);out.closed.push(checkout.id);continue;}
  if(dryRun){out.wouldExpire.push(checkout.id);out.closed.push(checkout.id);continue;}
  const expired=await call(sessionId,'/expire','POST');
  ({session,paid}=await read());
  if(paid){out.paid.push(paidRecord(paid));out.closed.push(checkout.id);continue;}
  if(session.attributes.status!=='expired')throw Error(`PayMongo did not expire checkout ${checkout.id} (HTTP ${expired.status}). Nothing was deleted.`);
  out.expired.push(checkout.id);out.closed.push(checkout.id);
 }
 return out;
}

// The members' files: their own folders, plus photo and receipt paths their rows point to (a photo staff
// uploaded sits in the staff member's folder). Never the payments/ QR images, never a kept account's photo.
export function memberFiles({paths,kept=[],workspace=WORKSPACE}){
 const keep=new Set(kept.filter(Boolean)),files=new Set();
 for(const p of paths)if(typeof p==='string'&&p.startsWith(workspace+'/')&&!p.startsWith(workspace+'/payments/')&&!p.includes('..')&&!keep.has(p))files.add(p);
 return [...files].sort();
}

function databaseMessage(text){
 const match=String(text).match(/ERROR:\s+(?:[A-Z0-9]{5}:\s+)?([^\n\\"]+)/);
 return (match?match[1]:String(text).split('\n')[0]).trim().slice(0,300);
}
function localRunner(){
 return async sql=>{
  const r=spawnSync('docker',['exec','-i','supabase_db_RepReady','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-At'],
   {input:sql,encoding:'utf8',maxBuffer:1<<30,env:{...process.env,MSYS_NO_PATHCONV:'1'}});
  if(r.status!==0)throw Error('Database: '+databaseMessage(r.stderr||r.stdout));
  // The result is the last thing printed; json_agg may spread it over several lines.
  const lines=r.stdout.trim().split(/\r?\n/);
  for(let i=lines.length-1;i>=0;i--){try{return JSON.parse(lines.slice(i).join('\n'));}catch{}}
  return null;
 };
}
// The linked project, through the Supabase CLI's own login (the Management API runs it as postgres).
function linkedRunner(){
 return async sql=>{
  const file=path.join(tmpdir(),`repready-reset-${randomUUID()}.sql`);
  await writeFile(file,sql);
  try{
   const r=spawnSync(`supabase db query --linked --output-format json -f "${file}"`,{encoding:'utf8',shell:true,maxBuffer:1<<30});
   const out=r.stdout||'';let parsed=null;
   try{parsed=JSON.parse(out.slice(out.indexOf('{')));}catch{}
   if(!parsed||parsed._tag==='Error'||r.status!==0)throw Error('Database: '+databaseMessage(parsed?.error?.message||r.stderr||out));
   let value=parsed.rows?.[0]?.result;
   if(typeof value==='string'){try{value=JSON.parse(value);}catch{}}
   return value??null;
  }finally{await rm(file,{force:true});}
 };
}
async function connect(local){
 if(local){
  const url=process.env.SUPABASE_URL||'';
  if(!['localhost','127.0.0.1'].includes(url?new URL(url).hostname:''))throw Error('--local needs SUPABASE_URL to point at the local stack.');
  return {label:'local stack',runSql:localRunner(),storage:createClient(url,process.env.SUPABASE_SECRET_KEY||'',{auth:{persistSession:false,autoRefreshToken:false}}).storage};
 }
 const ref=(await readFile('supabase/.temp/project-ref','utf8').catch(()=>'')).trim();
 if(!/^[a-z0-9]{20}$/.test(ref))throw Error('No linked Supabase project. Run `supabase link` first, or use --local.');
 // The server key goes straight from the CLI into this process; it is never printed or saved.
 const keys=spawnSync(`supabase projects api-keys --project-ref ${ref} --reveal -o json`,{encoding:'utf8',shell:true,maxBuffer:1<<20});
 let list=[];try{const out=keys.stdout||'';list=JSON.parse(out.slice(out.search(/[[{]/)));}catch{}
 const key=(list.find?.(k=>k.type==='secret')||list.find?.(k=>k.name==='service_role'))?.api_key;
 if(!key)throw Error('The Supabase CLI could not provide the project\'s server key (is it logged in?).');
 return {label:`linked project ${ref}`,runSql:linkedRunner(),storage:createClient(`https://${ref}.supabase.co`,key,{auth:{persistSession:false,autoRefreshToken:false}}).storage};
}

// What must not change: plans, settings, the kept logs and every staff or administrator account.
const FINGERPRINT=`json_build_object(
 'plans',(select md5(coalesce(json_agg(p order by p.workspace,p.id)::text,'')) from public.ff_plans p),
 'settings',(select md5(coalesce(json_agg(s order by s.workspace)::text,'')) from public.ff_settings s),
 'staffAudit',(select count(*) from public.ff_staff_audit),
 'cleanupLog',(select count(*) from public.ff_account_cleanup_log),
 'paymongoAttempts',(select count(*) from public.ff_paymongo_attempts),
 'staff',(select coalesce(json_agg(json_build_object('email',p.email,'role',p.role,'enabled',p.enabled,'authUser',exists(select 1 from auth.users u where u.id=p.id),
   'banned',exists(select 1 from auth.users u where u.id=p.id and u.banned_until>now())) order by p.role,p.email),'[]'::json)
   from public.ff_profiles p where p.workspace='${WORKSPACE}' and p.role in ('admin','staff')))`;
const REMAINING=`json_build_object(
 'members',(select count(*) from public.ff_profiles where workspace='${WORKSPACE}' and role='member'),
 'ff_checkins',(select count(*) from public.ff_checkins where workspace='${WORKSPACE}'),
 'ff_payments',(select count(*) from public.ff_payments where workspace='${WORKSPACE}'),
 'ff_submissions',(select count(*) from public.ff_submissions where workspace='${WORKSPACE}'),
 'ff_checkouts',(select count(*) from public.ff_checkouts where workspace='${WORKSPACE}'),
 'ff_invoices',(select count(*) from public.ff_invoices where workspace='${WORKSPACE}'),
 'ff_memberships',(select count(*) from public.ff_memberships where workspace='${WORKSPACE}'),
 'ff_registrations',(select count(*) from public.ff_registrations where workspace='${WORKSPACE}'),
 'memberNotifications',(select count(*) from public.ff_notifications n where n.workspace='${WORKSPACE}' and (n.member_id is null or n.member_id not in (select id from public.ff_profiles where role in ('admin','staff')))),
 'kept',${FINGERPRINT})`;

async function listFolder(storage,prefix){
 const found=[];
 const {data,error}=await storage.from(BUCKET).list(prefix,{limit:1000});
 if(error)throw Error(`Storage list ${prefix}: ${error.message}`);
 for(const entry of data||[]){
  if(entry.id===null)found.push(...await listFolder(storage,`${prefix}/${entry.name}`));
  else found.push(`${prefix}/${entry.name}`);
 }
 return found;
}

const log=(...parts)=>console.log(...parts);
async function main(){
 const args=parseArgs(process.argv.slice(2));
 const {preview,remove}=sqlParts(await readFile(SQL_FILE,'utf8'));
 const target=await connect(args.local);
 const {runSql,storage}=target;
 log(`RepReady test-data reset: ${args.dryRun?'DRY RUN (nothing is deleted, expired or removed)':'REAL RUN'} on the ${target.label}, workspace ${WORKSPACE}.`);

 // 1. Preview.
 const rows=await runSql(`begin; set transaction read only; select coalesce(json_agg(p),'[]'::json) as result from (${preview}) p; rollback;`)||[];
 log('\n1. Preview');
 for(const r of rows)log(`   ${r.section.padEnd(32)} ${String(r.item).padEnd(44)} ${r.detail}`);
 const facts=await runSql(`begin; set transaction read only; select json_build_object(
  'members',(select coalesce(json_agg(id),'[]'::json) from public.ff_profiles where workspace='${WORKSPACE}' and role='member'),
  'paths',(select coalesce(json_agg(x),'[]'::json) from (select photo x from public.ff_profiles where workspace='${WORKSPACE}' and role='member' and coalesce(photo,'')<>''
    union select receipt from public.ff_submissions where workspace='${WORKSPACE}' and coalesce(receipt,'')<>'') f),
  'keptPhotos',(select coalesce(json_agg(photo),'[]'::json) from public.ff_profiles where role in ('admin','staff') and coalesce(photo,'')<>''),
  'open',(select coalesce(json_agg(json_build_object('id',c.id,'status',c.status,'session_id',c.session_id,'review_details',c.review_details,'amount_cents',c.amount_cents) order by c.created_at),'[]'::json)
    from public.ff_checkouts c where c.workspace='${WORKSPACE}' and c.status in ('creating','pending','needs_review')),
  'kept',${FINGERPRINT}) as result; rollback;`);

 // 2. Backup: every public ff_ table, and the members' Auth users (id, email, created_at only).
 const tables=(await runSql(`select coalesce(json_agg(table_name order by table_name),'[]'::json) as result from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' and table_name like 'ff\\_%'`)||[]).filter(t=>/^ff_[a-z_]+$/.test(t));
 const dump=await runSql(`begin; set transaction isolation level repeatable read, read only; select json_build_object(
  'tables',json_build_object(${tables.map(t=>`'${t}',(select coalesce(json_agg(x),'[]'::json) from public.${t} x)`).join(',')}),
  'auth_users_members',(select coalesce(json_agg(json_build_object('id',u.id,'email',u.email,'created_at',u.created_at) order by u.created_at),'[]'::json)
    from auth.users u where u.id in (select id from public.ff_profiles where workspace='${WORKSPACE}' and role='member'))) as result; rollback;`);
 const listed=[];
 for(const id of facts.members)listed.push(...await listFolder(storage,`${WORKSPACE}/${id}`));
 const files=memberFiles({paths:[...facts.paths,...listed],kept:facts.keptPhotos});
 const payments=await listFolder(storage,`${WORKSPACE}/payments`);
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
 const file=path.resolve('.local/backups',`reset-test-data-${args.local?'local':'linked'}-${stamp}${args.dryRun?'-dry-run':''}.json`);
 await mkdir(path.dirname(file),{recursive:true});
 await writeFile(file,JSON.stringify({createdAt:new Date().toISOString(),target:target.label,workspace:WORKSPACE,dryRun:args.dryRun,
  note:'RepReady test-data reset backup. Contains member emails and test payment records; keep it private.',...dump,memberStorageFiles:files},null,1),{mode:0o600});
 if(process.platform==='win32')spawnSync('icacls',[file,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{encoding:'utf8'});
 log(`\n2. Backup: ${path.relative(process.cwd(),file)} (${((await stat(file)).size/1024).toFixed(1)} KB)`);
 log('   '+Object.entries(dump.tables).map(([t,r])=>`${t} ${r.length}`).join(', ')+`, member Auth users ${dump.auth_users_members.length}`);
 log(`   Member storage files to remove: ${files.length}. Payment QR images kept: ${payments.length}.`);

 // 3. PayMongo, test mode only.
 const paymongo=await closeCheckouts(facts.open,{key:process.env.PAYMONGO_SECRET_KEY,dryRun:args.dryRun});
 log(`\n3. PayMongo: ${facts.open.length} open checkout(s).`+(facts.open.length?` Expired now: ${paymongo.expired.length}. Already expired: ${paymongo.alreadyExpired.length}. Paid (listed, not recorded): ${paymongo.paid.length}.`+(args.dryRun?` Would expire: ${paymongo.wouldExpire.length}.`:''):''));
 for(const p of paymongo.paid)log(`   Paid at PayMongo, not recorded: checkout ${p.id} · PHP ${p.amount.toFixed(2)} · ${p.method} · ${p.paidAt}`);

 // 4. The delete: PART 2 in one transaction (rolled back in a dry run).
 const result=await runSql(`begin;\n${deleteSql(remove,paymongo.closed)}\nselect json_build_object('deleted',(select json_agg(json_build_object('table',table_name,'rows',rows_deleted) order by position) from reset_deleted),'after',${REMAINING}) as result;\n${args.dryRun?'rollback':'commit'};`);
 log(`\n4. Delete (${args.dryRun?'rolled back':'committed'}): `+result.deleted.map(d=>`${d.table} ${d.rows}`).join(', '));

 // 5. Storage: after the commit only, so a failed delete never loses files.
 let removed=0;
 if(!args.dryRun&&files.length){
  for(let i=0;i<files.length;i+=100){
   const {data,error}=await storage.from(BUCKET).remove(files.slice(i,i+100));
   if(error)throw Error(`The database is reset, but removing member files failed: ${error.message}. Run it again to retry the files.`);
   removed+=data?.length||0;
  }
 }
 const leftover=args.dryRun?[]:memberFiles({paths:(await Promise.all(facts.members.map(id=>listFolder(storage,`${WORKSPACE}/${id}`)))).flat()});
 const paymentsAfter=args.dryRun?payments:await listFolder(storage,`${WORKSPACE}/payments`);
 log(`\n5. Storage: ${args.dryRun?`would remove ${files.length} member file(s)`:`removed ${removed} member file(s); ${leftover.length} left in member folders`}; payment QR images ${paymentsAfter.length} (before ${payments.length}).`);

 // 6. Verify.
 const after=args.dryRun?result.after:await runSql(`select ${REMAINING} as result`);
 const problems=[];
 for(const [k,v] of Object.entries(after))if(k!=='kept'&&v!==0)problems.push(`${k} ${v}`);
 // Kept accounts must be exactly as before (an account disabled before the reset stays disabled).
 if(JSON.stringify(after.kept)!==JSON.stringify(facts.kept))problems.push('plans, settings, kept logs or staff accounts changed');
 if(after.kept.staff.some(s=>!s.authUser))problems.push('a staff or administrator account is missing its Auth user');
 if(!after.kept.staff.some(s=>s.role==='admin'&&s.enabled&&!s.banned))problems.push('no enabled administrator is left');
 if(!args.dryRun&&(leftover.length||paymentsAfter.length!==payments.length))problems.push('storage clean-up incomplete');
 const staffLine=after.kept.staff.map(s=>`${s.role} ${s.email} (${s.enabled&&!s.banned?'enabled':'disabled'})`).join(', ');
 log(`\n6. Verify${args.dryRun?' (inside the rolled-back transaction)':''}: `+(problems.length?'PROBLEMS: '+problems.join('; '):`0 members and 0 member rows left; plans, settings, kept logs and all ${after.kept.staff.length} staff and administrator accounts unchanged: ${staffLine}.`));
 if(problems.length)process.exitCode=1;
 log(args.dryRun?'\nDry run finished: nothing was deleted, expired or removed.':'\nReset finished.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
 main().catch(error=>{console.error('\nStopped: '+error.message);process.exitCode=1;});
