-- Task 12B: membership-plan recommendations, and a record of what was recommended against what was chosen.
--
-- 1. ff_private.score_plans(inputs, plans) is the recommendation, with the same additive rules as
--    public/plan-recommender.js (the tests run both on the same answers and require identical results; change them
--    together and raise the rule version). inputs: the profile's main goal and the survey's experience, exercise
--    preferences and usual days. plans: the available plans with their current price (centavos), coaching and focus
--    tags. It returns each plan's points per rule, the ranking (points, then price, then plan ID), the suggested plan
--    and the plain-language reasons. It chooses, buys and prices nothing.
-- 2. ff_plan_choices keeps, once per new membership cycle and per new first registration, the plan chosen and the
--    plan the rules recommended at that moment. The recommendation is computed here, in the same transaction, from the
--    member's stored answers (a first registration: the goal given at the desk, and no survey yet) and the workspace's
--    catalog; nothing comes from the browser. The record keeps the rule version, the answers used and every plan's
--    terms and points, so it still explains itself after the survey or the catalog changes. Without a complete survey
--    there is no recommendation, and the record says what was missing. Paying an existing invoice or retrying a request
--    creates no cycle, so no record. Staff and administrators of the workspace may read the records (for a later
--    insights screen); only the trigger writes them, and nothing changes them.
-- 3. Foreign keys. A record goes with what it describes: deleting a cycle, a first registration or a member account
--    deletes its records (on delete cascade), like the survey answers. Never-paid account clean-up and the test-data
--    reset delete cycles and registrations before accounts, so they work as before; paid accounts are never deleted,
--    so their records stay. Plans are never deleted (Task 12A), so the chosen and recommended plans always resolve.
--    created_by is a plain reference, like the payments' recorded_by: an account can't be deleted while records it
--    created exist (staff are disabled, never deleted; a member creates records only for their own cycles).
-- 4. Recording never stops a purchase: if it fails, the cycle is still created and a warning is logged.

