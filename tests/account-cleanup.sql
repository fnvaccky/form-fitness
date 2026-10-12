-- Task 10: account-first accounts and the clean-up of never-paid member accounts. Local fixtures only;
-- everything, including Auth rows, rolls back.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table ac_log(label text);
grant select,insert on ac_log to authenticated,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into ac_log values(label); end $$;
create function pg_temp.fails(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.fails_with(statement text,expected text,label text) returns void language plpgsql as $$
declare msg text:='(no error raised)';
begin begin execute statement; exception when others then msg:=sqlerrm; end; perform pg_temp.ok(position(expected in msg)=1,label||' ['||msg||']'); end $$;
create function pg_temp.refused(statement text,expected text,label text) returns void language plpgsql as $$
declare state text:='';msg text:='(no error raised)';
begin begin execute statement; exception when others then state:=sqlstate;msg:=sqlerrm; end; perform pg_temp.ok(state='42501' and msg=expected,label||' ['||state||' '||msg||']'); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare state text:='';
begin begin execute statement; exception when others then state:=sqlstate; end; perform pg_temp.ok(state='42501',label); end $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ac.ids')::jsonb->>k,'role','authenticated','session_id',current_setting('ac.ids')::jsonb->>(k||'Session'))::text,true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('ac.ids')::jsonb->>k)::uuid $$;
select set_config('ac.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['admin','adminSession','staff','staffSession','noplan','noplanSession','unpaid','paid','pending','open','old','young','prod','again','xpay','xinvoice','xcheckin','xaudit','xcheckout']) k)::text,true);
-- Accounts: an administrator and staff, and members made the account-first way (no plan) or with a plan.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'ac-'||k||'@example.invalid',jsonb_build_object('ff_workspace',case when k='prod' then 'production' else 'demo' end,'ff_role',case when k in ('admin','staff') then k else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST '||k,'phone','09170000050')||case when k in ('unpaid','paid','pending') or k like 'x%' then jsonb_build_object('plan','basic','start',ff_private.today()) else '{}'::jsonb end
from unnest(array['admin','staff','noplan','unpaid','paid','pending','open','old','young','prod','xpay','xinvoice','xcheckin','xaudit','xcheckout']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['admin','staff','noplan']) k;
select pg_temp.ok((select count(*)=1 from public.ff_profiles where id=pg_temp.id('noplan') and role='member') and not exists(select 1 from public.ff_memberships where member_id=pg_temp.id('noplan')) and not exists(select 1 from public.ff_invoices where member_id=pg_temp.id('noplan')),'An account-first member starts with a profile and no plan, cycle or invoice');
select pg_temp.ok((select count(*)=1 from public.ff_invoices where member_id=pg_temp.id('unpaid') and paid_cents=0),'A member created with a plan still gets an unpaid cycle and invoice');

-- No pass and no check-in until a fully paid cycle covers today.
select pg_temp.as_user('noplan');
set local role authenticated;
select pg_temp.fails($q$select public.ff_command('qr','{}')$q$,'A member with no plan gets no member pass');
select public.ff_command('renew',jsonb_build_object('plan','basic','start',(now() at time zone 'Asia/Manila')::date));
select pg_temp.ok((select count(*)=1 from public.ff_invoices where paid_cents=0),'The member chooses a plan: an unpaid cycle and invoice');
select pg_temp.fails($q$select public.ff_command('qr','{}')$q$,'An unpaid plan gives no member pass');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',(select id from public.ff_invoices where member_id=pg_temp.id('noplan')),'amountCents',(select amount_cents from public.ff_invoices where member_id=pg_temp.id('noplan')),'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true));
reset role;
select pg_temp.as_user('noplan');
set local role authenticated;
select pg_temp.ok(public.ff_command('qr','{}')->>'token' like 'FORM2.%','Cash recorded by staff activates the plan: the member gets a pass');
reset role;
-- A validly signed pass gets nobody in without that paid cycle: scan and check-in check it again. The
-- passes are signed here, as the owner, because only the database holds the key.
create function pg_temp.pass(k text) returns text language sql as $$
 select 'FORM2.'||p||'.'||encode(extensions.hmac(p,(select value from ff_private.secrets where name='qr'),'sha256'),'hex')
 from (select replace(encode(convert_to(jsonb_build_object('memberId',pg_temp.id(k),'workspace','demo','exp',extract(epoch from now())::bigint+60,'nonce',gen_random_uuid())::text,'UTF8'),'base64'),E'\n','') p) t $$;
select set_config('ac.unpaidPass',pg_temp.pass('unpaid'),true),set_config('ac.paidPass',pg_temp.pass('noplan'),true);
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((public.ff_command('scan',jsonb_build_object('token',current_setting('ac.paidPass')))->'member'->>'id')=pg_temp.id('noplan')::text,'Control: a pass signed this way scans for the member whose paid cycle covers today');
select pg_temp.fails_with($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ac.unpaidPass')))$q$,'Check-in denied','A signed pass for a member with an unpaid plan does not scan');
select pg_temp.fails_with($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ac.unpaidPass'),'confirmed',true))$q$,'Check-in denied','A member with an unpaid plan cannot be checked in');
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_checkins where member_id=pg_temp.id('unpaid')),'No check-in row for the unpaid member');

-- Gym staff create member accounts; the database checks the role and the email first.
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok(public.ff_member_admin('prepare-create',jsonb_build_object('email',' AC-New@Example.invalid '))->>'email'='ac-new@example.invalid','Staff may create a member account; the email is normalised');
select pg_temp.fails($q$select public.ff_member_admin('prepare-create',jsonb_build_object('email','AC-UNPAID@example.invalid'))$q$,'An email already in use is refused');
select pg_temp.denied($q$select public.ff_account_cleanup('list','{}')$q$,'Staff cannot list or clean up unpaid accounts');
select pg_temp.denied($q$select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'unpaid'))$q$,'Staff cannot force a clean-up');
reset role;
select pg_temp.as_user('noplan');
set local role authenticated;
select pg_temp.refused($q$select public.ff_member_admin('prepare-create',jsonb_build_object('email','ac-other@example.invalid'))$q$,'Gym staff access is required.','A signed-in member cannot create accounts');
reset role;

