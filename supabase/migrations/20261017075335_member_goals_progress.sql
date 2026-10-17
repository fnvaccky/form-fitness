-- Member-private tracking only. No backfill, health-profile changes or shared command replacement.
-- A goal revision snapshots confirmed settings. Editing/status changes close it and append a revision;
-- starting a new goal begins a new period. Dated measurements remain independent of all goal periods.
create table public.ff_member_goals (
 id uuid primary key default gen_random_uuid(),
 workspace text not null,
 member_id uuid not null,
 period_id uuid not null,
 request_id uuid not null,
 request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
 goal_type text not null check (goal_type in ('lose','gain','maintain','attendance')),
 status text not null check (status in ('active','paused')),
 start_date date not null,
 starting_weight_kg numeric check (starting_weight_kg between 10 and 500 and starting_weight_kg*10=trunc(starting_weight_kg*10)),
 measurement_date date,
 target_weight_kg numeric check (target_weight_kg between 10 and 500 and target_weight_kg*10=trunc(target_weight_kg*10)),
 recorded_at timestamptz not null default clock_timestamp(),
 ended_at timestamptz check (ended_at>=recorded_at),
 foreign key (workspace,member_id) references public.ff_profiles(workspace,id) on delete cascade,
 unique (workspace,member_id,request_id),
 check ((goal_type='attendance' and starting_weight_kg is null and measurement_date is null and target_weight_kg is null)
  or (goal_type<>'attendance' and starting_weight_kg is not null and measurement_date is not null and measurement_date<=start_date
   and (target_weight_kg is null or (goal_type='lose' and target_weight_kg<starting_weight_kg) or (goal_type='gain' and target_weight_kg>starting_weight_kg))))
);
create unique index ff_member_goals_one_current on public.ff_member_goals(workspace,member_id) where ended_at is null;
create index ff_member_goals_owner_history on public.ff_member_goals(workspace,member_id,recorded_at);

create table public.ff_member_weights (
 id uuid primary key default gen_random_uuid(),
 workspace text not null,
 member_id uuid not null,
 measured_on date not null,
 weight_kg numeric not null check (weight_kg between 10 and 500 and weight_kg*10=trunc(weight_kg*10)),
 recorded_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key (workspace,member_id) references public.ff_profiles(workspace,id) on delete cascade,
 unique (workspace,member_id,measured_on)
);
alter table public.ff_member_goals enable row level security;
alter table public.ff_member_weights enable row level security;
revoke all on public.ff_member_goals,public.ff_member_weights from public,anon,authenticated,service_role;
grant select on public.ff_member_goals,public.ff_member_weights to authenticated;
create policy ff_member_goals_owner_read on public.ff_member_goals for select to authenticated
 using (workspace=(select ff_private.workspace()) and member_id=(select auth.uid()) and (select (ff_private.actor()).role)='member');
create policy ff_member_weights_owner_read on public.ff_member_weights for select to authenticated
 using (workspace=(select ff_private.workspace()) and member_id=(select auth.uid()) and (select (ff_private.actor()).role)='member');

