-- Local isolated fixtures only. Auth/profile/survey/history changes roll back; no payments or check-ins.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table ash_log(label text);
grant select,insert on ash_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into ash_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Manila')::date $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('ash.ids')::jsonb->>k)::uuid $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id(k),'role','authenticated','session_id',pg_temp.id(k||'Session'))::text,true) $$;
do $$ begin
 perform set_config('ash.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['member','memberSession','other','otherSession','staff','staffSession','admin','adminSession','foreign','foreignSession','desk']) k)::text,true);
end $$;
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'ash-'||k||'-'||pg_temp.id(k)::text||'@example.invalid',
 jsonb_build_object('ff_workspace',case when k='foreign' then 'demo' else 'production' end,'ff_role',case when k in ('staff','admin') then k else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Schedule '||k,'phone','09170000055','goal','Improve fitness')
from unnest(array['member','other','staff','admin','foreign']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['member','other','staff','admin','foreign']) k;
do $$ begin perform set_config('ash.answers','{"goal":"Improve fitness","experience":"beginner","exercises":["strength"],"availableDays":["mon","fri"]}',true); end $$;

select pg_temp.ok(not exists(select 1 from public.ff_attendance_schedules where member_id in (pg_temp.id('member'),pg_temp.id('other'),pg_temp.id('foreign'))),'New accounts have no invented schedule');
select pg_temp.ok((select relrowsecurity from pg_class where oid='public.ff_attendance_schedules'::regclass),'Schedule history has RLS enabled');
select pg_temp.ok(has_table_privilege('authenticated','public.ff_attendance_schedules','select')
 and not has_table_privilege('authenticated','public.ff_attendance_schedules','insert,update,delete'),'Authenticated callers have SELECT only');
select pg_temp.ok(not has_table_privilege('anon','public.ff_attendance_schedules','select')
 and not has_table_privilege('service_role','public.ff_attendance_schedules','select,insert,update,delete'),'Anonymous and service roles have no history grants');
select pg_temp.ok(not has_function_privilege('authenticated','ff_private.capture_attendance_schedule()','execute')
 and not has_function_privilege('anon','ff_private.capture_attendance_schedule()','execute')
 and not has_function_privilege('service_role','ff_private.capture_attendance_schedule()','execute'),'Capture trigger cannot be called by API roles');
select pg_temp.ok(not has_function_privilege('authenticated','ff_private.attendance_weekdays(text[])','execute')
 and (select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='ff_private.capture_attendance_schedule()'::regprocedure),'Private helper is revoked and capture uses a controlled search path');
select pg_temp.ok((select array_agg(column_name::text order by ordinal_position)=array['id','workspace','member_id','effective_from','available_days','recorded_at']
 from information_schema.columns where table_schema='public' and table_name='ff_attendance_schedules'),'History stores only effective weekdays and bookkeeping, no health data');

select pg_temp.as_user('member');
set local role authenticated;
select public.ff_save_member_survey(current_setting('ash.answers')::jsonb);
select pg_temp.ok((select count(*)=1 and bool_and(member_id=auth.uid() and effective_from=pg_temp.today() and available_days=array['mon','fri']) from public.ff_attendance_schedules),'First saved survey starts tracking today without older history');
select public.ff_save_member_survey(current_setting('ash.answers')::jsonb||'{"experience":"returning","availableDays":["fri","mon"]}');
select pg_temp.ok((select count(*)=1 from public.ff_attendance_schedules),'Unchanged weekday set does not create history');
select public.ff_save_member_survey(current_setting('ash.answers')::jsonb||'{"availableDays":["tue","thu"]}');
select pg_temp.ok((select count(*)=2 and bool_or(effective_from=pg_temp.today()+1 and available_days=array['tue','thu']) from public.ff_attendance_schedules),'Changed usual weekdays take effect tomorrow');
select public.ff_save_member_survey(current_setting('ash.answers')::jsonb||'{"availableDays":["wed","sat"]}');
select pg_temp.ok((select count(*)=2 and bool_or(effective_from=pg_temp.today()+1 and available_days=array['wed','sat']) from public.ff_attendance_schedules),'Repeated changes replace only the same pending tomorrow schedule');
select pg_temp.ok((select available_days=array['mon','fri'] from public.ff_attendance_schedules where effective_from=pg_temp.today()),'Today keeps its original weekdays after later survey changes');
select pg_temp.denied('update public.ff_attendance_schedules set available_days=array[''sun'']','Members cannot directly alter current or past history');
select pg_temp.denied('delete from public.ff_attendance_schedules','Members cannot delete history');
select pg_temp.denied($q$insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days) values('production',auth.uid(),pg_temp.today()-10,array['mon'])$q$,'Members cannot backdate a schedule');
select pg_temp.denied('select ff_private.capture_attendance_schedule()','Member cannot invoke the trigger directly');
reset role;

-- Simulate a later business day using this transaction's fixtures only, without changing the clock.
update public.ff_attendance_schedules set effective_from=pg_temp.today()-1 where member_id=pg_temp.id('member') and effective_from=pg_temp.today();
update public.ff_attendance_schedules set effective_from=pg_temp.today() where member_id=pg_temp.id('member') and effective_from=pg_temp.today()+1;
select pg_temp.as_user('member');
set local role authenticated;
select public.ff_save_member_survey(current_setting('ash.answers')::jsonb||'{"availableDays":["sun"]}');
select pg_temp.ok((select count(*)=3 and bool_or(effective_from=pg_temp.today()+1 and available_days=array['sun']) from public.ff_attendance_schedules),'A later change creates a new effective schedule');
select pg_temp.ok((select available_days=array['mon','fri'] from public.ff_attendance_schedules where effective_from=pg_temp.today()-1),'Completed dates retain their original usual weekdays');
select pg_temp.ok((select available_days=array['wed','sat'] from public.ff_attendance_schedules where effective_from=pg_temp.today()),'The now-current schedule remains unchanged');
reset role;

do $$ declare k text; begin
 foreach k in array array['other','foreign'] loop perform pg_temp.as_user(k); perform public.ff_save_member_survey(current_setting('ash.answers')::jsonb); end loop;
end $$;
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=3 and bool_and(member_id=auth.uid()) from public.ff_attendance_schedules),'A member sees only their own schedule, never other members or workspaces');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_attendance_schedules),'Staff cannot read member schedule history');
select pg_temp.denied('update public.ff_member_surveys set available_days=array[''sun'']','Staff survey authorization remains unchanged');
select pg_temp.denied('select ff_private.capture_attendance_schedule()','Staff cannot invoke the capture function');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_attendance_schedules),'Administrators cannot read member schedule history through this owner-only table');
reset role;
set local role anon;
select pg_temp.denied('select * from public.ff_attendance_schedules','Anonymous callers cannot read history');
reset role;
set local role service_role;
select pg_temp.denied('select * from public.ff_attendance_schedules','Service API role has no history SELECT grant');
reset role;