-- Set up the cases: one paid (cash), one with a payment submission waiting, one with an open online checkout.
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',(select id from public.ff_invoices where member_id=pg_temp.id('paid')),'amountCents',100,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true));
reset role;
insert into public.ff_submissions(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key)
select 'demo',i.member_id,i.id,i.amount_cents,'GCash','AC-PENDING-1','GCash:ACPENDING1' from public.ff_invoices i where i.member_id=pg_temp.id('pending');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',current_setting('ac.ids')::jsonb->>'open','plan','basic','start',(now() at time zone 'Asia/Manila')::date));
reset role;
insert into public.ff_checkouts(id,workspace,created_by,member_id,invoice_id,amount_cents,methods,livemode,status,review_reason,review_details)
select gen_random_uuid(),'demo',pg_temp.id('open'),i.member_id,i.id,i.amount_cents,array['gcash'],false,'needs_review','checkout_reference_mismatch',jsonb_build_object('category','checkout_reference_mismatch','sessionId','cs_AccountOpen')
from public.ff_invoices i where i.member_id=pg_temp.id('open');
update public.ff_notifications set status='sent' where member_id=pg_temp.id('open');
-- Each x account gets exactly one record that must never be deleted, written directly so no other rule applies.
insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference_key,idempotency_key,payment_date,recorded_by)
 select 'demo',i.member_id,i.id,100,'Cash','CASH:'||gen_random_uuid(),gen_random_uuid(),ff_private.today(),pg_temp.id('admin') from public.ff_invoices i where i.member_id=pg_temp.id('xpay');
