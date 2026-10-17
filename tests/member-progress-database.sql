-- Local isolated fixtures only. Every account, goal, weight and cleanup operation rolls back.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table mp_log(label text);
grant select,insert on mp_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into mp_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare refused boolean:=false; begin begin execute statement; exception when others then refused:=true; end; perform pg_temp.ok(refused,label); end $$;
create function pg_temp.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Manila')::date $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('mp.ids')::jsonb->>k)::uuid $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id(k),'role','authenticated','session_id',pg_temp.id(k||'Session'))::text,true) $$;
create function pg_temp.current_goal() returns uuid language sql as $$ select id from public.ff_member_goals where member_id=auth.uid() and ended_at is null $$;
create function pg_temp.goal(kind text,starting numeric,target numeric,op text default 'new_goal') returns jsonb language sql as $$
 select jsonb_build_object('action',op,'requestId',gen_random_uuid(),'goalId',pg_temp.current_goal(),'goalType',kind,
  'startDate',pg_temp.today()-7,'startingWeightKg',starting,'measurementDate',case when kind='attendance' then null else pg_temp.today()-7 end,'targetWeightKg',target) $$;
create function pg_temp.run(body jsonb) returns jsonb language sql as $$ select public.ff_member_progress(body) $$;
select set_config('mp.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['member','memberSession','other','otherSession','staff','staffSession','admin','adminSession','foreign','foreignSession']) k)::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'mp-'||k||'-'||pg_temp.id(k)::text||'@example.invalid',
 jsonb_build_object('ff_workspace',case when k='foreign' then 'demo' else 'production' end,'ff_role',case when k in ('staff','admin') then k else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Progress '||k,'phone','09170000055','goal','Improve fitness')
from unnest(array['member','other','staff','admin','foreign']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['member','other','staff','admin','foreign']) k;
insert into public.ff_member_health(id,workspace,weight_kg,conditions) values(pg_temp.id('member'),'production',64,array['asthma']);
select pg_temp.ok(not exists(select 1 from public.ff_member_goals where member_id=pg_temp.id('member')) and not exists(select 1 from public.ff_member_weights where member_id=pg_temp.id('member')),'Creating an account or health profile does not invent a goal or weigh-in');

select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((pg_temp.run('{"action":"read"}') ->>'ok')::boolean,'Enabled member read guard succeeds without a membership or coaching-tier gate');
select pg_temp.ok((select count(*)=0 from public.ff_member_goals) and (select count(*)=0 from public.ff_member_weights),'New owner sees honest empty progress');
select set_config('mp.first',pg_temp.goal('gain',60,65)::text,true);
select pg_temp.run(current_setting('mp.first')::jsonb);
select pg_temp.ok((select count(*)=1 and bool_and(member_id=auth.uid() and workspace='production' and goal_type='gain' and starting_weight_kg=60 and target_weight_kg=65 and ended_at is null) from public.ff_member_goals),'Confirmed gain goal stores owner/workspace and frozen reference');
select pg_temp.ok((select count(*)=1 and bool_and(measured_on=pg_temp.today()-7 and weight_kg=60) from public.ff_member_weights),'Confirmed starting measurement creates one real dated baseline only when absent');
select pg_temp.run(current_setting('mp.first')::jsonb);
select pg_temp.ok((select count(*)=1 from public.ff_member_goals) and (select count(*)=1 from public.ff_member_weights),'Identical request retry is idempotent');
select pg_temp.denied($q$select pg_temp.run(current_setting('mp.first')::jsonb||'{"targetWeightKg":66}')$q$,'Same retry key with changed settings is refused');
select pg_temp.denied($q$select pg_temp.run(current_setting('mp.first')::jsonb||jsonb_build_object('requestId',gen_random_uuid()))$q$,'Stale expected current goal is refused instead of duplicating a period');
select set_config('mp.period',(select period_id::text from public.ff_member_goals where ended_at is null),true);
select pg_temp.run(jsonb_build_object('action','pause_goal','goalId',pg_temp.current_goal(),'requestId',gen_random_uuid()));
select pg_temp.ok((select count(*)=2 and count(*) filter(where ended_at is null)=1 and bool_or(status='active' and ended_at is not null) and bool_or(status='paused' and ended_at is null) and bool_and(period_id=current_setting('mp.period')::uuid) from public.ff_member_goals),'Pause appends a revision and preserves the earlier active period settings');
select pg_temp.run(jsonb_build_object('action','resume_goal','goalId',pg_temp.current_goal(),'requestId',gen_random_uuid()));
select pg_temp.ok((select count(*)=3 and bool_or(status='active' and ended_at is null) from public.ff_member_goals),'Resume appends an active revision');
select pg_temp.run(pg_temp.goal('gain',60,66,'save_goal'));
select pg_temp.ok((select count(*)=4 and bool_or(target_weight_kg=65 and ended_at is not null) and bool_or(target_weight_kg=66 and ended_at is null) and bool_and(period_id=current_setting('mp.period')::uuid) from public.ff_member_goals),'Editing goal preserves historical target and goal period');
select pg_temp.ok((select count(*)=1 from public.ff_member_weights),'Same confirmed baseline never creates duplicate measurement points');
select pg_temp.run(pg_temp.goal('attendance',null,null));
select pg_temp.ok((select goal_type='attendance' and starting_weight_kg is null and measurement_date is null and target_weight_kg is null and period_id<>current_setting('mp.period')::uuid from public.ff_member_goals where ended_at is null),'New attendance goal starts another period without requiring weight');
select pg_temp.ok((select count(*)=5 from public.ff_member_goals) and (select count(*)=1 from public.ff_member_weights),'Replacing a goal preserves prior revisions and weigh-ins');
select pg_temp.run(pg_temp.goal('maintain',60,null));
select pg_temp.ok((select goal_type='maintain' and starting_weight_kg=60 and target_weight_kg is null from public.ff_member_goals where ended_at is null),'Maintain stores confirmed reference without target or invented tolerance');
select pg_temp.run(pg_temp.goal('lose',60,55));
select pg_temp.ok((select goal_type='lose' and target_weight_kg=55 from public.ff_member_goals where ended_at is null),'Loss accepts a lower optional target');
select pg_temp.run(pg_temp.goal('lose',60,null,'save_goal'));
select pg_temp.ok((select target_weight_kg is null from public.ff_member_goals where ended_at is null),'Directional target can remain optional');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('gain',60,60))$q$,'Gain target equal to reference is invalid');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('gain',60,59))$q$,'Gain target below reference is invalid');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('lose',60,60))$q$,'Loss target equal to reference is invalid');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('lose',60,61))$q$,'Loss target above reference is invalid');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('maintain',60,61))$q$,'Maintain cannot invent a target');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('attendance',60,null))$q$,'Attendance goal refuses unnecessary measurements');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('gain',61,65))$q$,'Existing date with different starting weight requires explicit edit rather than silent replacement');