-- Staff's existing desk account-creation path stores the initial known schedule in the same transaction.
select pg_temp.as_user('staff');
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('desk'),'ash-desk-'||pg_temp.id('desk')::text||'@example.invalid',
 '{"ff_workspace":"production","ff_role":"member"}',
 '{"form_fitness":true,"name":"LOCAL TEST Desk schedule","phone":"09170000055","goal":"Improve fitness","survey":{"experience":"beginner","exercises":["cardio"],"availableDays":["tue","sat"]}}');
select pg_temp.ok((select count(*)=1 and bool_and(effective_from=pg_temp.today() and available_days=array['tue','sat']) from public.ff_attendance_schedules where member_id=pg_temp.id('desk')),'Desk-entered survey establishes only today onward');
update public.ff_member_surveys set available_days=array['mon','sun'] where id=pg_temp.id('desk');
select pg_temp.ok((select count(*)=2 and bool_or(effective_from=pg_temp.today()+1 and available_days=array['mon','sun']) from public.ff_attendance_schedules where member_id=pg_temp.id('desk')),'Any authorized survey-table update is captured without a command rewrite');

update public.ff_profiles set role='staff' where id=pg_temp.id('other');
select pg_temp.as_user('other');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_attendance_schedules),'Former member who is now staff cannot read retained member history');
reset role;
update public.ff_profiles set enabled=false where id=pg_temp.id('member');
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_attendance_schedules),'Disabled member cannot read history');
reset role;
update public.ff_profiles set enabled=true where id=pg_temp.id('member');
delete from auth.sessions where user_id=pg_temp.id('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_attendance_schedules),'Revoked session cannot read history');
reset role;

do $$ declare days text[]; begin
 foreach days slice 1 in array array[array['mon','mon'],array['mon','bad'],array['sun','mon'],array['mon',null]]::text[] loop
  perform pg_temp.denied(format('insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days) values(''production'',%L,pg_temp.today()+20,%L::text[])',pg_temp.id('desk'),days),'Invalid, duplicate or noncanonical weekdays are rejected');
 end loop;
end $$;
select pg_temp.denied(format('insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days) values(''production'',%L,pg_temp.today()+20,''{}''::text[])',pg_temp.id('desk')),'Empty weekday history is rejected');
select pg_temp.denied(format('insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days) values(''demo'',%L,pg_temp.today()+20,array[''mon''])',pg_temp.id('desk')),'History cannot cross a member workspace');
delete from public.ff_profiles where id=pg_temp.id('desk');
delete from auth.users where id=pg_temp.id('desk');
select pg_temp.ok(not exists(select 1 from public.ff_attendance_schedules where member_id=pg_temp.id('desk')),'Existing never-paid account cleanup can cascade its schedule rows');
select count(*) as passed from ash_log;
rollback;
