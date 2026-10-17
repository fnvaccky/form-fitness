-- Task 12B: plan recommendations and the record of recommended against chosen, in the database. Local fixtures only;
-- everything, including the Auth rows, rolls back. PayMongo is never called: its settlement is simulated the way the
-- webhook calls it, as service_role.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table rc_log(label text);
grant select,insert on rc_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into rc_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.fails_with(statement text,expected text,label text) returns void language plpgsql as $$
declare msg text:='(no error raised)';
begin begin execute statement; exception when others then msg:=sqlerrm; end; perform pg_temp.ok(position(expected in msg)=1,label||' ['||msg||']'); end $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('rc.ids')::jsonb->>k)::uuid $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id(k),'role','authenticated','session_id',pg_temp.id(k||'Session'))::text,true) $$;
create function pg_temp.choices(k text) returns setof public.ff_plan_choices language sql as $$ select * from public.ff_plan_choices where member_id=pg_temp.id(k) order by created_at,id $$;
create function pg_temp.recommend(k text) returns jsonb language sql as $$ select ff_private.recommend_for('production',ff_private.member_answers('production',pg_temp.id(k))) $$;
select set_config('rc.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['staff','staffSession','admin','adminSession','demoStaff','demoStaffSession',
 'm1','m1Session','m2','m2Session','m3','m3Session','m4','m4Session','neverpaid','neverpaidSelf','neverpaidSelfSession','staff2','staff2Session','m5',
 'demoMember','reg','legacy']) k)::text,true);
select set_config('rc.today',ff_private.today()::text,true);
-- The accounts, the way the app makes them: m1, m2, m4, neverpaid and neverpaidSelf with a fitness survey filled in at
-- the desk, m3 and m5 without.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'rc-'||lower(k)||'@example.invalid',jsonb_build_object('ff_workspace',case when k like 'demo%' then 'demo' else 'production' end,
 'ff_role',case when k in ('staff','demoStaff','staff2') then 'staff' when k='admin' then 'admin' else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Recommend '||k,'phone','09170000100')||case k
  when 'm1' then '{"goal":"Build strength","survey":{"experience":"beginner","exercises":["strength"],"availableDays":["mon","thu"]}}'::jsonb
  when 'm2' then '{"goal":"Stay consistent","survey":{"experience":"regular","exercises":["group_classes"],"availableDays":["mon","tue","wed","thu","fri"]}}'::jsonb
  when 'm4' then '{"goal":"Manage weight","survey":{"experience":"returning","exercises":["cardio"],"availableDays":["sat"]}}'::jsonb
  when 'neverpaid' then '{"goal":"Improve fitness","survey":{"experience":"regular","exercises":["mobility"],"availableDays":["sun"]}}'::jsonb
  when 'neverpaidSelf' then '{"goal":"Improve fitness","survey":{"experience":"beginner","exercises":["cardio"],"availableDays":["tue"]}}'::jsonb
  when 'demoMember' then '{"goal":"Stay consistent","survey":{"experience":"beginner","exercises":["group_classes"],"availableDays":["mon"]}}'::jsonb
  else '{}'::jsonb end
from unnest(array['staff','admin','demoStaff','staff2','m1','m2','m3','m4','m5','neverpaid','neverpaidSelf','demoMember']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['staff','admin','demoStaff','staff2','m1','m2','m3','m4','neverpaidSelf']) k;

-- 1. The rules in the database -------------------------------------------------------------------------------------
select pg_temp.ok((select r->>'recommended'='elite' and r->>'status'='recommended' and r->>'ruleVersion'='12B.1'
  and r->'ranking'@>'[{"id":"elite","score":7},{"id":"basic","score":4},{"id":"plus","score":2}]' and jsonb_array_length(r->'reasons')=4
 from (select pg_temp.recommend('m1') r) x),'m1 (Build strength, new to training, strength, 2 days): Performance, 7 points, with four reasons');
select pg_temp.ok((select r->>'status'='incomplete' and r->'missing'='["experience","exercises","availableDays"]' and r->'recommended'='null' and r->'ranking'='[]'
 from (select pg_temp.recommend('m3') r) x),'m3 has no survey: no recommendation, and it says what is missing (the goal is on the profile)');
select pg_temp.ok((select ff_private.score_plans('{"goal":"Improve fitness","experience":"regular","exercises":["cardio"],"availableDays":["mon"]}','[]')->>'status'='no_plans'),'No plan available: no recommendation');

-- 2. A record for each new cycle, made in the database --------------------------------------------------------------
-- m1: staff add the plan at the desk; they choose Momentum although the rules recommend Performance.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('m1'),'plan','plus','start',current_setting('rc.today')));
reset role;
select pg_temp.ok((select count(*)=1 and bool_and(chosen_plan_id='plus' and recommended_plan_id='elite' and rule_version='12B.1' and created_by=pg_temp.id('staff')
  and membership_id=(select id from public.ff_memberships where member_id=pg_temp.id('m1')) and workspace='production')
 from pg_temp.choices('m1')),'A desk plan records the choice (Momentum), the recommendation (Performance), the rule version and who chose');