-- 1. The rules ----------------------------------------------------------------------------------------------------
create function ff_private.score_plans(inputs jsonb, plans jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
 goal text:=case when inputs->>'goal' in ('Improve fitness','Build strength','Stay consistent','Manage weight') then inputs->>'goal' end;
 experience text:=case when inputs->>'experience' in ('beginner','returning','regular') then inputs->>'experience' end;
 labels jsonb:='{"strength":"strength training","cardio":"cardio","mobility":"stretching and mobility","group_classes":"group classes"}';
 exercises text[]; days text[]; missing text[]; open jsonb; lowest numeric; p jsonb; focus jsonb; rules jsonb; matches text[];
 ranked jsonb:='[]'; top jsonb; r jsonb; names text[]; reasons jsonb:='[]'; used jsonb;
begin
 -- Known answers only, each once, in their usual order. Survey exercise values are the plan focus tags' own words.
 select coalesce(array_agg(x order by n),'{}') into exercises from unnest(array['strength','cardio','mobility','group_classes']) with ordinality as e(x,n)
  where jsonb_typeof(inputs->'exercises')='array' and inputs->'exercises' ? x;
 select coalesce(array_agg(x order by n),'{}') into days from unnest(array['mon','tue','wed','thu','fri','sat','sun']) with ordinality as d(x,n)
  where jsonb_typeof(inputs->'availableDays')='array' and inputs->'availableDays' ? x;
 missing:=array_remove(array[case when goal is null then 'goal' end,case when experience is null then 'experience' end,
  case when cardinality(exercises)=0 then 'exercises' end,case when cardinality(days)=0 then 'availableDays' end],null);
 -- An incomplete survey gets no recommendation: ask for it, guess nothing.
 if cardinality(missing)>0 then
  return jsonb_build_object('status','incomplete','ruleVersion','12B.1','missing',to_jsonb(missing),'recommended',null,'ranking','[]'::jsonb,'reasons','[]'::jsonb);
 end if;
 used:=jsonb_build_object('goal',goal,'experience',experience,'exercises',to_jsonb(exercises),'availableDays',to_jsonb(days),'daysPerWeek',cardinality(days));
 select coalesce(jsonb_agg(x),'[]') into open from jsonb_array_elements(case when jsonb_typeof(plans)='array' then plans else '[]' end) as a(x)
  where jsonb_typeof(x)='object' and x->'available' is distinct from 'false'::jsonb;
 if jsonb_array_length(open)=0 then
  return jsonb_build_object('status','no_plans','ruleVersion','12B.1','inputs',used,'recommended',null,'ranking','[]'::jsonb,'reasons','[]'::jsonb);
 end if;
 select min((x->>'priceCents')::numeric) into lowest from jsonb_array_elements(open) as a(x);
 for p in select x from jsonb_array_elements(open) as a(x) loop
  focus:=coalesce(p->'focusTags','[]');rules:='[]';
  if experience in ('beginner','returning') and p->>'coaching'='group' then rules:=rules||jsonb_build_object('rule','experience-coaching','points',2); end if;
  if experience in ('beginner','returning') and p->>'coaching'='personal' then rules:=rules||jsonb_build_object('rule','experience-coaching','points',3); end if;
  if experience='regular' and p->>'coaching'='none' then rules:=rules||jsonb_build_object('rule','regular-no-coach','points',1); end if;
  if goal='Build strength' and focus ? 'strength' then rules:=rules||jsonb_build_object('rule','goal-strength-focus','points',2); end if;
  if goal='Build strength' and p->>'coaching'='personal' then rules:=rules||jsonb_build_object('rule','goal-strength-personal','points',1); end if;
  if goal='Manage weight' and focus ? 'cardio' then rules:=rules||jsonb_build_object('rule','goal-weight-cardio','points',2); end if;
  if goal='Stay consistent' and p->>'coaching'='group' then rules:=rules||jsonb_build_object('rule','goal-consistency-group','points',2); end if;
  select coalesce(array_agg(x order by n),'{}') into matches from unnest(exercises) with ordinality as e(x,n) where focus ? x;
  if cardinality(matches)>0 then rules:=rules||jsonb_build_object('rule','preference-match','points',cardinality(matches),'matches',to_jsonb(matches)); end if;
  if cardinality(days) between 1 and 2 and (p->>'priceCents')::numeric=lowest then rules:=rules||jsonb_build_object('rule','few-days-lowest-price','points',1); end if;
  if cardinality(days)>=5 and focus ? 'group_classes' then rules:=rules||jsonb_build_object('rule','many-days-group-classes','points',1); end if;
  ranked:=ranked||jsonb_build_object('id',p->'id','name',p->'name','priceCents',p->'priceCents','coaching',p->'coaching','coachSessions',p->'coachSessions',
   'focusTags',focus,'score',(select coalesce(sum((e->>'points')::int),0) from jsonb_array_elements(rules) as e),'rules',rules);
 end loop;
 select jsonb_agg(x order by (x->>'score')::int desc,(x->>'priceCents')::numeric,(x->>'id') collate "C") into ranked from jsonb_array_elements(ranked) as a(x);
 top:=ranked->0;
 -- Why the suggested plan fits, from the rules it actually met; with no points at all, an honest generic reason.
 if (top->>'score')::int=0 then
  reasons:=jsonb_build_array('None of your answers points to one plan in particular, so we suggest the plan with the lowest price.');
 else
  for r in select x from jsonb_array_elements(top->'rules') as a(x) loop
   if r->>'rule'='preference-match' then
    select array_agg(labels->>x order by n) into names from jsonb_array_elements_text(r->'matches') with ordinality as m(x,n);
    reasons:=reasons||to_jsonb('It matches your interest in '||case when cardinality(names)<2 then names[1]
     else array_to_string(names[1:cardinality(names)-1],', ')||' and '||names[cardinality(names)] end||'.');
   else
    reasons:=reasons||to_jsonb(case r->>'rule'
     when 'experience-coaching' then case when experience='beginner' then 'You’re new to training' else 'You’re getting back into training' end
      ||', and this plan includes '||case when (r->>'points')::int=3 then 'a personal coach' else 'group coaching' end||'.'
     when 'regular-no-coach' then 'You train regularly, so a plan without a coach can suit you.'
     when 'goal-strength-focus' then 'You want to build strength, and this plan focuses on strength.'
     when 'goal-strength-personal' then 'Its personal coach can help you build strength.'
     when 'goal-weight-cardio' then 'You want to manage your weight, and this plan focuses on cardio.'
     when 'goal-consistency-group' then 'You want to stay consistent, and group coaching helps with that.'
     when 'few-days-lowest-price' then 'You’re usually free 1–2 days a week, and this plan has the lowest price.'
     when 'many-days-group-classes' then 'You’re usually free 5 or more days a week, and this plan includes group classes.'
    end);
   end if;
  end loop;
 end if;
 return jsonb_build_object('status','recommended','ruleVersion','12B.1','inputs',used,'recommended',top->'id','ranking',ranked,'reasons',reasons);
end $$;

-- A member's answers: the goal from their profile and their stored survey (empty answers when there is no survey).
create function ff_private.member_answers(w text, member uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('goal',p.goal,'experience',s.experience,'exercises',to_jsonb(s.exercises),'availableDays',to_jsonb(s.available_days))
 from public.ff_profiles p left join public.ff_member_surveys s on s.id=p.id where p.id=member and p.workspace=w
$$;

-- The recommendation now, for these answers, from the workspace's available plans as they are now.
create function ff_private.recommend_for(w text, answers jsonb) returns jsonb
language sql stable set search_path='' as $$
 select ff_private.score_plans(answers,
  (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'priceCents',price_cents,'coaching',coaching,'coachSessions',coach_sessions,
    'focusTags',to_jsonb(focus_tags)) order by id),'[]') from public.ff_plans where workspace=w and available))
