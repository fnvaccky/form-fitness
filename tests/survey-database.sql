-- Task 11: the member fitness survey. Ported from a classmate's survey work (fitness-survey-update.zip,
-- tests/survey-database.sql) onto the current schema, plus the desk path and the account clean-up.
-- Local fixtures only; everything, including Auth rows, rolls back. No emails or payments.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table sv_log(label text);
grant select,insert on sv_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into sv_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.fails_with(statement text,expected text,label text) returns void language plpgsql as $$
declare msg text:='(no error raised)';
begin begin execute statement; exception when others then msg:=sqlerrm; end; perform pg_temp.ok(position(expected in msg)=1,label||' ['||msg||']'); end $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('sv.ids')::jsonb->>k,'role','authenticated','session_id',current_setting('sv.ids')::jsonb->>(k||'Session'))::text,true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('sv.ids')::jsonb->>k)::uuid $$;
select set_config('sv.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['member','memberSession','other','otherSession','staff','staffSession','admin','adminSession',
 'foreign','foreignSession','desk','deskSession','deskstaff','neverpaid','bad']) k)::text,true);
-- Accounts the way the app makes them: production member, other member, staff and admin, and a demo-workspace member.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'sv-'||k||'@example.invalid',jsonb_build_object('ff_workspace',case when k='foreign' then 'demo' else 'production' end,'ff_role',case when k in ('staff','admin') then k else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Survey '||k,'phone','09170000040')
from unnest(array['member','other','staff','admin','foreign']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['member','other','staff','admin','foreign']) k;
select set_config('sv.answers','{"goal":"Build strength","experience":"returning","exercises":["strength","cardio"],"availableDays":["mon","fri"]}',true);

-- A new member has no survey, then saves and replaces their own answers.
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_surveys),'A new member has no survey yet');
select public.ff_save_member_survey(current_setting('sv.answers')::jsonb);
select pg_temp.ok((select count(*)=1 from public.ff_member_surveys),'The member reads their saved survey');
select pg_temp.ok((select goal='Build strength' from public.ff_profiles where id=auth.uid()),'Saving keeps the profile goal in step');
select public.ff_save_member_survey(current_setting('sv.answers')::jsonb || '{"experience":"regular","availableDays":["tue"]}');
select pg_temp.ok((select count(*)=1 and bool_and(experience='regular' and available_days=array['tue']) from public.ff_member_surveys),'Saving again updates the one survey');
select pg_temp.denied($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb || jsonb_build_object('memberId',pg_temp.id('other')))$q$,'A member cannot save for someone else');
select pg_temp.denied($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb || '{"workspace":"demo"}')$q$,'A member cannot choose the workspace');
select pg_temp.denied('update public.ff_member_surveys set experience=''beginner''','Direct survey updates are refused');
select pg_temp.denied('delete from public.ff_member_surveys','Direct survey deletes are refused');
select pg_temp.denied($q$insert into public.ff_member_surveys(id,workspace,experience,exercises,available_days) values(auth.uid(),'production','beginner',array['cardio'],array['mon'])$q$,'Direct survey inserts are refused');
do $$ declare changes jsonb; begin
 foreach changes in array array['{"goal":"unknown"}'::jsonb,'{"experience":"expert"}','{"exercises":[]}','{"exercises":null}','{"exercises":"cardio"}',
  '{"exercises":["unknown"]}','{"exercises":["cardio","cardio"]}','{"exercises":[null]}','{"availableDays":[]}','{"availableDays":["mon","mon"]}',
  '{"availableDays":["holiday"]}','{"availableDays":[null]}'] loop
  perform pg_temp.denied(format('select public.ff_save_member_survey(%L::jsonb)',current_setting('sv.answers')::jsonb || changes),'An invalid answer is refused: '||changes::text);
 end loop;
end $$;
select pg_temp.fails_with($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb || '{"exercises":[]}')$q$,'Choose at least one exercise preference.','The refusal says what to fix');
select pg_temp.denied('select public.ff_save_member_survey(null)','No answers are refused');
select pg_temp.denied($q$select public.ff_save_member_survey('[]')$q$,'Answers that are not an object are refused');
select pg_temp.ok((select experience='regular' and available_days=array['tue'] from public.ff_member_surveys),'A refused save leaves the earlier answers');
reset role;

-- The other member and the demo-workspace member save their own.
do $$ declare k text; begin
 foreach k in array array['other','foreign'] loop
  perform pg_temp.as_user(k);
  perform public.ff_save_member_survey(current_setting('sv.answers')::jsonb);
 end loop;
end $$;
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=1 and bool_and(id=auth.uid()) from public.ff_member_surveys),'A member cannot read other members'' surveys');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((select count(*)=2 from public.ff_member_surveys where id in (pg_temp.id('member'),pg_temp.id('other'),pg_temp.id('foreign'))),'Staff read their own workspace''s surveys only');
select pg_temp.fails_with($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb)$q$,'Only members can save their own survey.','Staff cannot change a member''s survey after creation');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select count(*)=2 from public.ff_member_surveys where id in (pg_temp.id('member'),pg_temp.id('other'),pg_temp.id('foreign'))),'Administrators don''t read across workspaces');
select pg_temp.fails_with($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb)$q$,'Only members can save their own survey.','Administrators cannot change a member''s survey either');
reset role;