select pg_temp.ok((select recommendation->'inputs'='{"goal":"Build strength","experience":"beginner","exercises":["strength"],"availableDays":["mon","thu"],"daysPerWeek":2}'
  and recommendation->'ranking'->0->>'priceCents'='249900' and recommendation->'ranking'->0->'rules'->0->>'rule'='experience-coaching'
 from pg_temp.choices('m1')),'The record keeps the answers used and every plan''s terms and points');
-- m2 renews by themselves, choosing what the rules recommend.
select pg_temp.as_user('m2');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('plan','plus','start',current_setting('rc.today')));
reset role;
select pg_temp.ok((select count(*)=1 and bool_and(chosen_plan_id='plus' and recommended_plan_id='plus' and created_by=pg_temp.id('m2')) from pg_temp.choices('m2')),
 'A member''s own renewal records it too, by the member');
-- Walk-in cash renewal, then the same request again: one record.
select pg_temp.as_user('staff');
set local role authenticated;
select set_config('rc.walk',jsonb_build_object('memberId',pg_temp.id('m2'),'plan','basic','start',(select end_date+1 from public.ff_memberships where member_id=pg_temp.id('m2')),
 'amountCents',89900,'verified',true,'idempotencyKey',gen_random_uuid())::text,true);
select public.ff_walkin_renew(current_setting('rc.walk')::jsonb);
select public.ff_walkin_renew(current_setting('rc.walk')::jsonb);
reset role;
select pg_temp.ok((select count(*)=2 and count(*) filter (where chosen_plan_id='basic' and recommended_plan_id='plus')=1 from pg_temp.choices('m2')),
 'A walk-in renewal records its new cycle once; repeating the request adds nothing');
-- m3 has no survey: the record keeps the choice and no recommendation.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('m3'),'plan','basic','start',current_setting('rc.today')));
reset role;
select pg_temp.ok((select count(*)=1 and bool_and(chosen_plan_id='basic' and recommended_plan_id is null and recommendation->>'status'='incomplete') from pg_temp.choices('m3')),
 'Without a survey, the choice is recorded with no recommendation, none made up');
-- m4 starts an online renewal: the cycle is made at checkout. A retry, or a new request for the same renewal, and
-- paying the invoice itself make no new record.
select pg_temp.as_user('m4');
set local role authenticated;
select set_config('rc.pm',jsonb_build_object('kind','renewal','memberId',pg_temp.id('m4'),'plan','basic','start',current_setting('rc.today'),'requestId',gen_random_uuid(),
 'methods',jsonb_build_array('card'),'livemode',false)::text,true);
select set_config('rc.checkout',public.ff_paymongo_prepare(current_setting('rc.pm')::jsonb)->'checkout'->>'id',true);
select public.ff_paymongo_prepare(current_setting('rc.pm')::jsonb);
reset role;
update public.ff_checkouts set status='expired' where id=current_setting('rc.checkout')::uuid;
select pg_temp.as_user('m4');
set local role authenticated;
select set_config('rc.checkout',public.ff_paymongo_prepare(current_setting('rc.pm')::jsonb||jsonb_build_object('requestId',gen_random_uuid()))->'checkout'->>'id',true);
reset role;
update public.ff_checkouts set status='expired' where id=current_setting('rc.checkout')::uuid;
select pg_temp.as_user('m4');
set local role authenticated;
select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',(select id from public.ff_invoices where member_id=pg_temp.id('m4')),'requestId',gen_random_uuid(),
 'methods',jsonb_build_array('card'),'livemode',false));
reset role;
-- m4 (Manage weight, getting back into training, cardio, 1 day): Momentum 5 points, Essential 4; m4 chose Essential.
select pg_temp.ok((select count(*)=1 and bool_and(chosen_plan_id='basic' and recommended_plan_id='plus' and created_by=pg_temp.id('m4')) from pg_temp.choices('m4')),
 'An online renewal records its cycle once: a retry, a new request for the same renewal and an invoice checkout add nothing');
-- Paying an existing invoice in cash at the desk adds nothing either.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',(select id from public.ff_invoices where member_id=pg_temp.id('m1')),'amountCents',149900,'method','Cash',
 'verified',true,'idempotencyKey',gen_random_uuid()));
