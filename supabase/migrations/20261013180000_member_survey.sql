-- Task 11: the member fitness survey, required at first login.
--
-- Ported from a classmate's survey work (fitness-survey-update.zip, built on main ed44803: the table, its RLS,
-- ff_save_member_survey and the answer checks). The four questions are the main goal (stored in the existing
-- profile goal), training experience, exercise preferences and usual days. There is no medical data.
--
-- Changes from that version:
-- 1. A profile's survey goes when the profile does (on delete cascade), so Task 10's clean-up of a never-paid
--    account, and the test-data reset, remove it too.
-- 2. The answer checks live in ff_private.survey_answers, shared by the member's own save and the desk.
-- 3. register_auth_user (Task 10's version) also saves a survey that staff filled in at the desk during
--    Add member, in the same transaction as the account. Afterwards only the member can change it.
-- Staff and administrators read their own workspace's surveys; members read only their own.

create table public.ff_member_surveys (
 id uuid primary key,
 workspace text not null,
 experience text not null check (experience in ('beginner','returning','regular')),
 exercises text[] not null check (
  cardinality(exercises) between 1 and 4
  and array_position(exercises,null) is null
  and exercises <@ array['strength','cardio','mobility','group_classes']::text[]
 ),
 available_days text[] not null check (
  cardinality(available_days) between 1 and 7
  and array_position(available_days,null) is null
  and available_days <@ array['mon','tue','wed','thu','fri','sat','sun']::text[]
 ),
 updated_at timestamptz not null default now(),
 foreign key (workspace,id) references public.ff_profiles(workspace,id) on delete cascade
);
create index ff_member_surveys_workspace on public.ff_member_surveys(workspace);
alter table public.ff_member_surveys enable row level security;
revoke all on public.ff_member_surveys from public,anon,authenticated;
grant select on public.ff_member_surveys to authenticated;
grant all on public.ff_member_surveys to service_role;
create policy ff_member_survey_read on public.ff_member_surveys for select to authenticated
 using (workspace=(select ff_private.workspace()) and (id=(select auth.uid()) or (select ff_private.is_gym_staff())));

-- The four answers, checked and put in their usual order. Keep in step with src/survey.js and the forms.
create function ff_private.survey_answers(body jsonb,out goal text,out experience text,out exercises text[],out available_days text[])
language plpgsql stable set search_path='' as $$
begin
 if body is null or jsonb_typeof(body)<>'object' or (body-array['goal','experience','exercises','availableDays'])<>'{}'::jsonb then
  raise exception 'Send only your survey answers.';
 end if;
 if coalesce(body->>'goal','') not in ('Improve fitness','Build strength','Stay consistent','Manage weight') then raise exception 'Choose your main fitness goal.'; end if;
 if coalesce(body->>'experience','') not in ('beginner','returning','regular') then raise exception 'Choose your training experience.'; end if;
 if jsonb_typeof(body->'exercises') is distinct from 'array' or jsonb_typeof(body->'availableDays') is distinct from 'array' then
  raise exception 'Choose your exercise preferences and available days.';
 end if;
 select array_agg(value order by ord) into exercises from jsonb_array_elements_text(body->'exercises') with ordinality as choices(value,ord);
 select array_agg(value order by ord) into available_days from jsonb_array_elements_text(body->'availableDays') with ordinality as choices(value,ord);
 if coalesce(cardinality(exercises),0) not between 1 and 4 or array_position(exercises,null) is not null
  or not (exercises <@ array['strength','cardio','mobility','group_classes']::text[])
  or cardinality(exercises)<>(select count(distinct value) from unnest(exercises) as x(value)) then
  raise exception 'Choose at least one exercise preference.';
 end if;
 if coalesce(cardinality(available_days),0) not between 1 and 7 or array_position(available_days,null) is not null
  or not (available_days <@ array['mon','tue','wed','thu','fri','sat','sun']::text[])
  or cardinality(available_days)<>(select count(distinct value) from unnest(available_days) as x(value)) then
  raise exception 'Choose at least one day you are usually available.';
 end if;
 goal:=body->>'goal';experience:=body->>'experience';
 exercises:=array(select x from unnest(array['strength','cardio','mobility','group_classes']) x where x=any(exercises));
 available_days:=array(select x from unnest(array['mon','tue','wed','thu','fri','sat','sun']) x where x=any(available_days));
end $$;

-- A member saves their own answers; the member and workspace come from their signed-in, enabled profile.
create function public.ff_save_member_survey(body jsonb) returns public.ff_member_surveys
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles:=ff_private.actor(); ans record; saved public.ff_member_surveys;
begin
 if a.id is null or a.role<>'member' then raise exception 'Only members can save their own survey.' using errcode='42501'; end if;
 select * into ans from ff_private.survey_answers(body);
 update public.ff_profiles set goal=ans.goal where id=a.id and workspace=a.workspace and enabled and role='member';
 if not found then raise exception 'Member access is required.' using errcode='42501'; end if;
 insert into public.ff_member_surveys(id,workspace,experience,exercises,available_days)
  values(a.id,a.workspace,ans.experience,ans.exercises,ans.available_days)
 on conflict(id) do update set experience=excluded.experience,exercises=excluded.exercises,available_days=excluded.available_days,updated_at=now()
 returning * into saved;
 return saved;
end $$;

-- register_auth_user: Task 10's version, plus the desk survey (marked "Task 11").
create or replace function ff_private.register_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb; w text; r text; phone text; u auth.users; reg public.ff_registrations; membership uuid; invoice uuid; payment uuid; ans record;
begin
 select * into u from auth.users where id=new.id;
 d:=u.raw_user_meta_data;
 if coalesce(d->>'form_fitness','')<>'true' then return new; end if;
 if u.raw_app_meta_data ? 'ff_registration' then
  select * into reg from public.ff_registrations where id=(u.raw_app_meta_data->>'ff_registration')::uuid for update;
  if not found or reg.status<>'paid' or reg.member_id is not null or lower(u.email)<>reg.email or reg.workspace not in ('production','demo') or u.raw_app_meta_data->>'ff_workspace' is distinct from reg.workspace then raise exception 'A fully paid registration is required before account creation.'; end if;
  -- One email, one account: nothing but this registration may use the address.
  perform ff_private.claim_email(u.email,reg.id,u.id);
  insert into public.ff_profiles(id,workspace,role,name,email,phone,goal) values(u.id,reg.workspace,'member',reg.name,reg.email,reg.phone,reg.goal);
  insert into public.ff_memberships(workspace,member_id,plan_id,start_date,end_date) values(reg.workspace,u.id,reg.plan_id,reg.start_date,reg.end_date) returning id into membership;
  insert into public.ff_invoices(workspace,member_id,membership_id,amount_cents,paid_cents) values(reg.workspace,u.id,membership,reg.amount_cents,reg.amount_cents) returning id into invoice;
  insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,payment_date,recorded_by)
  values(reg.workspace,u.id,invoice,reg.amount_cents,reg.payment_method,reg.payment_reference,case when reg.payment_method='Cash' then 'CASH:'||reg.payment_request else 'PAYMONGO:'||reg.payment_reference end,reg.payment_request,(reg.paid_at at time zone 'Asia/Manila')::date,reg.paid_by) returning id into payment;
  update public.ff_registrations set status='provisioned',member_id=u.id where id=reg.id;
  perform ff_private.notify(reg.workspace,u.id,'RepReady payment confirmed','Your first membership payment was confirmed. Your account setup email follows separately.','payment:'||payment);
  return new;
 end if;

 if coalesce(u.raw_app_meta_data->>'ff_workspace','') not in ('production','demo') then raise exception 'First membership accounts require paid registration.'; end if;
 -- One email, one account, for every staff, admin, seed or script account as well.
 perform ff_private.claim_email(u.email,null,u.id);
 w:=case when u.raw_app_meta_data->>'ff_workspace'='demo' then 'demo' else 'production' end;
 r:=case when u.raw_app_meta_data->>'ff_role'='admin' then 'admin'
         when u.raw_app_meta_data->>'ff_role'='staff' then 'staff'
         else 'member' end;
 phone:=regexp_replace(coalesce(d->>'phone',''),'[ ()-]','','g');
 if phone like '+63%' then phone:='0'||substring(phone from 4); end if;
 insert into public.ff_profiles(id,workspace,role,name,email,phone,goal)
 values(u.id,w,r,trim(d->>'name'),lower(u.email),phone,left(coalesce(nullif(trim(d->>'goal'),''),'Improve fitness'),100));
 -- Task 11: a fitness survey filled in at the desk during Add member is saved with the account, in this
 -- transaction. Its goal is the profile goal as stored; an invalid survey stops the account being created.
 if r='member' and d ? 'survey' then
  select * into ans from ff_private.survey_answers(jsonb_build_object('goal',left(coalesce(nullif(trim(d->>'goal'),''),'Improve fitness'),100))||coalesce(d->'survey','null'::jsonb));
  insert into public.ff_member_surveys(id,workspace,experience,exercises,available_days) values(u.id,w,ans.experience,ans.exercises,ans.available_days);
 end if;
 if r='member' and nullif(trim(coalesce(d->>'plan','')),'') is not null then perform ff_private.new_membership(w,u.id,d->>'plan',(d->>'start')::date); end if;
 return new;
end $$;

revoke all on function ff_private.survey_answers(jsonb) from public,anon,authenticated;
revoke all on function public.ff_save_member_survey(jsonb) from public,anon,authenticated;
grant execute on function public.ff_save_member_survey(jsonb) to authenticated;
NOTIFY pgrst, 'reload schema';