-- A disabled member or a revoked session can neither read nor save.
update public.ff_profiles set enabled=false where id=pg_temp.id('member');
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_surveys),'A disabled member reads nothing');
select pg_temp.denied($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb)$q$,'A disabled member cannot save');
reset role;
update public.ff_profiles set enabled=true where id=pg_temp.id('member');
delete from auth.sessions where user_id=pg_temp.id('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_surveys),'A revoked session reads nothing');
select pg_temp.denied($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb)$q$,'A revoked session cannot save');
reset role;
set local role anon;
select pg_temp.denied('select * from public.ff_member_surveys','Signed-out callers cannot read surveys');
select pg_temp.denied($q$select public.ff_save_member_survey(current_setting('sv.answers')::jsonb)$q$,'Signed-out callers cannot save');
reset role;

-- At the desk: staff fill in the survey during Add member; it is saved with the account, in the same transaction.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('desk'),'sv-desk@example.invalid','{"ff_workspace":"production","ff_role":"member"}',
 '{"form_fitness":true,"name":"LOCAL TEST Survey desk","phone":"09170000041","goal":"Manage weight","survey":{"experience":"beginner","exercises":["mobility","cardio"],"availableDays":["sat","tue"]}}');
select pg_temp.ok((select s.experience='beginner' and s.exercises=array['cardio','mobility'] and s.available_days=array['tue','sat'] and s.workspace='production' and p.goal='Manage weight'
 from public.ff_member_surveys s join public.ff_profiles p on p.id=s.id where s.id=pg_temp.id('desk')),'A survey filled in at the desk is saved with the new account, in the usual order');
select pg_temp.fails_with($q$insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('bad'),'sv-bad@example.invalid','{"ff_workspace":"production","ff_role":"member"}',
 '{"form_fitness":true,"name":"LOCAL TEST Survey bad","phone":"09170000042","goal":"Manage weight","survey":{"experience":"expert","exercises":["cardio"],"availableDays":["mon"]}}')$q$,'Choose your training experience.','An invalid desk survey stops the account being created');
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('bad')) and not exists(select 1 from auth.users where id=pg_temp.id('bad')),'and leaves no account behind');
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('deskstaff'),'sv-deskstaff@example.invalid','{"ff_workspace":"production","ff_role":"staff"}',
 '{"form_fitness":true,"name":"LOCAL TEST Survey staff","phone":"09170000043","survey":{"experience":"beginner","exercises":["cardio"],"availableDays":["mon"]}}');
select pg_temp.ok(not exists(select 1 from public.ff_member_surveys where id=pg_temp.id('deskstaff')),'Only member accounts get a survey');
insert into auth.sessions(id,user_id) values(pg_temp.id('deskSession'),pg_temp.id('desk'));
select pg_temp.as_user('desk');
set local role authenticated;
select pg_temp.ok((select count(*)=1 from public.ff_member_surveys),'The member then reads the survey filled in for them');
select public.ff_save_member_survey('{"goal":"Stay consistent","experience":"regular","exercises":["group_classes"],"availableDays":["sun"]}');
select pg_temp.ok((select experience='regular' from public.ff_member_surveys),'and edits it themselves afterwards');
reset role;

-- Task 10's clean-up: deleting a never-paid account also removes its survey answers.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('neverpaid'),'sv-neverpaid@example.invalid','{"ff_workspace":"production","ff_role":"member"}',
 '{"form_fitness":true,"name":"LOCAL TEST Survey never paid","phone":"09170000044","goal":"Improve fitness","survey":{"experience":"beginner","exercises":["cardio"],"availableDays":["mon"]}}');
select pg_temp.ok(exists(select 1 from public.ff_member_surveys where id=pg_temp.id('neverpaid')),'A never-paid member with survey answers');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',pg_temp.id('neverpaid'),'expired','[]'::jsonb));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('neverpaid')) and not exists(select 1 from public.ff_member_surveys where id=pg_temp.id('neverpaid')),'Deleting a never-paid account removes its survey row');
select pg_temp.ok(exists(select 1 from pg_constraint where conrelid='public.ff_member_surveys'::regclass and contype='f' and confdeltype='c'),'The survey goes whenever its profile does');

-- Grants: members save through the function only; the internal checks are nobody's.
select pg_temp.ok(not has_function_privilege('anon','public.ff_save_member_survey(jsonb)','execute') and has_function_privilege('authenticated','public.ff_save_member_survey(jsonb)','execute'),'Only signed-in accounts may call the save');
select pg_temp.ok(not has_function_privilege('authenticated','ff_private.survey_answers(jsonb)','execute'),'The answer check is internal');
select count(*) as passed_checks from sv_log;
rollback;
