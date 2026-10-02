-- Database-only fixtures, never real demo logins. All rows, settings and helpers roll back.
-- Run through the connected Supabase execute_sql tool or psql against the intended project.
-- Does not send email, copy password hashes, or modify pre-existing member records.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table ff_test_log(label text);
grant select,insert on ff_test_log to authenticated;
create function pg_temp.ok(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAILED: %',label; end if; insert into ff_test_log values(label); end $$;
create function pg_temp.must_fail(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end;
perform pg_temp.ok(failed,label); end $$;

select set_config('ff.test',jsonb_build_object('admin',gen_random_uuid(),'member',gen_random_uuid(),'other',gen_random_uuid(),'prod',gen_random_uuid(),'adminSession',gen_random_uuid(),'memberSession',gen_random_uuid(),'otherSession',gen_random_uuid())::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select (current_setting('ff.test')::jsonb->>'admin')::uuid,'ff-db-admin@example.invalid','{"ff_workspace":"demo","ff_role":"admin"}',jsonb_build_object('form_fitness',true,'name','DB TEST Admin','phone','09170000001');
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select (current_setting('ff.test')::jsonb->>k)::uuid,'ff-db-'||k||'@example.invalid',jsonb_build_object('ff_workspace',case when k='prod' then 'production' else 'demo' end),jsonb_build_object('form_fitness',true,'name','DB TEST Member','phone','09170000002','plan','basic','start',ff_private.today(),'role','admin','ff_role','admin') from unnest(array['member','other','prod']) k;
insert into auth.sessions(id,user_id)
select (current_setting('ff.test')::jsonb->>(k||'Session'))::uuid,(current_setting('ff.test')::jsonb->>k)::uuid from unnest(array['admin','member','other']) k;
select pg_temp.must_fail($q$insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'ff-bad-contact@example.invalid','{"ff_workspace":"demo"}','{"form_fitness":true,"name":"Missing Phone","plan":"basic","start":"2026-09-18"}')$q$,'Database rejects missing phone');
select pg_temp.must_fail($q$insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'ff-bad-plan@example.invalid','{"ff_workspace":"demo"}',jsonb_build_object('form_fitness',true,'name','Invalid Plan','phone','09170000003','plan','fake','start',ff_private.today()))$q$,'Database rejects nonexistent plan');
select set_config('ff.invoice',(select id::text from public.ff_invoices where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),true);
select set_config('ff.other_invoice',(select id::text from public.ff_invoices where member_id=(current_setting('ff.test')::jsonb->>'other')::uuid),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.ok((select count(*)=1 from public.ff_profiles),'Customer sees only own profile');
select pg_temp.ok((select role='member' from public.ff_profiles),'User metadata cannot assign administrator');
select pg_temp.ok((select count(*)=1 from public.ff_invoices),'Customer invoice RLS isolation');
select pg_temp.ok((select amount_cents=89900 from public.ff_invoices),'Authoritative integer plan price');
select pg_temp.ok((select count(*)=0 from public.ff_profiles where id=(current_setting('ff.test')::jsonb->>'other')::uuid),'Cross-customer profile read denied');
select pg_temp.must_fail('update public.ff_profiles set role=''admin''','Role self-assignment denied');
select pg_temp.must_fail('insert into public.ff_payments(workspace) values(''demo'')','Direct financial writes denied');
select pg_temp.must_fail($q$select public.ff_command('payments','{}')$q$,'Customer admin command denied');
select pg_temp.must_fail($q$select public.ff_command('qr','{}')$q$,'Unpaid QR issuance denied');
select pg_temp.must_fail($q$select public.ff_command('renew',jsonb_build_object('memberId',current_setting('ff.test')::jsonb->>'other','plan','basic','start','2026-11-01'))$q$,'Cross-customer renewal denied');
select pg_temp.ok((select bool_and(status='suppressed') from public.ff_notifications),'Demo notifications suppressed');
select pg_temp.must_fail('select * from ff_private.secrets','QR signing secret inaccessible');

reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.ok((select count(*)=3 from public.ff_profiles where id in (select value::uuid from jsonb_each_text(current_setting('ff.test')::jsonb) where key in ('admin','member','other','prod'))),'Demo admin cannot see production workspace');
select set_config('ff.request',gen_random_uuid()::text,true);
select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',40000,'method','Cash','idempotencyKey',current_setting('ff.request'),'verified',true));
select pg_temp.ok((select paid_cents=40000 from public.ff_invoices where id=current_setting('ff.invoice')::uuid),'Partial payment updates exact balance');
select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',40000,'method','Cash','idempotencyKey',current_setting('ff.request'),'verified',true));
select pg_temp.ok((select count(*)=1 from public.ff_payments where invoice_id=current_setting('ff.invoice')::uuid),'Repeated request is idempotent');
select pg_temp.must_fail($q$select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',60000,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true))$q$,'Overpayment rejected');
select pg_temp.must_fail($q$select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',100,'method','Cash','idempotencyKey',current_setting('ff.request'),'verified',true))$q$,'Reused idempotency key with different amount rejected');
-- A synthetic image PATH enables only transactional database tests. No payment QR is uploaded.
select public.ff_command('settings/payments','{"gcash":{"image":"demo/payments/db-test-only.png","name":"DB TEST ONLY"}}');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select set_config('ff.sub',(public.ff_command('payment-submissions',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',49900,'method','GCash','reference','DBTEST-REFERENCE-01'))->>'id'),true);
select pg_temp.ok((select paid_cents=40000 from public.ff_invoices),'Submission alone does not pay invoice');
select pg_temp.must_fail($q$select public.ff_command('payment-submissions',jsonb_build_object('invoiceId',current_setting('ff.invoice'),'amountCents',100,'method','GCash','reference','DBTEST-REFERENCE-01'))$q$,'Duplicate submitted reference rejected');
select pg_temp.must_fail($q$select public.ff_command('payment-submissions',jsonb_build_object('invoiceId',current_setting('ff.other_invoice'),'amountCents',100,'method','GCash','reference','DBTEST-OTHER'))$q$,'Cross-customer payment submission denied');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.must_fail($q$select public.ff_command('review-payment',jsonb_build_object('id',current_setting('ff.sub'),'approve',true,'verified',false))$q$,'Approval requires verified funds');
select public.ff_command('review-payment',jsonb_build_object('id',current_setting('ff.sub'),'approve',true,'verified',true));
select public.ff_command('review-payment',jsonb_build_object('id',current_setting('ff.sub'),'approve',true,'verified',true));
select pg_temp.ok((select paid_cents=amount_cents from public.ff_invoices where id=current_setting('ff.invoice')::uuid),'Approval atomically completes balance');
select pg_temp.ok((select count(*)=1 from public.ff_payments where submission_id=current_setting('ff.sub')::uuid),'Repeated approval records only one payment');
select pg_temp.ok((select status='approved' from public.ff_submissions where id=current_setting('ff.sub')::uuid),'Approval updates submission status');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select set_config('ff.pass',public.ff_command('qr','{}')->>'token',true);
select pg_temp.ok(current_setting('ff.pass') like 'FORM2.%','Paid active member receives signed pass');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.ok(public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')))->'member'->>'id'=current_setting('ff.test')::jsonb->>'member','Valid pass identifies correct member');
select pg_temp.must_fail($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')||'tamper'))$q$,'Tampered pass rejected');
select pg_temp.must_fail($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',false))$q$,'Identity confirmation required');
select public.ff_command('manage-member',jsonb_build_object('id',current_setting('ff.test')::jsonb->>'member','enabled',false));
select pg_temp.must_fail($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')))$q$,'Inactive member pass rejected');
select public.ff_command('manage-member',jsonb_build_object('id',current_setting('ff.test')::jsonb->>'member','enabled',true));
select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',true));
select pg_temp.must_fail($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',true))$q$,'Replayed pass rejected');
select pg_temp.ok((select count(*)=1 from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'Only one check-in recorded');
select pg_temp.must_fail($q$select public.ff_command('renew',jsonb_build_object('memberId',current_setting('ff.test')::jsonb->>'member','plan','basic','start',current_date))$q$,'Overlapping membership rejected');
reset role;
-- Sign a deliberately expired payload to test expiry independently of signature validity.
select set_config('ff.expired',(
 with v as (select replace(encode(convert_to(jsonb_build_object('memberId',current_setting('ff.test')::jsonb->>'member','workspace','demo','nonce',gen_random_uuid(),'exp',extract(epoch from now())::bigint-1)::text,'UTF8'),'base64'),E'\n','') p)
 select 'FORM2.'||p||'.'||encode(extensions.hmac(p,(select value from ff_private.secrets where name='qr'),'sha256'),'hex') from v
),true);
set local role authenticated;
select pg_temp.must_fail($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ff.expired')))$q$,'Correctly signed expired pass rejected');
reset role;
delete from auth.sessions where id=(current_setting('ff.test')::jsonb->>'adminSession')::uuid;
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_profiles),'Revoked session loses RLS access immediately');
select pg_temp.must_fail($q$select public.ff_command('plans','{}')$q$,'Revoked session loses command access');
reset role;
-- Staff role: provisioning, read scope, and every permission boundary.
create function pg_temp.fails_with(statement text,needle text,label text) returns void language plpgsql as $$
declare msg text;
begin
 begin execute statement; msg:='(no error raised)';
 exception when others then msg:=SQLERRM; end;
 perform pg_temp.ok(msg like '%'||needle||'%',label);
end $$;

select set_config('ff.staff',jsonb_build_object('id',gen_random_uuid(),'session',gen_random_uuid())::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 select (current_setting('ff.staff')::jsonb->>'id')::uuid,'ff-db-staff@example.invalid','{"ff_workspace":"demo","ff_role":"staff"}',
 jsonb_build_object('form_fitness',true,'name','DB TEST Staff','phone','09170000005');
insert into auth.sessions(id,user_id) select (current_setting('ff.staff')::jsonb->>'session')::uuid,(current_setting('ff.staff')::jsonb->>'id')::uuid;
select pg_temp.ok((select role='staff' and workspace='demo' and enabled from public.ff_profiles where id=(current_setting('ff.staff')::jsonb->>'id')::uuid),'Trusted app_metadata provisions a staff profile');
select pg_temp.ok((select count(*)=0 from public.ff_memberships where member_id=(current_setting('ff.staff')::jsonb->>'id')::uuid),'Staff provisioning creates no membership');
select pg_temp.ok((select count(*)=0 from public.ff_invoices where member_id=(current_setting('ff.staff')::jsonb->>'id')::uuid),'Staff provisioning creates no invoice');

-- user_metadata must never be able to claim the staff role.
select set_config('ff.spoof',gen_random_uuid()::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 select (current_setting('ff.spoof'))::uuid,'ff-db-spoof-staff@example.invalid','{"ff_workspace":"demo"}',
 jsonb_build_object('form_fitness',true,'name','DB TEST Spoof','phone','09170000007','plan','basic','start',ff_private.today(),'ff_role','staff','role','staff');
select pg_temp.ok((select role='member' from public.ff_profiles where id=(current_setting('ff.spoof'))::uuid),'user_metadata cannot claim the staff role');

-- A clean member so the staff cash and renewal checks do not collide with earlier fixtures.
select set_config('ff.cashmember',gen_random_uuid()::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 select (current_setting('ff.cashmember'))::uuid,'ff-db-cash@example.invalid','{"ff_workspace":"demo"}',
 jsonb_build_object('form_fitness',true,'name','DB TEST Cash','phone','09170000006','plan','basic','start',ff_private.today());
select set_config('ff.cash_invoice',(select id::text from public.ff_invoices where member_id=(current_setting('ff.cashmember'))::uuid),true);
select set_config('ff.renewstart',(ff_private.today()+40)::text,true);

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.staff')::jsonb->>'id','role','authenticated','session_id',current_setting('ff.staff')::jsonb->>'session')::text,true);
set local role authenticated;
select pg_temp.ok((select count(*)>1 from public.ff_profiles),'Staff reads the operational member roster');
select pg_temp.ok((select count(*)>0 from public.ff_invoices),'Staff reads member invoices');
select pg_temp.ok((select count(*)>0 from public.ff_memberships),'Staff reads memberships');
select pg_temp.ok((select count(*)=0 from public.ff_notifications),'Staff cannot read the notification log');
select pg_temp.fails_with($q$select public.ff_command('plans',jsonb_build_object('id','basic','name','Changed','priceCents',100,'available',true))$q$,'Administrator access is required','Staff cannot edit plan pricing');
select pg_temp.fails_with($q$select public.ff_command('review-payment',jsonb_build_object('id',gen_random_uuid(),'approve',true,'verified',true))$q$,'Administrator access is required','Staff cannot approve or reject a submitted payment');
select pg_temp.fails_with($q$select public.ff_command('manage-member',jsonb_build_object('id',gen_random_uuid(),'enabled',false))$q$,'Administrator access is required','Staff cannot enable or disable a member');
select pg_temp.fails_with($q$select public.ff_command('settings/payments','{}')$q$,'Administrator access is required','Staff cannot change payment destinations');
select pg_temp.fails_with($q$select public.ff_command('email-retry','{}')$q$,'Administrator access is required','Staff cannot administer notifications');
select pg_temp.fails_with($q$select public.ff_command('profile',jsonb_build_object('name','x','email','ff-db-staff@example.invalid'))$q$,'Sign in as a member','Staff do not use the member profile command');
select pg_temp.fails_with($q$select public.ff_command('scan',jsonb_build_object('token','FORM2.bogus.bogus'))$q$,'Invalid member pass','Staff reach the scanner and are stopped by the pass, not by permission');
select pg_temp.fails_with($q$select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.cash_invoice'),'amountCents',1000,'method','GCash','reference','STAFFTEST123456','verified',true,'idempotencyKey',gen_random_uuid()))$q$,'Only an administrator can record','Staff cannot record a GCash payment');
select pg_temp.fails_with($q$select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.cash_invoice'),'amountCents',1000,'method','Bank transfer','reference','STAFFTEST123457','verified',true,'idempotencyKey',gen_random_uuid()))$q$,'Only an administrator can record','Staff cannot record a bank transfer payment');
select pg_temp.ok((public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('ff.cash_invoice'),'amountCents',1000,'method','Cash','verified',true,'idempotencyKey',gen_random_uuid()))->>'payment') is not null,'Staff record a cash payment at the desk');
select pg_temp.ok((public.ff_command('renew',jsonb_build_object('memberId',current_setting('ff.cashmember'),'plan','basic','start',current_setting('ff.renewstart')))->>'invoiceId') is not null,'Staff create a renewal invoice for a member');

-- A member must not reach any front-desk action.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_command('scan',jsonb_build_object('token','FORM2.bogus.bogus'))$q$,'Gym staff access is required','A member cannot reach the scanner');
select pg_temp.fails_with($q$select public.ff_command('check-in',jsonb_build_object('token','FORM2.bogus.bogus','confirmed',true))$q$,'Gym staff access is required','A member cannot record a check-in');
select pg_temp.ok((select count(*)=0 from public.ff_profiles where role='staff'),'A member cannot see staff accounts in the roster');

reset role;
select count(*) as passed_checks,jsonb_agg(label) as checks from ff_test_log;
rollback;