select pg_temp.run(jsonb_build_object('action','add_weight','date',pg_temp.today()-5,'weightKg',61.2));
select pg_temp.ok((select count(*)=2 and bool_or(measured_on=pg_temp.today()-5 and weight_kg=61.2) from public.ff_member_weights),'Member adds dated one-decimal measurement');
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','add_weight','date',pg_temp.today()-5,'weightKg',62))$q$,'Adding a duplicate date refuses silent overwrite');
select set_config('mp.weight',(select id::text from public.ff_member_weights where measured_on=pg_temp.today()-5),true);
select pg_temp.run(jsonb_build_object('action','update_weight','id',current_setting('mp.weight'),'date',pg_temp.today()-5,'weightKg',62.3));
select pg_temp.ok((select weight_kg=62.3 and updated_at>=recorded_at from public.ff_member_weights where id=current_setting('mp.weight')::uuid),'Explicit correction preserves identity and records update timestamp');
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','update_weight','id',current_setting('mp.weight'),'date',pg_temp.today()-7,'weightKg',62))$q$,'Moving an edit onto another existing date refuses collision');
select pg_temp.run(jsonb_build_object('action','delete_weight','id',current_setting('mp.weight')));
select pg_temp.ok((select count(*)=1 from public.ff_member_weights),'Explicit deletion removes only selected dated point');
select pg_temp.run(jsonb_build_object('action','delete_weight','id',(select id from public.ff_member_weights limit 1)));
select pg_temp.ok((select count(*)=0 from public.ff_member_weights) and (select bool_and(starting_weight_kg=60) from public.ff_member_goals where goal_type<>'attendance'),'Deleting even baseline weigh-in preserves confirmed historical goal references');
select pg_temp.run(jsonb_build_object('action','add_weight','date',pg_temp.today(),'weightKg',60.1));