$$;

-- 2. The record -----------------------------------------------------------------------------------------------------
create table public.ff_plan_choices (
 id uuid primary key default gen_random_uuid(),
 workspace text not null check (workspace in ('production','demo')),
 -- The member who got the cycle; empty for a first registration, which has no account yet.
 member_id uuid,
 -- What was created: a membership cycle, or a first registration (exactly one).
 membership_id uuid unique,
 registration_id uuid unique references public.ff_registrations(id) on delete cascade,
 chosen_plan_id text not null,
 -- Empty when there was no recommendation (no complete survey, or no plan available).
 recommended_plan_id text,
 rule_version text not null check (length(rule_version) between 1 and 20),
 -- ff_private.score_plans as it ran: status, answers used, every plan's terms and points, and the reasons.
 recommendation jsonb not null check (recommendation->>'status' in ('recommended','incomplete','no_plans')),
 -- Who created the cycle or registration (the member, or staff at the desk), when known. A plain reference (see 3.).
 created_by uuid references public.ff_profiles(id),
 created_at timestamptz not null default now(),
 check ((membership_id is null) <> (registration_id is null)),
 check (membership_id is null or member_id is not null),
 check ((recommended_plan_id is not null) = (recommendation->>'status'='recommended')),
 foreign key (workspace,member_id) references public.ff_profiles(workspace,id) on delete cascade,
 foreign key (workspace,membership_id) references public.ff_memberships(workspace,id) on delete cascade,
 foreign key (workspace,chosen_plan_id) references public.ff_plans(workspace,id),
 foreign key (workspace,recommended_plan_id) references public.ff_plans(workspace,id)
);
create index ff_plan_choices_workspace on public.ff_plan_choices(workspace,created_at);
create index ff_plan_choices_member on public.ff_plan_choices(member_id);
alter table public.ff_plan_choices enable row level security;
create policy ff_plan_choice_read on public.ff_plan_choices for select to authenticated
 using (workspace=(select ff_private.workspace()) and (select ff_private.is_gym_staff()));
create trigger ff_plan_choices_fixed before update on public.ff_plan_choices for each row execute function ff_private.append_only();

-- One record per new cycle or first registration. A cycle completing a first registration was recorded when the
-- registration was made, so it isn't recorded again.
create function ff_private.record_plan_choice() returns trigger
language plpgsql security definer set search_path='' as $$
declare rec jsonb;
begin
 begin
  if tg_table_name='ff_memberships' then
   if new.terms->>'source'='registration' then return null; end if;
   rec:=ff_private.recommend_for(new.workspace,ff_private.member_answers(new.workspace,new.member_id));
   insert into public.ff_plan_choices(workspace,member_id,membership_id,chosen_plan_id,recommended_plan_id,rule_version,recommendation,created_by)
   values(new.workspace,new.member_id,new.id,new.plan_id,rec->>'recommended',rec->>'ruleVersion',rec,
    (select p.id from public.ff_profiles p where p.id=(select auth.uid()))) on conflict do nothing;
  else
   -- A first registration has the goal given at the desk, but no account or survey yet: no recommendation.
   rec:=ff_private.recommend_for(new.workspace,jsonb_build_object('goal',new.goal));
   insert into public.ff_plan_choices(workspace,registration_id,chosen_plan_id,recommended_plan_id,rule_version,recommendation,created_by)
   values(new.workspace,new.id,new.plan_id,rec->>'recommended',rec->>'ruleVersion',rec,
    (select p.id from public.ff_profiles p where p.id=(select auth.uid()))) on conflict do nothing;
  end if;
 exception when others then
  raise warning 'Plan choice not recorded for % %: %',tg_table_name,new.id,sqlerrm;
 end;
 return null;
end $$;
create trigger ff_memberships_plan_choice after insert on public.ff_memberships for each row execute function ff_private.record_plan_choice();
create trigger ff_registrations_plan_choice after insert on public.ff_registrations for each row execute function ff_private.record_plan_choice();

-- Grants: staff and administrators read through RLS, and server tooling reads; nobody writes but the trigger. The
-- functions are internal.
revoke all on public.ff_plan_choices from public,anon,authenticated,service_role;
grant select on public.ff_plan_choices to authenticated,service_role;
revoke all on function ff_private.score_plans(jsonb,jsonb),ff_private.member_answers(text,uuid),ff_private.recommend_for(text,jsonb),ff_private.record_plan_choice()
 from public,anon,authenticated;
NOTIFY pgrst, 'reload schema';
