-- BUG-016 follow-up: a check-in is confirmed on the member's pass, so it queues no email. Other notifications still
-- queue. Local fixtures only; everything, including Auth rows, rolls back.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table ce_log(label text);
grant select,insert on ce_log to authenticated,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into ce_log values(label); end $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('ce.ids')::jsonb->>k,'role','authenticated','session_id',current_setting('ce.ids')::jsonb->>(k||'Session'))::text,true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('ce.ids')::jsonb->>k)::uuid $$;
select set_config('ce.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['staff','staffSession','member','memberSession','demostaff','demostaffSession','demomember','demomemberSession']) k)::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'ce-'||k||'@example.invalid',jsonb_build_object('ff_workspace',case when k like 'demo%' then 'demo' else 'production' end,'ff_role',case when k like '%staff' then 'staff' else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Email '||k,'phone','09170000060')||case when k like '%member' then jsonb_build_object('plan','basic','start',ff_private.today()) else '{}'::jsonb end
from unnest(array['staff','member','demostaff','demomember']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['staff','member','demostaff','demomember']) k;

-- Production: cash at the desk, then a check-in.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',i.id,'amountCents',i.amount_cents,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true))
from public.ff_invoices i where i.member_id=pg_temp.id('member');
reset role;
select pg_temp.as_user('member');
set local role authenticated;
select set_config('ce.qr',public.ff_command('qr','{}')->>'token',true);
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select set_config('ce.checkin',public.ff_command('check-in',jsonb_build_object('token',current_setting('ce.qr'),'confirmed',true))->>'id',true);
reset role;
select pg_temp.ok(exists(select 1 from public.ff_checkins where id=current_setting('ce.checkin')::uuid),'The check-in is recorded');
select pg_temp.ok(not exists(select 1 from public.ff_notifications where event_key='checkin:'||current_setting('ce.checkin')),'A check-in queues no email');
select pg_temp.ok(exists(select 1 from public.ff_notifications where member_id=pg_temp.id('member') and event_key like 'payment:%' and status='queued'),'Other notifications still queue (the cash payment confirmation)');

-- Demo: the same, and the demo still suppresses everything else.
select pg_temp.as_user('demostaff');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',i.id,'amountCents',i.amount_cents,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true))
from public.ff_invoices i where i.member_id=pg_temp.id('demomember');
reset role;
select pg_temp.as_user('demomember');
set local role authenticated;
select set_config('ce.demoqr',public.ff_command('qr','{}')->>'token',true);
reset role;
select pg_temp.as_user('demostaff');
set local role authenticated;
select set_config('ce.democheckin',public.ff_command('check-in',jsonb_build_object('token',current_setting('ce.demoqr'),'confirmed',true))->>'id',true);
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_notifications where event_key='checkin:'||current_setting('ce.democheckin')),'A demo check-in queues no email either');
select pg_temp.ok((select bool_and(status='suppressed') from public.ff_notifications where member_id=pg_temp.id('demomember')),'Demo notifications stay suppressed');

-- Nothing left waiting to go out for a check-in.
select pg_temp.ok(not exists(select 1 from public.ff_notifications where event_key like 'checkin:%' and status='queued'),'No check-in email is queued anywhere');
select count(*) as passed_checks from ce_log;
rollback;
