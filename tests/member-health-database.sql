-- Isolated local fixtures only. All auth/profile/health writes and cleanup roll back; no payment or email.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table mh_log(label text);
grant select,insert on mh_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into mh_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('mh.ids')::jsonb->>k,'role','authenticated','session_id',current_setting('mh.ids')::jsonb->>(k||'Session'))::text,true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('mh.ids')::jsonb->>k)::uuid $$;
select set_config('mh.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['member','memberSession','other','otherSession','staff','staffSession','admin','adminSession','foreign','foreignSession']) k)::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'mh-'||k||'-'||pg_temp.id(k)::text||'@example.invalid',
 jsonb_build_object('ff_workspace',case when k='foreign' then 'demo' else 'production' end,'ff_role',case when k in ('staff','admin') then k else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Health '||k,'phone','09170000055','goal','Improve fitness')
from unnest(array['member','other','staff','admin','foreign']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['member','other','staff','admin','foreign']) k;
select set_config('mh.answers','{"heightCm":170.5,"weightKg":65.2,"ageBand":"20plus","conditions":["diabetes","asthma"]}',true);
select pg_temp.ok(not exists(select 1 from public.ff_member_health where id in (pg_temp.id('member'),pg_temp.id('other'),pg_temp.id('foreign'))),'Creating accounts does not backfill optional health information');

select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'New member starts without health answers');
select public.ff_save_member_health(current_setting('mh.answers')::jsonb);
select pg_temp.ok((select count(*)=1 and bool_and(id=auth.uid() and height_cm=170.5 and weight_kg=65.2 and age_band='20plus' and conditions=array['asthma','diabetes']) from public.ff_member_health),'Owner saves and reads canonical health answers');
select public.ff_save_member_health('{"heightCm":50,"weightKg":10,"ageBand":"under20","conditions":["none"]}');
select pg_temp.ok((select height_cm=50 and weight_kg=10 and age_band='under20' and conditions=array['none'] from public.ff_member_health),'Minimum measurements and under-20 group are accepted');
select public.ff_save_member_health('{"heightCm":250,"weightKg":500,"ageBand":"prefer_not","conditions":["prefer_not"]}');
select pg_temp.ok((select height_cm=250 and weight_kg=500 and age_band='prefer_not' and conditions=array['prefer_not'] from public.ff_member_health),'Maximum measurements and declined answers are accepted');
select public.ff_save_member_health('{"heightCm":null,"weightKg":null,"ageBand":null,"conditions":[]}');
select pg_temp.ok((select height_cm is null and weight_kg is null and age_band is null and conditions='{}' from public.ff_member_health),'Explicit nulls and empty list clear all optional fields');
select public.ff_save_member_health(current_setting('mh.answers')::jsonb);
select pg_temp.denied('update public.ff_member_health set height_cm=180','Direct updates are denied');
select pg_temp.denied('delete from public.ff_member_health','Direct deletes are denied');
select pg_temp.denied($q$insert into public.ff_member_health(id,workspace) values(auth.uid(),'production')$q$,'Direct inserts are denied');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb||jsonb_build_object('memberId',pg_temp.id('other')))$q$,'Member cannot choose another owner');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb||'{"workspace":"demo"}')$q$,'Member cannot choose workspace');
do $$ declare change jsonb; begin
 foreach change in array array[
  '{"heightCm":49.9}'::jsonb,'{"heightCm":250.1}','{"heightCm":170.55}','{"heightCm":"170.5"}','{"heightCm":true}',
  '{"weightKg":9.9}','{"weightKg":500.1}','{"weightKg":65.25}','{"weightKg":"65.2"}',
  '{"ageBand":"adult"}','{"ageBand":20}','{"conditions":null}','{"conditions":"none"}',
  '{"conditions":["none","asthma"]}','{"conditions":["prefer_not","none"]}','{"conditions":["other","prefer_not"]}',
  '{"conditions":["asthma","asthma"]}','{"conditions":["unknown"]}','{"conditions":[null]}','{"conditions":[true]}',
  '{"conditions":[{"other":"text"}]}','{"bmi":22}','{"diagnosis":"free text"}','{"dateOfBirth":"2000-01-01"}'
 ] loop
  perform pg_temp.denied(format('select public.ff_save_member_health(%L::jsonb)',current_setting('mh.answers')::jsonb||change),'Invalid health payload refused');
 end loop;
