import assert from 'node:assert/strict';
import {readFile,readdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {sqlParts,deleteSql} from '../scripts/reset-test-data.js';
// RESET-001, local stack only. PART 1 and PART 2 of scripts/reset-test-data.sql run inside transactions
// that always roll back; then the whole script runs as a dry run. Local data is unchanged afterwards.
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
const psql=sql=>spawnSync('docker',['exec','-i','supabase_db_RepReady','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-At'],{input:sql,encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}});
const pass=label=>console.log('PASS: '+label);
const {preview,remove}=sqlParts(await readFile('scripts/reset-test-data.sql','utf8'));
const counts=()=>psql(`select json_build_object(${['ff_profiles','ff_payments','ff_invoices','ff_memberships','ff_checkouts','ff_checkins','ff_submissions','ff_notifications','ff_registrations','ff_plans','ff_settings','ff_staff_audit','ff_account_cleanup_log']
 .map(t=>`'${t}',(select count(*) from public.${t})`).join(',')},'auth.users',(select count(*) from auth.users));`).stdout.trim();
const before=counts();
const helpers=`create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$ begin if value is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
set constraints auth.ff_auth_user_created immediate;
select set_config('rt.member',gen_random_uuid()::text,true),set_config('rt.staff',(select id::text from public.ff_profiles where workspace='production' and role='staff' and enabled order by created_at limit 1),true);`;
// A member with one of everything, a first registration with an open checkout, and three notifications.
const fixtures=`${helpers}
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(current_setting('rt.member')::uuid,'reset-fixture-'||left(current_setting('rt.member'),8)||'@example.invalid',
 '{"ff_workspace":"production","ff_role":"member"}',jsonb_build_object('form_fitness',true,'name','LOCAL TEST Reset','phone','09170000090','plan','basic','start',ff_private.today()));
insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference_key,idempotency_key,payment_date,recorded_by)
 select 'production',member_id,id,100,'Cash','CASH:'||gen_random_uuid(),gen_random_uuid(),ff_private.today(),current_setting('rt.staff')::uuid from public.ff_invoices where member_id=current_setting('rt.member')::uuid;
insert into public.ff_submissions(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key)
 select 'production',member_id,id,100,'GCash','RT'||left(replace(current_setting('rt.member'),'-',''),10),'GCash:RT'||left(replace(current_setting('rt.member'),'-',''),10) from public.ff_invoices where member_id=current_setting('rt.member')::uuid;
insert into public.ff_checkins(workspace,member_id,membership_id,nonce,confirmed_by) select 'production',member_id,id,gen_random_uuid(),current_setting('rt.staff')::uuid from public.ff_memberships where member_id=current_setting('rt.member')::uuid;
insert into public.ff_checkouts(id,workspace,created_by,member_id,invoice_id,amount_cents,methods,livemode,status,session_id)
 select gen_random_uuid(),'production',member_id,member_id,id,amount_cents,array['gcash'],false,'expired','cs_ResetExpired'||left(replace(current_setting('rt.member'),'-',''),8) from public.ff_invoices where member_id=current_setting('rt.member')::uuid;
insert into public.ff_registrations(workspace,request_id,name,email,phone,plan_id,plan_name,features,days,start_date,end_date,amount_cents,created_by,status,member_id,paid_by,paid_at,payment_request)
 values('production',gen_random_uuid(),'LOCAL TEST Reset','reset-fixture-paid-'||left(current_setting('rt.member'),8)||'@example.invalid','09170000090','basic','Essential','[]',30,ff_private.today(),ff_private.today()+29,89900,
  current_setting('rt.staff')::uuid,'provisioned',current_setting('rt.member')::uuid,current_setting('rt.staff')::uuid,now(),gen_random_uuid());
with r as (insert into public.ff_registrations(workspace,request_id,name,email,phone,plan_id,plan_name,features,days,start_date,end_date,amount_cents,created_by)
 values('production',gen_random_uuid(),'LOCAL TEST Reset','reset-fixture-open-'||left(current_setting('rt.member'),8)||'@example.invalid','09170000090','basic','Essential','[]',30,ff_private.today(),ff_private.today()+29,89900,current_setting('rt.staff')::uuid) returning id)
insert into public.ff_checkouts(id,workspace,created_by,registration_id,amount_cents,methods,livemode,status,session_id) select gen_random_uuid(),'production',current_setting('rt.staff')::uuid,r.id,89900,array['gcash'],false,'needs_review','cs_ResetOpen'||left(replace(current_setting('rt.member'),'-',''),8) from r;
insert into public.ff_notifications(workspace,member_id,recipient,subject,body,event_key,status) values
 ('production',current_setting('rt.member')::uuid,'member@example.invalid','s','b','rt-member-'||current_setting('rt.member'),'queued'),
 ('production',null,'detached@example.invalid','s','b','rt-detached-'||current_setting('rt.member'),'sent'),
 ('production',current_setting('rt.staff')::uuid,'staff@example.invalid','s','b','rt-staff-'||current_setting('rt.member'),'sent');
`;
const openIds=`(select coalesce(json_agg(id),'[]'::json) from public.ff_checkouts where workspace='production' and status in ('creating','pending','needs_review'))`;
// PART 2 with every open checkout listed as closed at PayMongo, the way the script runs it.
const closedPart2=`select set_config('rt.closed',${openIds}::text,true);\n`+deleteSql(remove,[]).replace(`closed constant jsonb := '[]';`,`closed constant jsonb := current_setting('rt.closed')::jsonb;`);
function refused(label,body,message){
 const r=psql(`begin;\n${body}\nrollback;\n`);
 assert.notEqual(r.status,0,`${label}: PART 2 should have refused`);assert(r.stderr.includes(message),`${label}: ${r.stderr.trim().split('\n')[0]}`);
}
try{
 const shown=psql(`begin; set transaction read only;\n${preview};\nrollback;`);
 assert.equal(shown.status,0,shown.stderr);
 for(const line of ['Will delete|ff_profiles (members)|','Will delete|auth.users (members)|','Will delete|ff_payments|','Stays: admin|repready-local-admin@example.invalid|enabled','Stays: staff|','Keeps|ff_plans|','Keeps|ff_account_cleanup_log|'])
  assert(shown.stdout.includes(line),line);
 pass('PART 1 runs in a read-only transaction and lists what goes, who stays and what is kept');

 refused('no confirmation',`${fixtures}\n${remove}`,'type DELETE ALL MEMBERS in the confirm line of PART 2 first');
 refused('open checkout',`${fixtures}\n${deleteSql(remove,[])}`,'an online checkout is still open');
 refused('not production',`${fixtures}\n${closedPart2.replace("ws constant text := 'production';","ws constant text := 'demo';")}`,'this reset only clears the production workspace');
 refused('no administrator',`${fixtures}\nupdate public.ff_profiles set enabled=false where workspace='production' and role='admin';\n${closedPart2}`,'there is no enabled administrator in the production workspace');
 refused('member in the staff audit log',`${fixtures}\ninsert into public.ff_staff_audit(workspace,actor_id,target_id,action) select 'production',id,current_setting('rt.member')::uuid,'update' from public.ff_profiles where workspace='production' and role='admin' limit 1;\n${closedPart2}`,'a member account appears in the staff audit log');
 pass('PART 2 refuses without the typed confirmation, with an open checkout, outside production, without an enabled administrator, and when a member is in the kept audit log');

 const kept=`json_build_object('plans',(select md5(json_agg(p order by p.workspace,p.id)::text) from public.ff_plans p),'settings',(select md5(json_agg(s order by s.workspace)::text) from public.ff_settings s),
  'staff',(select json_agg(json_build_object('id',id,'enabled',enabled) order by id) from public.ff_profiles where role in ('admin','staff')),
  'staffAuth',(select count(*) from auth.users where id in (select id from public.ff_profiles where role in ('admin','staff'))),
  'audit',(select count(*) from public.ff_staff_audit),'cleanupLog',(select count(*) from public.ff_account_cleanup_log),'attempts',(select count(*) from public.ff_paymongo_attempts),
  'demo',(select json_build_object(${['ff_profiles','ff_payments','ff_invoices','ff_memberships','ff_checkouts','ff_checkins','ff_submissions','ff_notifications','ff_registrations'].map(t=>`'${t}',(select count(*) from public.${t} where workspace='demo')`).join(',')})))::text`;
 const success=psql(`begin;
${fixtures}
select set_config('rt.kept',${kept},true);
${closedPart2}
select pg_temp.ok((select count(*) from public.ff_profiles where workspace='production' and role='member')=0,'No production member is left');
select pg_temp.ok(not exists(select 1 from auth.users where id=current_setting('rt.member')::uuid),'The member Auth user is gone');
select pg_temp.ok(${['ff_payments','ff_invoices','ff_memberships','ff_checkouts','ff_checkins','ff_submissions','ff_registrations'].map(t=>`(select count(*) from public.${t} where workspace='production')=0`).join(' and ')},'No production payment, invoice, cycle, checkout, check-in, submission or registration is left');
select pg_temp.ok(exists(select 1 from public.ff_notifications where event_key='rt-staff-'||current_setting('rt.member')),'A staff member''s notification stays');
select pg_temp.ok(not exists(select 1 from public.ff_notifications where event_key in ('rt-member-'||current_setting('rt.member'),'rt-detached-'||current_setting('rt.member'))),'Member notifications, detached ones included, are gone');
select pg_temp.ok(current_setting('rt.kept')=${kept},'Plans, settings, staff and administrator accounts and their Auth users, the kept logs and the demo workspace are unchanged');
select pg_temp.ok((select min(rows_deleted) from reset_deleted where table_name in ('ff_checkins','ff_payments','ff_submissions','ff_invoices','ff_memberships','ff_profiles (members)','auth.users (members)'))>=1
 and (select rows_deleted from reset_deleted where table_name='ff_checkouts')>=2 and (select rows_deleted from reset_deleted where table_name='ff_registrations')>=2,'The deleted rows are reported per table');
select 'success';
rollback;`);
 assert.equal(success.status,0,success.stderr.trim().split('\n')[0]);assert(success.stdout.includes('success'));
 pass('PART 2 deletes every production member, Auth user and member record in foreign-key order, and keeps staff, plans, settings, the logs and the demo workspace (rolled back)');

 const blocked=spawnSync(process.execPath,['--env-file-if-exists=.env.local','scripts/reset-test-data.js','--local'],{encoding:'utf8'});
 assert.equal(blocked.status,1);assert.match(blocked.stderr,/add --confirm "DELETE ALL MEMBERS" exactly/);
 const started=Date.now();
 const dry=spawnSync(process.execPath,['--env-file-if-exists=.env.local','scripts/reset-test-data.js','--local','--dry-run'],{encoding:'utf8',maxBuffer:1<<26});
 assert.equal(dry.status,0,dry.stderr||dry.stdout);
 for(const text of ['DRY RUN','1. Preview','2. Backup: .local','3. PayMongo:','4. Delete (rolled back)','6. Verify (inside the rolled-back transaction): 0 members and 0 member rows left; plans, settings, kept logs and all','Dry run finished'])assert(dry.stdout.includes(text),text);
 assert.equal(counts(),before,'the dry run changed nothing');
 const backups=(await readdir('.local/backups')).filter(f=>/^reset-test-data-local-.*-dry-run\.json$/.test(f));
 for(const f of backups){const when=Date.parse(f.replace(/^reset-test-data-local-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z.*$/,'$1-$2-$3T$4:$5:$6Z'));if(when>=started-2000)await rm('.local/backups/'+f);}
 pass('The script refuses without the confirmation, and its local dry run backs up, reads PayMongo, rolls the delete back and changes nothing');
}finally{
 assert.equal(counts(),before,'local data unchanged');
}