-- The enabled, still-valid session supplies identity and workspace. No caller-selected identity is accepted.
-- SELECT-only tables prevent bypass of the validation, explicit edit and history rules below.
create function public.ff_member_progress(body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles:=ff_private.actor(); current_goal public.ff_member_goals; previous_request public.ff_member_goals;
 op text; expected_id uuid; request_key uuid; row_id uuid; kind text; state text; starts date; measured date;
 starting numeric; target numeric; weight numeric; saved_weight numeric; period uuid; allowed text[];
begin
 if a.id is null or a.role<>'member' then raise exception 'Member progress requires an enabled member session.' using errcode='42501'; end if;
 if body is null or jsonb_typeof(body)<>'object' or jsonb_typeof(body->'action') is distinct from 'string' then raise exception 'Send a valid progress action.'; end if;
 op:=body->>'action';
 allowed:=case
  when op='read' then array['action']
  when op in ('save_goal','new_goal') then array['action','requestId','goalId','goalType','startDate','startingWeightKg','measurementDate','targetWeightKg']
  when op in ('pause_goal','resume_goal') then array['action','requestId','goalId']
  when op='add_weight' then array['action','date','weightKg']
  when op='update_weight' then array['action','id','date','weightKg']
  when op='delete_weight' then array['action','id'] end;
 if allowed is null or not (body ?& allowed) or (body-allowed)<>'{}'::jsonb then raise exception 'Send only the fields for this progress action.'; end if;
 if op='read' then return jsonb_build_object('ok',true); end if;
 -- Serialize concurrent owner writes, including different tabs and lifecycle retries.
 perform 1 from public.ff_profiles where id=a.id and workspace=a.workspace and enabled and role='member' for update;
 if not found then raise exception 'Member access is required.' using errcode='42501'; end if;
 if op in ('save_goal','new_goal','pause_goal','resume_goal') then
  if jsonb_typeof(body->'requestId') is distinct from 'string' or (body->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(body->'goalId') not in ('string','null') then raise exception 'Use a valid goal request and current goal.'; end if;
  request_key:=(body->>'requestId')::uuid;
  if body->>'goalId' is not null and (body->>'goalId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Use a valid current goal.'; end if;
  expected_id:=(body->>'goalId')::uuid;
  select * into previous_request from public.ff_member_goals where workspace=a.workspace and member_id=a.id and request_id=request_key;
  if found then
   if previous_request.request_hash<>md5(body::text) then raise exception 'This request already saved different goal settings. Reload progress before saving again.'; end if;
   return jsonb_build_object('ok',true,'alreadySaved',true);
  end if;
  select * into current_goal from public.ff_member_goals where workspace=a.workspace and member_id=a.id and ended_at is null for update;
  if current_goal.id is distinct from expected_id then raise exception 'The current goal has already changed. Reload progress before saving again.'; end if;
  if op in ('pause_goal','resume_goal') then
   if current_goal.id is null then raise exception 'Choose a current goal first.'; end if;
   state:=case when op='pause_goal' then 'paused' else 'active' end;
   if current_goal.status=state then raise exception 'The goal already has this status. Reload progress.'; end if;
   kind:=current_goal.goal_type; starts:=current_goal.start_date; starting:=current_goal.starting_weight_kg;
   measured:=current_goal.measurement_date; target:=current_goal.target_weight_kg; period:=current_goal.period_id;
  else
   if jsonb_typeof(body->'goalType') is distinct from 'string' or (body->>'goalType') not in ('lose','gain','maintain','attendance') then raise exception 'Choose one of the four goals.'; end if;
   kind:=body->>'goalType';
   if jsonb_typeof(body->'startDate') is distinct from 'string' or (body->>'startDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Choose a real goal start date.'; end if;
   starts:=(body->>'startDate')::date;
   if starts>ff_private.today() then raise exception 'Goal start cannot be in the future.'; end if;
   if jsonb_typeof(body->'startingWeightKg') not in ('number','null') or jsonb_typeof(body->'targetWeightKg') not in ('number','null') then raise exception 'Enter valid optional weights.'; end if;
   starting:=(body->>'startingWeightKg')::numeric; target:=(body->>'targetWeightKg')::numeric;
   if (starting is not null and (starting<10 or starting>500 or starting*10<>trunc(starting*10)))
    or (target is not null and (target<10 or target>500 or target*10<>trunc(target*10))) then raise exception 'Use weights from 10 to 500 kg, with at most one decimal place.'; end if;
   if jsonb_typeof(body->'measurementDate') not in ('string','null') then raise exception 'Confirm the actual measurement date.'; end if;
   if body->>'measurementDate' is not null and (body->>'measurementDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Confirm a real measurement date.'; end if;
   measured:=(body->>'measurementDate')::date;
   if kind='attendance' then
    if starting is not null or target is not null or measured is not null then raise exception 'Attendance goals do not need weight fields.'; end if;
   else
    if starting is null or measured is null or measured>starts then raise exception 'Confirm a starting weight and its actual date on or before the goal start.'; end if;
    if (kind='maintain' and target is not null) or (kind='lose' and target>=starting) or (kind='gain' and target<=starting) then raise exception 'Choose a target in the goal direction, or leave it blank.'; end if;
    -- Confirmed setup creates a real baseline point only when absent. A conflicting existing point
    -- requires the explicit measurement-edit flow; goal setup must never silently overwrite it.
    select weight_kg into saved_weight from public.ff_member_weights where workspace=a.workspace and member_id=a.id and measured_on=measured;
    if found and saved_weight<>starting then raise exception 'A different weight already exists on that date. Edit that measurement explicitly first.'; end if;
    if not found then insert into public.ff_member_weights(workspace,member_id,measured_on,weight_kg) values(a.workspace,a.id,measured,starting); end if;
   end if;
   state:=case when op='save_goal' and current_goal.id is not null then current_goal.status else 'active' end;
   period:=case when op='save_goal' and current_goal.id is not null then current_goal.period_id else gen_random_uuid() end;
  end if;
  if current_goal.id is not null then update public.ff_member_goals set ended_at=clock_timestamp() where id=current_goal.id; end if;
  insert into public.ff_member_goals(workspace,member_id,period_id,request_id,request_hash,goal_type,status,start_date,starting_weight_kg,measurement_date,target_weight_kg)
   values(a.workspace,a.id,period,request_key,md5(body::text),kind,state,starts,starting,measured,target);
 else
  if op in ('update_weight','delete_weight') then
   if jsonb_typeof(body->'id') is distinct from 'string' or (body->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Choose a valid measurement.'; end if;
   row_id:=(body->>'id')::uuid;
   if not exists(select 1 from public.ff_member_weights where id=row_id and workspace=a.workspace and member_id=a.id) then raise exception 'Measurement is unavailable to this member.' using errcode='42501'; end if;
  end if;
  if op='delete_weight' then
   delete from public.ff_member_weights where id=row_id and workspace=a.workspace and member_id=a.id;
  else
   if jsonb_typeof(body->'date') is distinct from 'string' or (body->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Choose a real measurement date.'; end if;
   measured:=(body->>'date')::date;
   if measured>ff_private.today() then raise exception 'Measurement date cannot be in the future.'; end if;
   if jsonb_typeof(body->'weightKg') is distinct from 'number' then raise exception 'Enter a valid weight.'; end if;
   weight:=(body->>'weightKg')::numeric;
   if weight<10 or weight>500 or weight*10<>trunc(weight*10) then raise exception 'Use a weight from 10 to 500 kg, with at most one decimal place.'; end if;
   if exists(select 1 from public.ff_member_weights where workspace=a.workspace and member_id=a.id and measured_on=measured and (op='add_weight' or id<>row_id)) then raise exception 'A weight already exists on that date. Use Edit to replace it explicitly.'; end if;
   if op='add_weight' then insert into public.ff_member_weights(workspace,member_id,measured_on,weight_kg) values(a.workspace,a.id,measured,weight);
   else update public.ff_member_weights set measured_on=measured,weight_kg=weight,updated_at=clock_timestamp() where id=row_id and workspace=a.workspace and member_id=a.id; end if;
  end if;
 end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.ff_member_progress(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ff_member_progress(jsonb) to authenticated;
notify pgrst, 'reload schema';
