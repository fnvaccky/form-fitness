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
select pg_temp.ok(jsonb_typeof(public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')))->'alreadyCheckedInAt')='null','Scan reports no visit before the first check-in today');
select pg_temp.must_fail($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')||'tamper'))$q$,'Tampered pass rejected');
select pg_temp.must_fail($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',false))$q$,'Identity confirmation required');
select public.ff_command('manage-member',jsonb_build_object('id',current_setting('ff.test')::jsonb->>'member','enabled',false));
select pg_temp.must_fail($q$select public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass')))$q$,'Inactive member pass rejected');
select public.ff_command('manage-member',jsonb_build_object('id',current_setting('ff.test')::jsonb->>'member','enabled',true));
select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',true));
select pg_temp.must_fail($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass'),'confirmed',true))$q$,'Replayed pass rejected');
select pg_temp.ok((select count(*)=1 from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'Only one check-in recorded');
select pg_temp.ok((select checkin_date=(now() at time zone 'Asia/Manila')::date from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'First check-in records the Manila calendar day');
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

-- One visit per member per Manila day: a fresh pass carries a new nonce but must not add a second visit.
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select set_config('ff.pass2',public.ff_command('qr','{}')->>'token',true);
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.staff')::jsonb->>'id','role','authenticated','session_id',current_setting('ff.staff')::jsonb->>'session')::text,true);
set local role authenticated;
select pg_temp.ok((public.ff_command('scan',jsonb_build_object('token',current_setting('ff.pass2')))->>'alreadyCheckedInAt')::timestamptz=(select created_at from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'Scanning a fresh pass reports the visit already recorded today');
select pg_temp.fails_with($q$select public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass2'),'confirmed',true))$q$,'Already checked in today.','A fresh pass cannot add a second check-in on the same day');
select pg_temp.ok((select count(*)=1 from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'Still exactly one check-in today');
reset role;
select pg_temp.fails_with($q$insert into public.ff_checkins(workspace,member_id,membership_id,nonce,confirmed_by) select workspace,member_id,membership_id,gen_random_uuid(),confirmed_by from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid$q$,'ff_checkins_workspace_member_id_checkin_date_key','The database itself rejects a second same-day check-in');
-- now() is fixed for the whole transaction, so the next day is simulated by moving the recorded visit to yesterday.
update public.ff_checkins set checkin_date=checkin_date-1 where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid;
set local role authenticated;
select pg_temp.ok(jsonb_typeof(public.ff_command('check-in',jsonb_build_object('token',current_setting('ff.pass2'),'confirmed',true))->'id')='string','A check-in on the next day is allowed');
select pg_temp.ok((select count(*)=2 and count(distinct checkin_date)=2 from public.ff_checkins where member_id=(current_setting('ff.test')::jsonb->>'member')::uuid),'Each day records exactly one visit');

-- A member must not reach any front-desk action.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_command('scan',jsonb_build_object('token','FORM2.bogus.bogus'))$q$,'Gym staff access is required','A member cannot reach the scanner');
select pg_temp.fails_with($q$select public.ff_command('check-in',jsonb_build_object('token','FORM2.bogus.bogus','confirmed',true))$q$,'Gym staff access is required','A member cannot record a check-in');
select pg_temp.ok((select count(*)=0 from public.ff_profiles where role='staff'),'A member cannot see staff accounts in the roster');

-- Staff management: one administrator-only boundary, an append-only audit trail, workspace isolation.
reset role;
create function pg_temp.state_of(statement text) returns text language plpgsql as $$
declare st text;
begin
 begin execute statement; st:='00000';
 exception when others then st:=SQLSTATE; end;
 return st;
end $$;
select set_config('ff.sm',jsonb_build_object('admin',gen_random_uuid(),'adminSession',gen_random_uuid(),'admin2',gen_random_uuid(),'admin2Session',gen_random_uuid(),
 'prodAdmin',gen_random_uuid(),'prodAdminSession',gen_random_uuid(),'target',gen_random_uuid(),'targetSession',gen_random_uuid(),'target2',gen_random_uuid(),
 'freshSession',gen_random_uuid(),'authOnly',gen_random_uuid())::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 select (current_setting('ff.sm')::jsonb->>k)::uuid,'ff-db-sm-'||lower(k)||'@example.invalid',
 jsonb_build_object('ff_workspace',case when k='prodAdmin' then 'production' else 'demo' end,'ff_role',case when k like 'target%' then 'staff' else 'admin' end),
 jsonb_build_object('form_fitness',true,'name','DB TEST Staff Admin '||k,'phone','09170000011')
 from unnest(array['admin','admin2','prodAdmin','target','target2']) k;
-- An Auth account with no RepReady profile, and a profile whose email differs from its Auth email.
insert into auth.users(id,email) select (current_setting('ff.sm')::jsonb->>'authOnly')::uuid,'ff-db-sm-authonly@example.invalid';
update public.ff_profiles set email='ff-db-sm-profileonly@example.invalid' where id=(current_setting('ff.sm')::jsonb->>'target2')::uuid;
insert into auth.sessions(id,user_id) select (current_setting('ff.sm')::jsonb->>(k||'Session'))::uuid,(current_setting('ff.sm')::jsonb->>k)::uuid from unnest(array['admin','admin2','prodAdmin','target']) k;
-- A pending registration holds its email until it is provisioned.
insert into public.ff_registrations(workspace,request_id,name,email,phone,plan_id,plan_name,features,days,start_date,end_date,amount_cents,created_by)
 select 'demo',gen_random_uuid(),'DB TEST Pending Staff Email','ff-db-sm-pending@example.invalid','09170000012','basic','Essential','[]',30,ff_private.today(),ff_private.today()+29,89900,(current_setting('ff.sm')::jsonb->>'admin')::uuid;

-- Front-desk staff, members and anonymous callers never reach the staff boundary.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'target','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'targetSession')::text,true);
set local role authenticated;
select pg_temp.ok(pg_temp.state_of($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-new@example.invalid','phone','09170000013'))$q$)='42501','Staff get 42501 from staff management');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.ok(pg_temp.state_of($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-new@example.invalid','phone','09170000013'))$q$)='42501','Members get 42501 from staff management');
reset role;
set local role anon;
select set_config('ff.anon_state',pg_temp.state_of($q$select public.ff_staff_admin('get','{}')$q$),true);
reset role;
select pg_temp.ok(current_setting('ff.anon_state')='42501','Anonymous callers cannot execute staff management');

-- prepare-create validates like ff_profiles, rejects every claimed email and writes nothing.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.ok((select public.ff_staff_admin('prepare-create',jsonb_build_object('name','  DB TEST New Staff ','email','FF-DB-SM-NEW@Example.invalid','phone','+63 917 000 0013'))
 @> '{"workspace":"demo","name":"DB TEST New Staff","email":"ff-db-sm-new@example.invalid","phone":"09170000013"}'),'Admin prepare-create returns the admin''s workspace and normalized contacts');
select pg_temp.ok((select count(*)=0 from public.ff_staff_audit where actor_id=(current_setting('ff.sm')::jsonb->>'admin')::uuid),'prepare-create writes nothing');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','D','email','ff-db-sm-new@example.invalid','phone','09170000013'))$q$,'Enter a full name','prepare-create applies the profile name rule');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','not-an-email','phone','09170000013'))$q$,'Enter a valid email address','prepare-create applies the profile email rule');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-new@example.invalid','phone','12345'))$q$,'Mobile number is required','prepare-create applies the profile mobile rule');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','FF-DB-SM-AUTHONLY@example.invalid','phone','09170000013'))$q$,'An account already uses this email','An Auth account without a profile blocks the email');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','FF-DB-SM-PROFILEONLY@example.invalid','phone','09170000013'))$q$,'An account already uses this email','A profile email blocks the email in any letter case');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-prodadmin@example.invalid','phone','09170000013'))$q$,'An account already uses this email','An account in another workspace blocks the email');
select pg_temp.fails_with($q$select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-pending@example.invalid','phone','09170000013'))$q$,'An account already uses this email','A pending registration blocks the email');
select pg_temp.fails_with($q$select public.ff_staff_admin('promote',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))$q$,'Unknown staff action','Unknown actions are refused');