update public.ff_invoices set paid_cents=100 where member_id=pg_temp.id('xinvoice');
insert into public.ff_checkins(workspace,member_id,membership_id,nonce,confirmed_by) select 'demo',m.member_id,m.id,gen_random_uuid(),pg_temp.id('staff') from public.ff_memberships m where m.member_id=pg_temp.id('xcheckin');
insert into public.ff_staff_audit(workspace,actor_id,target_id,action) values('demo',pg_temp.id('admin'),pg_temp.id('xaudit'),'update');
insert into public.ff_checkouts(id,workspace,created_by,member_id,invoice_id,amount_cents,methods,livemode,status,session_id,payment_id,paid_at)
 select gen_random_uuid(),'demo',i.member_id,i.member_id,i.id,i.amount_cents,array['gcash'],false,'paid','cs_AccountPaid','pay_AccountPaid',now() from public.ff_invoices i where i.member_id=pg_temp.id('xcheckout');

-- Administrators: the list shows only never-paid member accounts.
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select array_agg(x->>'name' order by x->>'name') from jsonb_array_elements(public.ff_account_cleanup('list','{}')) x where x->>'name' like 'LOCAL TEST %')
 =array['LOCAL TEST old','LOCAL TEST open','LOCAL TEST unpaid','LOCAL TEST young'],'The list shows never-paid members only: not paid, not waiting for review, never staff or admin');
select pg_temp.ok((select x->'openCheckouts'->0->>'sessionId'='cs_AccountOpen' from jsonb_array_elements(public.ff_account_cleanup('list','{}')) x where x->>'id'=current_setting('ac.ids')::jsonb->>'open'),'The list names each open online checkout and its PayMongo session');
-- Refusals: 42501 with a clear message.
create function pg_temp.del(k text) returns text language sql as $$ select format('select public.ff_account_cleanup(%L,jsonb_build_object(%L,%L))','delete','id',pg_temp.id(k)) $$;
select pg_temp.refused(pg_temp.del('noplan'),'Only never-paid member accounts can be deleted. This one has a payment on record, so it can only be disabled.','A member who paid (cash) can only be disabled');
select pg_temp.refused(pg_temp.del('paid'),'Only never-paid member accounts can be deleted. This one has a payment on record, so it can only be disabled.','A partly paid member can only be disabled');
select pg_temp.refused(pg_temp.del('pending'),'Only never-paid member accounts can be deleted. This one has a payment submission waiting for review.','A member with a submission waiting for review cannot be deleted');
select pg_temp.refused(pg_temp.del('staff'),'Only never-paid member accounts can be deleted. Staff and administrator accounts can only be disabled.','A staff account can only be disabled');
select pg_temp.refused(pg_temp.del('admin'),'Only never-paid member accounts can be deleted. Staff and administrator accounts can only be disabled.','An administrator account can only be disabled');
-- Each record that is never deleted refuses the delete on its own.
select pg_temp.refused(pg_temp.del('xpay'),'Only never-paid member accounts can be deleted. This one has a payment on record, so it can only be disabled.','A payment on record refuses the delete by itself');
select pg_temp.refused(pg_temp.del('xinvoice'),'Only never-paid member accounts can be deleted. This one has a paid or partly paid invoice, so it can only be disabled.','A paid or partly paid invoice refuses the delete by itself');
select pg_temp.refused(pg_temp.del('xcheckin'),'Only never-paid member accounts can be deleted. This one has check-ins on record, so it can only be disabled.','A check-in refuses the delete by itself');
select pg_temp.refused(pg_temp.del('xaudit'),'Only never-paid member accounts can be deleted. This one appears in the staff audit log.','A staff audit entry refuses the delete by itself');
select pg_temp.refused(pg_temp.del('xcheckout'),'Only never-paid member accounts can be deleted. This one has a paid online checkout, so it can only be disabled.','A paid online checkout refuses the delete by itself');
select pg_temp.fails($q$select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'prod'))$q$,'Another workspace''s account is not found');
reset role;
select pg_temp.ok((select count(*) from public.ff_payments where member_id in (pg_temp.id('xpay'),pg_temp.id('paid'),pg_temp.id('noplan')))=3 and exists(select 1 from public.ff_invoices where member_id=pg_temp.id('xinvoice') and paid_cents=100)
 and exists(select 1 from public.ff_checkins where member_id=pg_temp.id('xcheckin')) and exists(select 1 from public.ff_staff_audit where target_id=pg_temp.id('xaudit')) and exists(select 1 from public.ff_checkouts where session_id='cs_AccountPaid' and member_id=pg_temp.id('xcheckout')),'Refused deletes leave payments, paid invoices, check-ins, the staff audit log and paid checkouts untouched');