do $$ declare change jsonb; begin
 foreach change in array array[
  '{"startingWeightKg":"60"}'::jsonb,'{"startingWeightKg":null}','{"startingWeightKg":9.9}','{"startingWeightKg":500.1}','{"startingWeightKg":60.11}',
  '{"targetWeightKg":"65"}','{"targetWeightKg":501}','{"measurementDate":null}','{"measurementDate":"2026-02-30"}',
  '{"goalType":"auto"}','{"goalType":null}','{"memberId":"private"}','{"workspace":"demo"}','{"conditions":["asthma"]}','{"requestId":null}'
 ] loop perform pg_temp.denied(format('select pg_temp.run(%L::jsonb)',pg_temp.goal('gain',60,65)||change),'Invalid or identity-overridden goal payload refused'); end loop;
end $$;
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('gain',60,65)||jsonb_build_object('startDate',pg_temp.today()+1))$q$,'Future goal start refused');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('gain',60,65)||jsonb_build_object('measurementDate',pg_temp.today()))$q$,'Reference measurement after chosen start refused');
do $$ declare change jsonb; begin
 foreach change in array array['{"weightKg":9.9}'::jsonb,'{"weightKg":500.1}','{"weightKg":60.11}','{"weightKg":"60"}','{"weightKg":null}','{"weightKg":true}','{"date":"2026-02-30"}','{"date":null}','{"replace":true}','{"memberId":"private"}','{"workspace":"demo"}'] loop
  perform pg_temp.denied(format('select pg_temp.run(%L::jsonb)',jsonb_build_object('action','add_weight','date',pg_temp.today()-1,'weightKg',61)||change),'Invalid or identity-overridden weigh-in refused');
 end loop;
end $$;
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','add_weight','date',pg_temp.today()+1,'weightKg',61))$q$,'Future weigh-in refused');
select pg_temp.denied($q$select pg_temp.run('{"action":"read","memberId":"private"}')$q$,'Read identity override refused');
select pg_temp.denied('select pg_temp.run(null)','Null action refused');
select pg_temp.denied($q$select pg_temp.run('[]')$q$,'Nonobject action refused');
select pg_temp.denied($q$select pg_temp.run('{}')$q$,'Missing action refused');
select pg_temp.denied('delete from public.ff_member_goals','Direct goal delete denied');
select pg_temp.denied('update public.ff_member_goals set target_weight_kg=55','Direct goal edit denied');
select pg_temp.denied($q$insert into public.ff_member_goals(workspace,member_id,period_id,request_id,request_hash,goal_type,status,start_date) values('production',auth.uid(),gen_random_uuid(),gen_random_uuid(),repeat('a',32),'attendance','active',current_date)$q$,'Direct goal insertion denied');
select pg_temp.denied('delete from public.ff_member_weights','Direct measurement delete denied');
select pg_temp.denied('update public.ff_member_weights set weight_kg=64','Direct measurement edit denied');
select pg_temp.denied($q$insert into public.ff_member_weights(workspace,member_id,measured_on,weight_kg) values('production',auth.uid(),current_date,60)$q$,'Direct measurement insertion denied');
select pg_temp.ok((select weight_kg=64 and conditions=array['asthma'] from public.ff_member_health),'Tracking does not overwrite saved health weight or conditions');
select pg_temp.ok((select count(*)=0 from public.ff_member_surveys where id=auth.uid()) and (select count(*)=0 from public.ff_attendance_schedules where member_id=auth.uid()),'Tracking does not create fitness answers or a second attendance schedule');
reset role;

do $$ declare k text; begin foreach k in array array['other','foreign'] loop
 perform pg_temp.as_user(k);perform pg_temp.run(pg_temp.goal('maintain',70,null));