end $$;
select pg_temp.denied('select public.ff_save_member_health(null)','Null request refused');
select pg_temp.denied($q$select public.ff_save_member_health('[]')$q$,'Non-object request refused');
select pg_temp.denied($q$select public.ff_save_member_health('{}')$q$,'Missing fields refused');
select pg_temp.denied($q$select public.ff_save_member_health('{"heightCm":null,"weightKg":null,"conditions":[]}')$q$,'Partial replacement refused');
select pg_temp.ok((select height_cm=170.5 and weight_kg=65.2 and conditions=array['asthma','diabetes'] from public.ff_member_health),'Refused requests preserve saved answers');
select pg_temp.ok((select goal='Improve fitness' from public.ff_profiles where id=auth.uid()),'Saving optional health never changes the profile goal');
select pg_temp.ok((select count(*)=0 from public.ff_member_surveys where id=auth.uid()),'Saving optional health never creates or changes the fitness survey');
reset role;

do $$ declare k text; begin
 foreach k in array array['other','foreign'] loop perform pg_temp.as_user(k); perform public.ff_save_member_health(current_setting('mh.answers')::jsonb); end loop;
end $$;
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=1 and bool_and(id=auth.uid()) from public.ff_member_health),'Member cannot read another member or workspace health');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'Staff cannot read any health answers');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Staff cannot save health answers');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'Administrators cannot read any health answers');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Administrators cannot save health answers');
reset role;
set local role anon;
select pg_temp.denied('select * from public.ff_member_health','Signed-out caller cannot read health');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Signed-out caller cannot save health');
reset role;

-- The role is checked as well as ownership, including a former member's own retained row.
update public.ff_profiles set role='staff' where id=pg_temp.id('other');
select pg_temp.as_user('other');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'A role-changed staff account cannot read its former member health row');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Role-changed staff cannot save');
reset role;
update public.ff_profiles set role='member' where id=pg_temp.id('other');
update public.ff_profiles set enabled=false where id=pg_temp.id('member');
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'Disabled member cannot read health');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Disabled member cannot save');
reset role;
update public.ff_profiles set enabled=true where id=pg_temp.id('member');
delete from auth.sessions where user_id=pg_temp.id('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_member_health),'Revoked session cannot read health');
select pg_temp.denied($q$select public.ff_save_member_health(current_setting('mh.answers')::jsonb)$q$,'Revoked session cannot save');
reset role;

-- Constraints independently guard stored data; all member writes still go through the validated RPC.
select pg_temp.denied($q$update public.ff_member_health set height_cm=170.55 where id=pg_temp.id('other')$q$,'Height precision constraint enforced');
select pg_temp.denied($q$update public.ff_member_health set weight_kg=501 where id=pg_temp.id('other')$q$,'Weight bounds constraint enforced');
select pg_temp.denied($q$update public.ff_member_health set age_band='unknown' where id=pg_temp.id('other')$q$,'Age group constraint enforced');
select pg_temp.denied($q$update public.ff_member_health set conditions=array['none','asthma'] where id=pg_temp.id('other')$q$,'Condition exclusivity constraint enforced');
select pg_temp.denied($q$update public.ff_member_health set conditions=array['unknown'] where id=pg_temp.id('other')$q$,'Condition allowlist constraint enforced');

select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',pg_temp.id('other'),'expired','[]'::jsonb));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('other')) and not exists(select 1 from public.ff_member_health where id=pg_temp.id('other')),'Existing never-paid account cleanup cascades optional health data');
select pg_temp.ok(exists(select 1 from pg_constraint where conrelid='public.ff_member_health'::regclass and contype='f' and confdeltype='c'),'Health profile foreign key cascades');
select pg_temp.ok(has_table_privilege('authenticated','public.ff_member_health','select') and not has_table_privilege('authenticated','public.ff_member_health','insert,update,delete'),'Authenticated table access is SELECT only');
select pg_temp.ok(not has_table_privilege('anon','public.ff_member_health','select,insert,update,delete') and not has_table_privilege('service_role','public.ff_member_health','select,insert,update,delete'),'No anonymous or service role health table grants');
select pg_temp.ok(has_function_privilege('authenticated','public.ff_save_member_health(jsonb)','execute') and not has_function_privilege('anon','public.ff_save_member_health(jsonb)','execute') and not has_function_privilege('service_role','public.ff_save_member_health(jsonb)','execute'),'Only authenticated role can invoke health save');
select pg_temp.ok((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.ff_save_member_health(jsonb)'::regprocedure),'Save has a controlled empty search path');
select pg_temp.ok((select relrowsecurity from pg_class where oid='public.ff_member_health'::regclass),'Health table RLS enabled');
select pg_temp.ok((select array_agg(column_name::text order by ordinal_position)=array['id','workspace','height_cm','weight_kg','age_band','conditions','updated_at'] from information_schema.columns where table_schema='public' and table_name='ff_member_health'),'Storage includes no BMI, date of birth or free-text medical fields');
select count(*) as passed_checks from mh_log;
rollback;