select pg_temp.as_user('admin');
set local role authenticated;
-- An open checkout must be closed first; only its own PayMongo session counts.
select pg_temp.fails($q$select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'open'))$q$,'An account with an open online checkout is refused until PayMongo confirms it closed');
select pg_temp.fails($q$select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'open','expired',jsonb_build_array(jsonb_build_object('id',(select id from public.ff_checkouts where member_id=(current_setting('ac.ids')::jsonb->>'open')::uuid),'sessionId','cs_SomethingElse','providerStatus',200,'via','expire'))))$q$,'A confirmation for another session is refused');
create function pg_temp.expire_open(status jsonb,via text) returns text language sql as $$ select format('select public.ff_account_cleanup(%L,%L::jsonb)','delete',jsonb_build_object('id',pg_temp.id('open'),'expired',jsonb_build_array(jsonb_build_object('id',(select id from public.ff_checkouts where member_id=pg_temp.id('open')),'sessionId','cs_AccountOpen','providerStatus',status,'via',via)))) $$;
select pg_temp.fails_with(pg_temp.expire_open('"200"','expire'),'PayMongo confirmation is incomplete.','A PayMongo status that is not a number is refused');
select pg_temp.fails_with(pg_temp.expire_open('200','manual'),'PayMongo confirmation is incomplete.','Only PayMongo''s own expiry counts as closed');
select pg_temp.fails_with(pg_temp.expire_open('200',null),'PayMongo confirmation is incomplete.','A confirmation that does not say how it closed is refused');
select pg_temp.ok((select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'open','expired',jsonb_build_array(jsonb_build_object('id',(select id from public.ff_checkouts where member_id=(current_setting('ac.ids')::jsonb->>'open')::uuid),'sessionId','cs_AccountOpen','providerStatus',200,'via','expire'))))->>'deleted')=current_setting('ac.ids')::jsonb->>'open','With PayMongo''s confirmation the account is deleted');
reset role;
select pg_temp.ok(not exists(select 1 from auth.users where id=pg_temp.id('open')) and not exists(select 1 from public.ff_profiles where id=pg_temp.id('open'))
 and not exists(select 1 from public.ff_invoices where member_id=pg_temp.id('open')) and not exists(select 1 from public.ff_memberships where member_id=pg_temp.id('open')),'Deleted: the Auth user, the profile, the unpaid cycle and invoice');
select pg_temp.ok((select status='expired' and member_id is null and invoice_id is null and created_by is null and detached_at is not null and session_id='cs_AccountOpen'
 and review_log->-2->>'action'='cancel' and review_log->-1->>'action'='detach' from public.ff_checkouts where review_details->>'sessionId'='cs_AccountOpen'),'The closed checkout is kept as history, detached from the account');
select pg_temp.ok((select count(*)>0 and bool_and(member_id is null) from public.ff_notifications where recipient='ac-open@example.invalid'),'Sent notifications stay as the delivery record, detached');
select pg_temp.ok((select actor='admin' and deleted_by=pg_temp.id('admin') and email_hash=encode(extensions.digest('ac-open@example.invalid','sha256'),'hex') and age_days=0
 and (details->>'checkoutsExpired')::int=1 and (details->>'invoices')::int=1 from public.ff_account_cleanup_log where account_id=pg_temp.id('open')),'The log row: who, when, account, email hash (never the email), age and what went');