end loop; end $$;
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select bool_and(member_id=auth.uid() and workspace='production') from public.ff_member_goals) and (select count(*)=1 and bool_and(member_id=auth.uid() and workspace='production') from public.ff_member_weights),'RLS restricts goals and weigh-ins to own workspace and owner');
reset role;
select set_config('mp.otherWeight',(select id::text from public.ff_member_weights where member_id=pg_temp.id('other')),true);
set local role authenticated;
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','delete_weight','id',current_setting('mp.otherWeight')))$q$,'Member cannot delete another owner measurement');
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','update_weight','id',current_setting('mp.otherWeight'),'date',current_date,'weightKg',60))$q$,'Member cannot correct another owner measurement');
reset role;
do $$ declare k text; begin foreach k in array array['staff','admin'] loop
 perform pg_temp.as_user(k);set local role authenticated;
 perform pg_temp.ok((select count(*)=0 from public.ff_member_goals) and (select count(*)=0 from public.ff_member_weights),k||' preview has no private progress');
 perform pg_temp.denied($q$select pg_temp.run('{"action":"read"}')$q$,k||' cannot invoke private read guard');
 perform pg_temp.denied($q$select pg_temp.run(pg_temp.goal('attendance',null,null))$q$,k||' cannot write private goals');
 reset role;
end loop; end $$;
set local role anon;
select pg_temp.denied('select * from public.ff_member_goals','Anonymous cannot read goals');
select pg_temp.denied('select * from public.ff_member_weights','Anonymous cannot read measurements');
select pg_temp.denied($q$select public.ff_member_progress('{"action":"read"}')$q$,'Anonymous cannot invoke progress RPC');
reset role;
set local role service_role;
select pg_temp.denied('select * from public.ff_member_goals','Service API has no goals grant');
select pg_temp.denied('select * from public.ff_member_weights','Service API has no measurements grant');
select pg_temp.denied($q$select public.ff_member_progress('{"action":"read"}')$q$,'Service API has no progress RPC grant');
reset role;

update public.ff_profiles set role='staff' where id=pg_temp.id('other');
select pg_temp.as_user('other');set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_goals) and (select count(*)=0 from public.ff_member_weights),'Former member now staff cannot read retained private progress');
select pg_temp.denied($q$select pg_temp.run('{"action":"read"}')$q$,'Role-changed staff read denied');
reset role;
update public.ff_profiles set role='member' where id=pg_temp.id('other');
update public.ff_profiles set enabled=false where id=pg_temp.id('member');
select pg_temp.as_user('member');set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_goals) and (select count(*)=0 from public.ff_member_weights),'Disabled member cannot read progress');
select pg_temp.denied($q$select pg_temp.run('{"action":"read"}')$q$,'Disabled member private read denied');
select pg_temp.denied($q$select pg_temp.run(jsonb_build_object('action','add_weight','date',current_date,'weightKg',60))$q$,'Disabled member cannot save a measurement');
reset role;
update public.ff_profiles set enabled=true where id=pg_temp.id('member');
delete from auth.sessions where user_id=pg_temp.id('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_goals) and (select count(*)=0 from public.ff_member_weights),'Revoked session cannot read retained rows');
select pg_temp.denied($q$select pg_temp.run('{"action":"read"}')$q$,'Revoked session private read denied');
select pg_temp.denied($q$select pg_temp.run(pg_temp.goal('attendance',null,null))$q$,'Revoked session goal write denied');
reset role;

select pg_temp.as_user('admin');set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',pg_temp.id('other'),'expired','[]'::jsonb));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('other')) and not exists(select 1 from public.ff_member_goals where member_id=pg_temp.id('other')) and not exists(select 1 from public.ff_member_weights where member_id=pg_temp.id('other')),'Existing authorized never-paid account cleanup cascades goals and measurements');
select pg_temp.ok(has_table_privilege('authenticated','public.ff_member_goals','select') and not has_table_privilege('authenticated','public.ff_member_goals','insert,update,delete') and has_table_privilege('authenticated','public.ff_member_weights','select') and not has_table_privilege('authenticated','public.ff_member_weights','insert,update,delete'),'Authenticated table grants are SELECT only');
select pg_temp.ok(has_function_privilege('authenticated','public.ff_member_progress(jsonb)','execute') and not has_function_privilege('anon','public.ff_member_progress(jsonb)','execute') and not has_function_privilege('service_role','public.ff_member_progress(jsonb)','execute'),'Only authenticated callers receive progress RPC grant');
select pg_temp.ok((select count(*)=2 and bool_and(relrowsecurity) from pg_class where oid in ('public.ff_member_goals'::regclass,'public.ff_member_weights'::regclass)),'Both private tables enable RLS');
select count(*) as passed from mp_log;
rollback;