reset role;
select pg_temp.ok((select count(*)=1 from pg_temp.choices('m1')),'Paying an invoice is not a new choice');
-- A first registration is recorded when it is made (no account or survey yet, so no recommendation); completing it
-- creates the cycle without a second record.
select pg_temp.as_user('staff');
set local role authenticated;
select set_config('rc.registration',(public.ff_registration('create',jsonb_build_object('requestId',pg_temp.id('reg'),'name','LOCAL TEST Recommend registration',
 'email','rc-registration@example.invalid','phone','09170000101','plan','elite','start',current_setting('rc.today')))->>'id'),true);
select public.ff_registration('create',jsonb_build_object('requestId',pg_temp.id('reg'),'name','LOCAL TEST Recommend registration',
 'email','rc-registration@example.invalid','phone','09170000101','plan','elite','start',current_setting('rc.today')));
select public.ff_registration('cash',jsonb_build_object('id',current_setting('rc.registration'),'amountCents',249900,'method','Cash','verified',true,'emailConfirmed',true,'idempotencyKey',gen_random_uuid()));
reset role;
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('legacy'),'rc-registration@example.invalid',
 jsonb_build_object('ff_registration',current_setting('rc.registration'),'ff_workspace','production','ff_role','member'),'{"form_fitness":true}');
select pg_temp.ok((select count(*)=1 and bool_and(chosen_plan_id='elite' and recommended_plan_id is null and member_id is null and created_by=pg_temp.id('staff')
  and recommendation->'missing'='["experience","exercises","availableDays"]')
 from public.ff_plan_choices where registration_id=current_setting('rc.registration')::uuid),
 'A first registration is recorded once, a retry adding nothing; it has the goal given at the desk but no survey, so no recommendation');
select pg_temp.ok((select count(*)=0 from public.ff_plan_choices where member_id=pg_temp.id('legacy')),'and completing it creates the cycle without a second record');
-- Later survey and catalog edits leave every record as it was, still explaining itself.
create temporary table rc_before as select id,recommendation,recommended_plan_id,chosen_plan_id from public.ff_plan_choices;
update public.ff_member_surveys set experience='regular',exercises=array['cardio'],updated_at=now() where id=pg_temp.id('m1');
update public.ff_profiles set goal='Manage weight' where id=pg_temp.id('m1');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',(select jsonb_build_object('id',id,'name',name,'priceCents',259900,'days',days,'description',description,'features',features,
 'available',available,'coaching',coaching,'coachSessions',coach_sessions,'focusTags',to_jsonb(focus_tags)) from public.ff_plans where workspace='production' and id='elite'));
reset role;
select pg_temp.ok((select count(*)=0 from rc_before b join public.ff_plan_choices c using (id) where c.recommendation is distinct from b.recommendation
 or c.recommended_plan_id is distinct from b.recommended_plan_id or c.chosen_plan_id is distinct from b.chosen_plan_id),'Survey and catalog edits change no record');
select pg_temp.ok((select pg_temp.recommend('m1')->>'recommended'<>'elite'),'while a new recommendation for m1 now follows the new answers');
-- Purchased snapshots: recording changed no cycle's terms.
select pg_temp.ok((select count(*)=0 from public.ff_memberships where terms is null) and (select bool_and(terms->>'source' in ('purchase','registration')) from public.ff_memberships
 where member_id in (pg_temp.id('m1'),pg_temp.id('m2'),pg_temp.id('m3'),pg_temp.id('m4'),pg_temp.id('legacy'))),'Every new cycle still has its purchased terms');

-- 3. Who can read and change the records ----------------------------------------------------------------------------
select pg_temp.as_user('demoStaff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('demoMember'),'plan','plus','start',current_setting('rc.today')));
select pg_temp.ok((select count(*)=1 and bool_and(workspace='demo') from public.ff_plan_choices where member_id in (pg_temp.id('demoMember'),pg_temp.id('m1'))),
 'Demo staff read their own workspace''s records only');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((select count(*)=6 from public.ff_plan_choices where member_id in (pg_temp.id('m1'),pg_temp.id('m2'),pg_temp.id('m3'),pg_temp.id('m4'),pg_temp.id('demoMember'))
  or registration_id=current_setting('rc.registration')::uuid),'Staff read their workspace''s records (5 cycles and a registration), not demo''s');
select pg_temp.denied($q$insert into public.ff_plan_choices(workspace,member_id,membership_id,chosen_plan_id,rule_version,recommendation) values('production',pg_temp.id('m3'),gen_random_uuid(),'basic','x','{"status":"incomplete"}')$q$,'Staff cannot write a record');
select pg_temp.denied($q$update public.ff_plan_choices set recommended_plan_id='elite' where member_id=pg_temp.id('m3')$q$,'nor change one');
select pg_temp.denied($q$delete from public.ff_plan_choices where member_id=pg_temp.id('m3')$q$,'nor delete one');
reset role;
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.ok((select count(*)=6 from public.ff_plan_choices where member_id in (pg_temp.id('m1'),pg_temp.id('m2'),pg_temp.id('m3'),pg_temp.id('m4'),pg_temp.id('demoMember'))
  or registration_id=current_setting('rc.registration')::uuid),'Administrators read the same');
reset role;
select pg_temp.as_user('m1');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_plan_choices),'A member reads no records, not even their own');
select pg_temp.denied($q$select public.score_plans('{}','[]')$q$,'and cannot call the rules directly');
reset role;
set local role anon;
select pg_temp.denied('select * from public.ff_plan_choices','Signed-out callers cannot read the records');
reset role;
select pg_temp.fails_with($q$update public.ff_plan_choices set rule_version='x' where member_id=pg_temp.id('m3')$q$,'This log is append-only.','Not even the database owner changes a record');