-- log-create, get and update act only on staff in the administrator's workspace.
select pg_temp.ok((select public.ff_staff_admin('log-create',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))->>'role')='staff','log-create records a newly provisioned staff account');
select pg_temp.fails_with($q$select public.ff_staff_admin('log-create',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))$q$,'already recorded','log-create records each account once');
select pg_temp.fails_with($q$select public.ff_staff_admin('log-create',jsonb_build_object('id',current_setting('ff.test')::jsonb->>'member'))$q$,'Staff member not found','Staff management never acts on a member');
select pg_temp.ok((select public.ff_staff_admin('get',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))->>'email')='ff-db-sm-target@example.invalid','get returns one staff profile');
select pg_temp.fails_with($q$select public.ff_staff_admin('get',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'admin2'))$q$,'Administrators can''t be changed here','Staff management never acts on an administrator');
select pg_temp.ok((select public.ff_staff_admin('update',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','name','DB TEST Renamed Staff','phone','09170000014','email','ff-db-sm-changed@example.invalid','role','admin','workspace','production'))->>'name')='DB TEST Renamed Staff','Admin updates a staff member''s name and mobile');
select pg_temp.fails_with($q$select public.ff_staff_admin('update',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','name','DB TEST Renamed Staff','phone','12345'))$q$,'Mobile number is required','update applies the profile mobile rule');
reset role;
select pg_temp.ok((select name='DB TEST Renamed Staff' and phone='09170000014' and role='staff' and workspace='demo' and email='ff-db-sm-target@example.invalid' from public.ff_profiles where id=(current_setting('ff.sm')::jsonb->>'target')::uuid),'update never changes role, workspace or email');

-- set-enabled: never an administrator, and disabling ends access at once.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'admin','enabled',false))$q$,'can''t disable their own account','An administrator cannot disable themselves');
select pg_temp.fails_with($q$select public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'admin2','enabled',false))$q$,'Administrators can''t be changed here','An administrator cannot disable another administrator');
select pg_temp.fails_with($q$select public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','enabled','no'))$q$,'Choose whether the account is enabled','set-enabled requires a true or false value');
select pg_temp.ok((select (public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','enabled',false))->>'enabled')::boolean=false),'Admin disables a staff account');
reset role;
select pg_temp.ok((select bool_and(enabled) from public.ff_profiles where id in ((current_setting('ff.sm')::jsonb->>'admin')::uuid,(current_setting('ff.sm')::jsonb->>'admin2')::uuid)),'Both administrators stay enabled');
select pg_temp.ok((select count(*)=0 from auth.sessions where user_id=(current_setting('ff.sm')::jsonb->>'target')::uuid),'Disabling deletes every session of that staff member');
-- Even a brand-new session gives a disabled staff member nothing.
insert into auth.sessions(id,user_id) select (current_setting('ff.sm')::jsonb->>'freshSession')::uuid,(current_setting('ff.sm')::jsonb->>'target')::uuid;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'target','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'freshSession')::text,true);
set local role authenticated;
select pg_temp.ok(pg_temp.state_of($q$select public.ff_command('scan',jsonb_build_object('token','FORM2.bogus.bogus'))$q$)='42501','A disabled staff member cannot run any ff_command (42501)');
select pg_temp.ok((select count(*)=0 from public.ff_profiles),'A disabled staff member reads nothing');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.ok((select (public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','enabled',true))->>'enabled')::boolean),'Admin re-enables a staff account');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'target','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'freshSession')::text,true);
set local role authenticated;
select pg_temp.ok(pg_temp.state_of($q$select public.ff_command('scan',jsonb_build_object('token','FORM2.bogus.bogus'))$q$) not in ('42501','00000'),'Re-enabling restores ff_command access');
select pg_temp.ok((select count(*)>1 from public.ff_profiles),'Re-enabling restores roster access');
select pg_temp.ok((select count(*)=0 from public.ff_staff_audit),'Staff cannot read the staff audit trail');
reset role;

-- resend: the audit row is the sending claim, so a second link within 60 seconds is refused.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'admin','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.ok((select public.ff_staff_admin('resend',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))->>'email')='ff-db-sm-target@example.invalid','Admin claims a setup-link resend');
select pg_temp.ok(pg_temp.state_of($q$select public.ff_staff_admin('resend',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))$q$)='PT429','A second resend within 60 seconds is refused (PT429)');
select pg_temp.ok((select public.ff_staff_admin('get',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))->>'lastResendAt') is not null,'get reports when the last setup link was sent');
select pg_temp.ok((select array_agg(action order by action)=array['create','disable','enable','resend','update'] from public.ff_staff_audit where target_id=(current_setting('ff.sm')::jsonb->>'target')::uuid),'Each successful action writes exactly one audit row');
select pg_temp.ok((select bool_and(actor_id=(current_setting('ff.sm')::jsonb->>'admin')::uuid and workspace='demo') from public.ff_staff_audit where target_id=(current_setting('ff.sm')::jsonb->>'target')::uuid),'Audit rows record the acting administrator and workspace');
select pg_temp.ok((select (public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target2','enabled',false))->>'enabled')::boolean=false),'Admin disables a second staff account');
select pg_temp.fails_with($q$select public.ff_staff_admin('resend',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target2'))$q$,'Enable this account','A disabled account gets no setup link');
select pg_temp.must_fail($q$insert into public.ff_staff_audit(workspace,actor_id,target_id,action) values('demo',(current_setting('ff.sm')::jsonb->>'admin')::uuid,(current_setting('ff.sm')::jsonb->>'target')::uuid,'update')$q$,'Administrators cannot write the audit trail directly');
reset role;
set local role service_role;
select set_config('ff.service_write',pg_temp.state_of($q$insert into public.ff_staff_audit(workspace,actor_id,target_id,action) values('demo',(current_setting('ff.sm')::jsonb->>'admin')::uuid,(current_setting('ff.sm')::jsonb->>'target')::uuid,'update')$q$),true);
reset role;
select pg_temp.ok(current_setting('ff.service_write')='42501','service_role cannot write the audit trail directly');

-- Workspace isolation: another workspace's administrator cannot see or manage these staff.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.sm')::jsonb->>'prodAdmin','role','authenticated','session_id',current_setting('ff.sm')::jsonb->>'prodAdminSession')::text,true);
set local role authenticated;
select pg_temp.ok((select public.ff_staff_admin('prepare-create',jsonb_build_object('name','DB TEST New Staff','email','ff-db-sm-new@example.invalid','phone','09170000013'))->>'workspace')='production','prepare-create always uses the administrator''s own workspace');
select pg_temp.fails_with($q$select public.ff_staff_admin('get',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target'))$q$,'Staff member not found','Another workspace''s administrator cannot read this staff member');
select pg_temp.fails_with($q$select public.ff_staff_admin('set-enabled',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','enabled',false))$q$,'Staff member not found','Another workspace''s administrator cannot disable this staff member');
select pg_temp.fails_with($q$select public.ff_staff_admin('update',jsonb_build_object('id',current_setting('ff.sm')::jsonb->>'target','name','DB TEST Hijack','phone','09170000015'))$q$,'Staff member not found','Another workspace''s administrator cannot edit this staff member');
select pg_temp.ok((select count(*)=0 from public.ff_staff_audit where target_id=(current_setting('ff.sm')::jsonb->>'target')::uuid),'Another workspace''s administrator cannot read this audit trail');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ff.test')::jsonb->>'member','role','authenticated','session_id',current_setting('ff.test')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_staff_audit),'Members cannot read the staff audit trail');

reset role;
select count(*) as passed_checks,jsonb_agg(label) as checks from ff_test_log;
rollback;