select pg_temp.ok(not exists(select 1 from public.ff_account_cleanup_log where details::text like '%@%' or reason like '%@%'),'No plain email in the log');
-- The email is free again.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('again'),'ac-open@example.invalid','{"ff_workspace":"demo","ff_role":"member"}','{"form_fitness":true,"name":"LOCAL TEST again","phone":"09170000051"}');
select pg_temp.ok(exists(select 1 from public.ff_profiles where id=pg_temp.id('again') and email='ac-open@example.invalid'),'After the clean-up the same email can be registered again');
-- A deleted account with unsent notifications only (unpaid plan, queued email).
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',current_setting('ac.ids')::jsonb->>'unpaid'));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_notifications where recipient='ac-unpaid@example.invalid'),'Unsent notifications are deleted with the account');

-- The daily job: never-paid accounts older than 7 days only, deleted as "automatic".
update public.ff_profiles set created_at=now()-interval '8 days' where id=pg_temp.id('old');
set local role service_role;
select pg_temp.ok((select array_agg(x->>'name') from jsonb_array_elements(public.ff_account_cleanup_auto('due',jsonb_build_object('workspace','demo'))) x where x->>'name' like 'LOCAL TEST %')=array['LOCAL TEST old'],'Only never-paid accounts older than 7 days are due');
select pg_temp.fails($q$select public.ff_account_cleanup_auto('delete',jsonb_build_object('workspace','demo','id',current_setting('ac.ids')::jsonb->>'young'))$q$,'The job refuses an account newer than 7 days');
select pg_temp.denied($q$select public.ff_account_cleanup_auto('delete',jsonb_build_object('workspace','demo','id',current_setting('ac.ids')::jsonb->>'paid'))$q$,'The job refuses an account that ever paid');
select public.ff_account_cleanup_auto('delete',jsonb_build_object('workspace','demo','id',current_setting('ac.ids')::jsonb->>'old'));
reset role;
select pg_temp.ok((select actor='automatic' and deleted_by is null and age_days=8 from public.ff_account_cleanup_log where account_id=pg_temp.id('old')),'The job''s log row says automatic, with the age');
select pg_temp.ok(exists(select 1 from public.ff_profiles where id=pg_temp.id('young')),'The newer account is still there');

-- Who can run what, and the log is append-only.
select pg_temp.ok(not has_function_privilege('anon','public.ff_account_cleanup(text,jsonb)','execute') and not has_function_privilege('anon','public.ff_account_cleanup_auto(text,jsonb)','execute') and not has_function_privilege('anon','public.ff_member_admin(text,jsonb)','execute'),'Anonymous runs none of it');
select pg_temp.ok(not has_function_privilege('authenticated','public.ff_account_cleanup_auto(text,jsonb)','execute'),'Signed-in users cannot run the daily job');
select pg_temp.ok(not has_function_privilege('service_role','public.ff_account_cleanup(text,jsonb)','execute'),'The service key cannot use the administrators'' entry point');
select pg_temp.ok(not has_function_privilege('authenticated','ff_private.delete_never_paid(uuid,text,uuid,text,text,jsonb,interval)','execute') and not has_function_privilege('service_role','ff_private.delete_never_paid(uuid,text,uuid,text,text,jsonb,interval)','execute'),'Nobody calls the delete itself directly');
select pg_temp.fails($q$update public.ff_account_cleanup_log set reason='changed'$q$,'The log cannot be changed, even by the owner');
select pg_temp.fails($q$delete from public.ff_account_cleanup_log$q$,'The log cannot be erased, even by the owner');
set local role service_role;
select pg_temp.denied($q$insert into public.ff_account_cleanup_log(workspace,account_id,email_hash,account_created_at,age_days,actor,reason) values('demo',gen_random_uuid(),repeat('0',64),now(),0,'automatic','x')$q$,'The service key cannot write the log directly');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select count(*)>=3 from public.ff_account_cleanup_log),'Administrators can read the log');
select pg_temp.denied($q$insert into public.ff_account_cleanup_log(workspace,account_id,email_hash,account_created_at,age_days,actor,reason) values('demo',gen_random_uuid(),repeat('0',64),now(),0,'automatic','x')$q$,'Administrators cannot write the log directly');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_account_cleanup_log),'Staff cannot read the log');
reset role;
select count(*) as passed_checks from ac_log;
rollback;