-- 4. Never-paid account clean-up still works, and takes the account's records with it ---------------------------------
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('neverpaid'),'plan','basic','start',current_setting('rc.today')));
reset role;
select pg_temp.ok((select count(*)=1 from pg_temp.choices('neverpaid')),'A never-paid account has a record');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',pg_temp.id('neverpaid'),'expired','[]'::jsonb));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('neverpaid')) and not exists(select 1 from public.ff_plan_choices where member_id=pg_temp.id('neverpaid')),
 'Clean-up deletes the account, and its record goes with it');
-- A never-paid member who chose a plan by themselves created their own record; clean-up still deletes them.
select pg_temp.as_user('neverpaidSelf');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('plan','plus','start',current_setting('rc.today')));
reset role;
select pg_temp.ok((select count(*)=1 and bool_and(created_by=pg_temp.id('neverpaidSelf')) from pg_temp.choices('neverpaidSelf')),'A never-paid member''s own choice is recorded, by them');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_account_cleanup('delete',jsonb_build_object('id',pg_temp.id('neverpaidSelf'),'expired','[]'::jsonb));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_profiles where id=pg_temp.id('neverpaidSelf')) and not exists(select 1 from public.ff_plan_choices where created_by=pg_temp.id('neverpaidSelf')),
 'Clean-up deletes that account too, with the record it created');
-- The foreign keys: cycles, registrations and accounts take their records with them; plans and creators are plain references.
select pg_temp.ok((select jsonb_object_agg(conname,confdeltype) from pg_constraint where conrelid='public.ff_plan_choices'::regclass and contype='f')=
 '{"ff_plan_choices_registration_id_fkey":"c","ff_plan_choices_workspace_member_id_fkey":"c","ff_plan_choices_workspace_membership_id_fkey":"c",
   "ff_plan_choices_workspace_chosen_plan_id_fkey":"a","ff_plan_choices_workspace_recommended_plan_id_fkey":"a","ff_plan_choices_created_by_fkey":"a"}',
 'Foreign keys: cascade from the cycle, the registration and the member; no action from the plans and the creator');
-- staff2 only adds a plan for m5. Like a payment's recorder, an account that created records can't be deleted while they exist.
select pg_temp.as_user('staff2');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('m5'),'plan','basic','start',current_setting('rc.today')));
reset role;
select pg_temp.fails_with(format('delete from public.ff_profiles where id=%L',pg_temp.id('staff2')),
 'update or delete on table "ff_profiles" violates foreign key constraint "ff_plan_choices_created_by_fkey"','Deleting the staff account that created a record is refused by its foreign key');
select pg_temp.ok((select count(*)=1 and bool_and(created_by=pg_temp.id('staff2') and recommendation->>'status'='incomplete') from pg_temp.choices('m5')),'and the record stays as it was');

-- 5. Grants -----------------------------------------------------------------------------------------------------------
select pg_temp.ok(not has_table_privilege('anon','public.ff_plan_choices','select') and has_table_privilege('authenticated','public.ff_plan_choices','select')
 and not has_table_privilege('authenticated','public.ff_plan_choices','insert') and not has_table_privilege('authenticated','public.ff_plan_choices','update')
 and not has_table_privilege('authenticated','public.ff_plan_choices','delete') and has_table_privilege('service_role','public.ff_plan_choices','select')
 and not has_table_privilege('service_role','public.ff_plan_choices','insert'),'Signed-in accounts and the server may only read the records (and RLS limits who)');
select pg_temp.ok((select not bool_or(has_function_privilege(r,f,'execute')) from unnest(array['ff_private.score_plans(jsonb,jsonb)','ff_private.member_answers(text,uuid)',
 'ff_private.recommend_for(text,jsonb)','ff_private.record_plan_choice()']) f cross join unnest(array['anon','authenticated']) r),'The rules and the recorder are internal');
select pg_temp.ok((select relrowsecurity from pg_class where oid='public.ff_plan_choices'::regclass),'Row level security is on');
select count(*) as passed_checks from rc_log;
rollback;
