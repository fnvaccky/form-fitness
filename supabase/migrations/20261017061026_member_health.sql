-- Optional member-owned health answers are deliberately separate from fitness surveys/rosters.
-- No backfill, BMI storage, clinical free text, staff/admin access or business-record changes.
create table public.ff_member_health (
 id uuid primary key,
 workspace text not null,
 height_cm numeric check (height_cm between 50 and 250 and height_cm * 10 = trunc(height_cm * 10)),
 weight_kg numeric check (weight_kg between 10 and 500 and weight_kg * 10 = trunc(weight_kg * 10)),
 age_band text check (age_band in ('under20','20plus','prefer_not')),
 conditions text[] not null default '{}' check (
  cardinality(conditions) between 0 and 8
  and (cardinality(conditions)=0 or array_ndims(conditions)=1)
  and array_position(conditions,null) is null
  and conditions <@ array['asthma','heart_condition','high_blood_pressure','diabetes','injury_limitation','other','none','prefer_not']::text[]
  and (not ('none'=any(conditions)) or cardinality(conditions)=1)
  and (not ('prefer_not'=any(conditions)) or cardinality(conditions)=1)
 ),
 updated_at timestamptz not null default now(),
 foreign key (workspace,id) references public.ff_profiles(workspace,id) on delete cascade
);
create index ff_member_health_workspace_id on public.ff_member_health(workspace,id);
alter table public.ff_member_health enable row level security;
revoke all on public.ff_member_health from public,anon,authenticated,service_role;
grant select on public.ff_member_health to authenticated;
create policy ff_member_health_owner_read on public.ff_member_health for select to authenticated
 using (id=(select auth.uid()) and workspace=(select ff_private.workspace()) and (select (ff_private.actor()).role)='member');

-- The caller chooses no account/workspace IDs. The existing actor check requires an enabled profile
-- and a still-valid server-side session; only its owner-member can replace all four optional fields.
create function public.ff_save_member_health(body jsonb) returns public.ff_member_health
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles:=ff_private.actor(); saved public.ff_member_health;
 h numeric; w numeric; age text; choices text[];
begin
 if a.id is null or a.role<>'member' then raise exception 'Only members can save their own optional health information.' using errcode='42501'; end if;
 if body is null or jsonb_typeof(body)<>'object'
  or not (body ?& array['heightCm','weightKg','ageBand','conditions'])
  or (body-array['heightCm','weightKg','ageBand','conditions'])<>'{}'::jsonb then
  raise exception 'Send only the four optional health fields.';
 end if;
 if jsonb_typeof(body->'heightCm') not in ('number','null') then raise exception 'Enter a valid optional height.'; end if;
 if jsonb_typeof(body->'weightKg') not in ('number','null') then raise exception 'Enter a valid optional weight.'; end if;
 h:=(body->>'heightCm')::numeric; w:=(body->>'weightKg')::numeric;
 if h is not null and (h<50 or h>250 or h*10<>trunc(h*10)) then raise exception 'Enter a valid optional height.'; end if;
 if w is not null and (w<10 or w>500 or w*10<>trunc(w*10)) then raise exception 'Enter a valid optional weight.'; end if;
 if jsonb_typeof(body->'ageBand') not in ('string','null') then raise exception 'Choose a valid optional age group.'; end if;
 age:=body->>'ageBand';
 if age is not null and age not in ('under20','20plus','prefer_not') then raise exception 'Choose a valid optional age group.'; end if;
 if jsonb_typeof(body->'conditions') is distinct from 'array' or jsonb_array_length(body->'conditions')>8 then
  raise exception 'Choose valid optional conditions.';
 end if;
 select coalesce(array_agg(value order by ord),'{}'::text[]) into choices
  from jsonb_array_elements_text(body->'conditions') with ordinality as answer(value,ord);
 if array_position(choices,null) is not null
  or not (choices <@ array['asthma','heart_condition','high_blood_pressure','diabetes','injury_limitation','other','none','prefer_not']::text[])
  or cardinality(choices)<>(select count(distinct x) from unnest(choices) x)
  or (cardinality(choices)>1 and (choices && array['none','prefer_not']::text[])) then
  raise exception 'Choose valid optional conditions.';
 end if;
 choices:=array(select x from unnest(array['asthma','heart_condition','high_blood_pressure','diabetes','injury_limitation','other','none','prefer_not']::text[]) x where x=any(choices));
 perform 1 from public.ff_profiles where id=a.id and workspace=a.workspace and enabled and role='member' for share;
 if not found then raise exception 'Member access is required.' using errcode='42501'; end if;
 insert into public.ff_member_health(id,workspace,height_cm,weight_kg,age_band,conditions)
  values(a.id,a.workspace,h,w,age,choices)
 on conflict(id) do update set height_cm=excluded.height_cm,weight_kg=excluded.weight_kg,age_band=excluded.age_band,conditions=excluded.conditions,updated_at=now()
 returning * into saved;
 return saved;
end $$;
revoke all on function public.ff_save_member_health(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ff_save_member_health(jsonb) to authenticated;
notify pgrst, 'reload schema';
