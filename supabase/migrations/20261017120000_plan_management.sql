-- Task 12A: plan management with coaching, and purchased terms that survive catalog edits.
--
-- 1. Plans gain a coaching level (none, group or personal), coach sessions per cycle (0 to 30, and 0 when there is
--    no coach) and focus tags for the plan recommendation (strength, cardio, mobility, group_classes, kept in that
--    order). A description is at most 200 characters and features at most 10 lines of 80 characters, without < or >
--    or line breaks. Plan names are unique within a workspace, ignoring case. A feature line "Everything in <plan>"
--    must name another plan of the workspace, no plan may include itself (directly or through others), and renaming
--    a plan updates the lines that name it, so the reference always resolves. The three plans keep their IDs,
--    prices, lengths, descriptions and features in both workspaces; this only sets their coaching and focus tags.
-- 2. ff_private.plan_admin is the one way to add or change a plan: administrators of the caller's own workspace,
--    checked here from the session. ff_plans refuses every other insert or update (ff_private.command's old 'plans'
--    action and the service key included), every delete and any TRUNCATE (which, with CASCADE, would also empty
--    every cycle, invoice, payment and check-in). A plan's ID never changes; a plan is retired by making it unavailable.
--    Changes to one workspace's plans run one at a time (a workspace lock taken before any check), so each is checked
--    against the plans as the previous change committed them; workspaces don't wait on each other.
-- 3. Purchased terms: each membership cycle, and each first registration, keeps what was bought (name, price,
--    length, description, features, what each "Everything in <plan>" line meant, and coaching), taken from the plan
--    row in the transaction that creates it. The terms never change afterwards. Existing rows are filled once below:
--    from values stored with each row where they exist (invoice price, cycle dates, the registration's own copy),
--    and otherwise from the catalog as captured while this migration runs, a baseline rather than a record of what
--    was shown at the time of purchase.
-- 4. Retired plans still can't be chosen for a new cycle or registration, but a cycle, invoice or registration that
--    already exists stays payable on its own terms: paymongo_prepare no longer re-checks availability for those.

-- 1. The plan catalog ---------------------------------------------------------------------------------------------

-- Focus tags, without duplicates, in their fixed order.
create function ff_private.focus_tags(tags text[]) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(t order by n),'{}') from unnest(array['strength','cardio','mobility','group_classes']) with ordinality as allowed(t,n) where t=any(tags)
$$;

-- Up to 10 features, each a trimmed line of 1 to 80 characters without < > or line breaks.
create function ff_private.plan_features_ok(features jsonb) returns boolean
language sql immutable set search_path='' as $$
 select jsonb_typeof(features)='array' and jsonb_array_length(features)<=10
  and not exists(select 1 from jsonb_array_elements(features) as f(v)
   where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 80 or v#>>'{}'<>btrim(v#>>'{}') or v#>>'{}' ~ '[<>\r\n]')
$$;

alter table public.ff_plans
 add column coaching text not null default 'none',
 add column coach_sessions integer not null default 0,
 add column focus_tags text[] not null default '{}';

-- The coaching defaults Clark chose, in both workspaces. Prices, lengths, descriptions and features stay as they are.
update public.ff_plans set coaching='none',coach_sessions=0,focus_tags=array['strength','cardio'] where id='basic';
update public.ff_plans set coaching='group',coach_sessions=0,focus_tags=array['cardio','mobility','group_classes'] where id='plus';
update public.ff_plans set coaching='personal',coach_sessions=4,focus_tags=array['strength','mobility'] where id='elite';

alter table public.ff_plans
 add constraint ff_plans_coaching_check check (coaching in ('none','group','personal')),
 add constraint ff_plans_coach_sessions_check check (coach_sessions between 0 and 30 and (coaching<>'none' or coach_sessions=0)),
 add constraint ff_plans_focus_tags_check check (array_position(focus_tags,null) is null and focus_tags=ff_private.focus_tags(focus_tags)),
 add constraint ff_plans_description_check check (length(description)<=200 and description !~ '[<>\r\n]'),
 add constraint ff_plans_features_check check (ff_private.plan_features_ok(features));
create unique index ff_plans_workspace_name on public.ff_plans(workspace,lower(name));

-- 2. Purchased terms ----------------------------------------------------------------------------------------------

-- A plan's features with every "Everything in <plan>" line replaced by that plan's features (resolved the same way),
-- without repeats. The line names a plan of the same workspace, ignoring case; a line naming no plan stays as written.
-- seen holds the plans already being resolved, so a loop (A includes B, B includes A) stops.
create function ff_private.plan_features_flat(w text, features jsonb, seen text[]) returns jsonb
language plpgsql stable set search_path='' as $$
declare line text; item text; ref public.ff_plans; flat jsonb:='[]';
begin
 for line in select value from jsonb_array_elements_text(coalesce(features,'[]'::jsonb)) loop
  ref:=null;
  if line ~* '^everything in .' then
   select p.* into ref from public.ff_plans p where p.workspace=w and lower(p.name)=lower(btrim(substr(line,15))) and p.id<>all(seen);
  end if;
  if ref.id is null then
   if not flat ? line then flat:=flat||to_jsonb(line); end if;
  else
   for item in select value from jsonb_array_elements_text(ff_private.plan_features_flat(w,ref.features,seen||ref.id)) loop
    if not flat ? item then flat:=flat||to_jsonb(item); end if;
   end loop;
  end if;
 end loop;
 return flat;
end $$;

-- What each "Everything in <plan>" line of a plan meant at that moment: [{line, plan, features}], frozen with the terms.
create function ff_private.plan_included(w text, features jsonb, self text) returns jsonb
language plpgsql stable set search_path='' as $$
declare line text; ref public.ff_plans; included jsonb:='[]';
begin
 for line in select value from jsonb_array_elements_text(coalesce(features,'[]'::jsonb)) loop
  continue when line !~* '^everything in .';
  select p.* into ref from public.ff_plans p where p.workspace=w and lower(p.name)=lower(btrim(substr(line,15))) and p.id<>self;
  continue when not found;
  included:=included||jsonb_build_array(jsonb_build_object('line',line,'plan',ref.name,'features',ff_private.plan_features_flat(w,ref.features,array[self,ref.id])));
 end loop;
 return included;
end $$;

-- Does plan start include plan target, directly or through the plans it includes? Follows "Everything in <plan>" lines
-- by name within the workspace; used to refuse a plan that would end up including itself.
create function ff_private.plan_reaches(w text, start text, target text) returns boolean
language plpgsql stable set search_path='' as $$
declare frontier text[]:=array[start]; seen text[]:='{}';
begin
 while cardinality(frontier)>0 loop
  if target=any(frontier) then return true; end if;
  seen:=seen||frontier;
  select coalesce(array_agg(distinct r.id),'{}') into frontier
  from public.ff_plans x cross join lateral jsonb_array_elements_text(x.features) as f(line)
  join public.ff_plans r on r.workspace=w and lower(r.name)=lower(btrim(substr(f.line,15)))
  where x.workspace=w and x.id=any(frontier) and f.line ~* '^everything in .' and r.id<>all(seen);
 end loop;
 return false;
end $$;

-- The terms a cycle or registration keeps. source says where they came from (see the backfill below).
create function ff_private.plan_terms(p public.ff_plans, source text) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('name',p.name,'priceCents',p.price_cents,'days',p.days,'description',p.description,'features',p.features,
  'included',ff_private.plan_included(p.workspace,p.features,p.id),'coaching',p.coaching,'coachSessions',p.coach_sessions,'source',source)
$$;

-- The shape of stored terms. Each value was checked when the plan was saved, so only the structure is checked here.
create function ff_private.terms_ok(t jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(t) is distinct from 'object' or (t-array['name','priceCents','days','description','features','included','coaching','coachSessions','source'])<>'{}'::jsonb then return false; end if;
 if jsonb_typeof(t->'name') is distinct from 'string' or jsonb_typeof(t->'description') is distinct from 'string' or jsonb_typeof(t->'coaching') is distinct from 'string'
  or jsonb_typeof(t->'source') is distinct from 'string' or jsonb_typeof(t->'priceCents') is distinct from 'number' or jsonb_typeof(t->'days') is distinct from 'number'
  or jsonb_typeof(t->'coachSessions') is distinct from 'number' or jsonb_typeof(t->'features') is distinct from 'array' or jsonb_typeof(t->'included') is distinct from 'array' then return false; end if;
 if length(t->>'name') not between 1 and 70 or (t->>'priceCents')::numeric not between 1 and 10000000 or (t->>'priceCents')::numeric%1<>0
  or (t->>'days')::numeric not between 1 and 366 or (t->>'days')::numeric%1<>0 or (t->>'coachSessions')::numeric not between 0 and 30 or (t->>'coachSessions')::numeric%1<>0
  or t->>'coaching' not in ('none','group','personal') or (t->>'coaching'='none' and (t->>'coachSessions')::numeric<>0)
  or t->>'source' not in ('purchase','registration','registration-backfill','baseline-backfill') then return false; end if;
 if exists(select 1 from jsonb_array_elements(t->'features') as f(v) where jsonb_typeof(v)<>'string')
  or exists(select 1 from jsonb_array_elements(t->'included') as i(v) where jsonb_typeof(v)<>'object' or jsonb_typeof(v->'line') is distinct from 'string'
   or jsonb_typeof(v->'plan') is distinct from 'string' or jsonb_typeof(v->'features') is distinct from 'array') then return false; end if;
 return true;
end $$;

alter table public.ff_memberships add column terms jsonb;
alter table public.ff_registrations add column terms jsonb;

-- A new cycle or registration takes its plan's terms from the plan row it locks. new_membership and
-- ff_private.registration already hold that lock (for share), so a plan edit can't land in between: the terms match
-- the dates and the amount they wrote, and a concurrent edit waits for them, or they wait for it and see it whole.
-- Terms given on insert are kept: registration completion passes the registration's. Once set, terms never change.
create function ff_private.purchased_terms() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.ff_plans;
begin
 if tg_op='UPDATE' and old.terms is not null then
  if new.terms is distinct from old.terms then raise exception 'Purchased terms can''t be changed. They stay as they were when the plan was bought.'; end if;
  return new;
 end if;
 if tg_op='INSERT' and new.terms is null then
  select * into p from public.ff_plans where workspace=new.workspace and id=new.plan_id for share;
  if found then new.terms:=ff_private.plan_terms(p,case when tg_table_name='ff_registrations' then 'registration' else 'purchase' end); end if;
 end if;
 if new.terms is not null and not ff_private.terms_ok(new.terms) then raise exception 'Purchased terms are incomplete.'; end if;
 return new;
end $$;
create trigger ff_memberships_terms before insert or update of terms on public.ff_memberships for each row execute function ff_private.purchased_terms();
create trigger ff_registrations_terms before insert or update of terms on public.ff_registrations for each row execute function ff_private.purchased_terms();

-- The backfill can freeze an "Everything in <plan>" line only if it names another plan of its workspace.
do $$ begin
 if exists(select 1 from public.ff_plans x cross join lateral jsonb_array_elements_text(x.features) as f(line)
  where f.line ~* '^everything in .' and not exists(select 1 from public.ff_plans r where r.workspace=x.workspace and r.id<>x.id and lower(r.name)=lower(btrim(substr(f.line,15))))) then
  raise exception 'A plan''s "Everything in" line names no other plan of its workspace. Fix the catalog before this migration.';
 end if;
end $$;

-- The backfill, once. Gate 1 lists the row counts. No catalog history was kept before this migration, so values not
-- stored with a row come from the catalog as captured now: a baseline, marked by its source, not proof of what a
-- member was shown when buying.
-- a) First registrations: name, price, length and features as the registration stored them; description, coaching
--    and the meaning of "Everything in" lines from the catalog as captured now (registrations never stored them).
update public.ff_registrations r set terms=jsonb_build_object('name',r.plan_name,'priceCents',r.amount_cents,'days',r.days,'description',p.description,
 'features',r.features,'included',ff_private.plan_included(r.workspace,r.features,r.plan_id),'coaching',p.coaching,'coachSessions',p.coach_sessions,'source','registration-backfill')
from public.ff_plans p where p.workspace=r.workspace and p.id=r.plan_id and r.terms is null;
-- b) The cycle a provisioned registration created takes that registration's terms.
update public.ff_memberships m set terms=r.terms
from public.ff_registrations r where r.workspace=m.workspace and r.member_id=m.member_id and r.plan_id=m.plan_id and r.start_date=m.start_date
 and r.status='provisioned' and m.terms is null;
-- c) Every other cycle: the price its invoice was created with and its own dates, as stored; name, description,
--    features, coaching and the meaning of "Everything in" lines from the catalog as captured now.
update public.ff_memberships m set terms=jsonb_build_object('name',p.name,
 'priceCents',coalesce((select i.amount_cents from public.ff_invoices i where i.membership_id=m.id),p.price_cents),'days',m.end_date-m.start_date+1,
 'description',p.description,'features',p.features,'included',ff_private.plan_included(p.workspace,p.features,p.id),'coaching',p.coaching,
 'coachSessions',p.coach_sessions,'source','baseline-backfill')
from public.ff_plans p where p.workspace=m.workspace and p.id=m.plan_id and m.terms is null;
alter table public.ff_memberships alter column terms set not null;
alter table public.ff_registrations alter column terms set not null;

-- 3. Plan management ----------------------------------------------------------------------------------------------

-- Only ff_private.plan_admin writes plans (it sets ff.plan_admin for its own statement), and nothing deletes them,
-- row by row or with TRUNCATE. TRUNCATE skips row triggers, and TRUNCATE ... CASCADE would empty every table that
-- references plans (cycles, registrations, invoices, payments, submissions, checkouts, check-ins), so it has its own
-- statement trigger, which stops even the database owner, and the service key loses the TRUNCATE privilege.
create function ff_private.plan_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op in ('DELETE','TRUNCATE') then raise exception 'Plans can''t be deleted. Make the plan unavailable to retire it.'; end if;
 if coalesce(current_setting('ff.plan_admin',true),'')<>'on' then raise exception 'Plans are changed only in plan management. Reload the page and try again.'; end if;
 if tg_op='UPDATE' and (new.id is distinct from old.id or new.workspace is distinct from old.workspace) then raise exception 'A plan''s ID can''t be changed.'; end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ff_plans_guard before insert or update or delete on public.ff_plans for each row execute function ff_private.plan_guard();
create trigger ff_plans_no_truncate before truncate on public.ff_plans for each statement execute function ff_private.plan_guard();
revoke truncate on public.ff_plans from service_role;

-- Add or change a plan: administrators of the caller's own workspace (from the session, never the request).
-- action 'create' adds one ('id' must be new; repeating an identical create returns the saved plan); 'update'
-- replaces every field of an existing plan except its ID. All fields are required. A feature line "Everything in
-- <plan>" must name another plan of the workspace that doesn't already include this one. Renaming a plan updates
-- those lines in the plans that include it, so they keep resolving; those plans come back as alsoUpdated.
-- Returns the plan as saved.
create function ff_private.plan_admin(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; p public.ff_plans; v public.ff_plans; saved public.ff_plans; ref public.ff_plans; item jsonb; line text; tags text[];
 features jsonb:='[]'; also jsonb:='[]';
begin
 a:=ff_private.actor();
 if a.id is null then raise exception 'Please sign in to continue.' using errcode='42501'; end if;
 if a.role<>'admin' then raise exception 'Administrator access is required.' using errcode='42501'; end if;
 if action is null or action not in ('create','update') then raise exception 'Unknown plan action.'; end if;
 if jsonb_typeof(body) is distinct from 'object' or (body-array['id','name','priceCents','days','description','features','available','coaching','coachSessions','focusTags'])<>'{}'::jsonb then
  raise exception 'Send only the plan''s details.';
 end if;
 if jsonb_typeof(body->'id') is distinct from 'string' or body->>'id' !~ '^[a-z][a-z0-9_-]{1,30}$' then
  raise exception 'Plan ID: 2 to 31 lowercase letters, numbers, hyphens or underscores, starting with a letter.';
 end if;
 if jsonb_typeof(body->'name') is distinct from 'string' or length(btrim(body->>'name')) not between 2 and 60 or body->>'name' ~ '[<>\r\n]' then
  raise exception 'Enter a plan name of 2 to 60 characters, without < or >.';
 end if;
 if jsonb_typeof(body->'priceCents') is distinct from 'number' then raise exception 'Enter a price between PHP 0.01 and PHP 100,000.'; end if;
 if (body->>'priceCents')::numeric not between 1 and 10000000 or (body->>'priceCents')::numeric%1<>0 then raise exception 'Enter a price between PHP 0.01 and PHP 100,000.'; end if;
 if jsonb_typeof(body->'days') is distinct from 'number' then raise exception 'Enter a cycle length of 1 to 366 days.'; end if;
 if (body->>'days')::numeric not between 1 and 366 or (body->>'days')::numeric%1<>0 then raise exception 'Enter a cycle length of 1 to 366 days.'; end if;
 if jsonb_typeof(body->'description') is distinct from 'string' or length(btrim(body->>'description'))>200 or body->>'description' ~ '[<>\r\n]' then
  raise exception 'Keep the description to 200 characters, on one line, without < or >.';
 end if;
 if jsonb_typeof(body->'features') is distinct from 'array' or jsonb_array_length(body->'features')>10 then raise exception 'List up to 10 features.'; end if;
 for item in select value from jsonb_array_elements(body->'features') loop
  if jsonb_typeof(item) is distinct from 'string' or length(btrim(item#>>'{}')) not between 1 and 80 or item#>>'{}' ~ '[<>\r\n]' then
   raise exception 'Each feature is one line of 1 to 80 characters, without < or >.';
  end if;
  line:=btrim(item#>>'{}');
  if features ? line then raise exception 'List each feature once.'; end if;
  features:=features||to_jsonb(line);
 end loop;
 if jsonb_typeof(body->'available') is distinct from 'boolean' then raise exception 'Choose whether the plan is available for new cycles.'; end if;
 if jsonb_typeof(body->'coaching') is distinct from 'string' or body->>'coaching' not in ('none','group','personal') then
  raise exception 'Choose the coaching: no coach, group coaching or a personal coach.';
 end if;
 if jsonb_typeof(body->'coachSessions') is distinct from 'number' then raise exception 'Enter 0 to 30 coach sessions per cycle.'; end if;
 if (body->>'coachSessions')::numeric not between 0 and 30 or (body->>'coachSessions')::numeric%1<>0 then raise exception 'Enter 0 to 30 coach sessions per cycle.'; end if;
 if body->>'coaching'='none' and (body->>'coachSessions')::numeric<>0 then raise exception 'A plan with no coach has 0 coach sessions.'; end if;
 if jsonb_typeof(body->'focusTags') is distinct from 'array' or exists(select 1 from jsonb_array_elements(body->'focusTags') as f(t) where jsonb_typeof(t) is distinct from 'string') then
  raise exception 'Choose focus tags from strength, cardio, mobility and group classes.';
 end if;
 select array_agg(value) into tags from jsonb_array_elements_text(body->'focusTags');
 if coalesce(cardinality(tags),0)<>cardinality(ff_private.focus_tags(tags)) then raise exception 'Choose focus tags from strength, cardio, mobility and group classes, each once.'; end if;

 v.workspace:=a.workspace; v.id:=body->>'id'; v.name:=btrim(body->>'name');
 v.price_cents:=(body->>'priceCents')::numeric; v.days:=(body->>'days')::numeric; v.description:=btrim(body->>'description'); v.features:=features;
 v.available:=(body->>'available')::boolean; v.coaching:=body->>'coaching'; v.coach_sessions:=(body->>'coachSessions')::numeric; v.focus_tags:=ff_private.focus_tags(tags);
 -- One change to a workspace's plans at a time, held until commit and taken before anything below reads the catalog: a
 -- second administrator waits here, then checks names and "Everything in" references against what the first committed
 -- (each statement below sees the latest commit), so two changes can't create a loop or a line that names no plan.
 -- Each workspace has its own lock, so workspaces never wait on each other. Purchases don't take it.
 perform pg_advisory_xact_lock(hashtextextended('ff_plans:'||v.workspace,0));
 if exists(select 1 from public.ff_plans where workspace=v.workspace and lower(name)=lower(v.name) and id<>v.id) then raise exception 'Another plan already uses this name.'; end if;
 -- Each "Everything in <plan>" line names another plan of this workspace, and that plan doesn't include this one.
 for line in select value from jsonb_array_elements_text(v.features) loop
  continue when line !~* '^everything in .';
  if lower(btrim(substr(line,15)))=lower(v.name) then raise exception 'A plan can''t include itself. Remove "%".',line; end if;
  select r.* into ref from public.ff_plans r where r.workspace=v.workspace and r.id<>v.id and lower(r.name)=lower(btrim(substr(line,15)));
  if not found then raise exception '"%" names no other plan. After "Everything in", use another plan''s exact name.',line; end if;
  if ff_private.plan_reaches(v.workspace,ref.id,v.id) then raise exception '% already includes %, so % can''t include %.',ref.name,v.name,v.name,ref.name; end if;
 end loop;
 select * into p from public.ff_plans where workspace=v.workspace and id=v.id for update;
 if action='create' then
  if found then
   if (p.name,p.price_cents,p.days,p.description,p.features,p.available,p.coaching,p.coach_sessions,p.focus_tags)
    is not distinct from (v.name,v.price_cents,v.days,v.description,v.features,v.available,v.coaching,v.coach_sessions,v.focus_tags) then
    return to_jsonb(p)||'{"alreadySaved":true}'::jsonb;
   end if;
   raise exception 'A plan with this ID already exists. Choose another ID.';
  end if;
  perform set_config('ff.plan_admin','on',true);
  insert into public.ff_plans(workspace,id,name,price_cents,days,available,description,features,coaching,coach_sessions,focus_tags)
  values(v.workspace,v.id,v.name,v.price_cents,v.days,v.available,v.description,v.features,v.coaching,v.coach_sessions,v.focus_tags) returning * into saved;
 else
  if not found then raise exception 'Plan not found.'; end if;
  perform set_config('ff.plan_admin','on',true);
  update public.ff_plans set name=v.name,price_cents=v.price_cents,days=v.days,available=v.available,description=v.description,features=v.features,
   coaching=v.coaching,coach_sessions=v.coach_sessions,focus_tags=v.focus_tags
  where workspace=v.workspace and id=v.id returning * into saved;
  -- A renamed plan stays included where it was: the plans that include it take its new name in that line. Cycles
  -- already bought keep the line, and its list, as they were.
  if saved.name is distinct from p.name then
   with renamed as (
    update public.ff_plans x set features=(select jsonb_agg(case when f.line ~* '^everything in .' and lower(btrim(substr(f.line,15)))=lower(p.name)
      then 'Everything in '||saved.name else f.line end order by f.n) from jsonb_array_elements_text(x.features) with ordinality as f(line,n))
    where x.workspace=v.workspace and x.id<>v.id
     and exists(select 1 from jsonb_array_elements_text(x.features) as f(line) where f.line ~* '^everything in .' and lower(btrim(substr(f.line,15)))=lower(p.name))
    returning x.*)
   select coalesce(jsonb_agg(to_jsonb(renamed) order by renamed.id),'[]') into also from renamed;
  end if;
 end if;
 perform set_config('ff.plan_admin','',true);
 return to_jsonb(saved)||jsonb_build_object('alsoUpdated',also);
end $$;

create function public.ff_plan_admin(action text, body jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select ff_private.plan_admin(action,body) $$;

-- 4. Changed functions, from their latest definitions (Gate 1 has the diffs) ----------------------------------------
CREATE OR REPLACE FUNCTION ff_private.register_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Task 12A: the cycle keeps the terms the registration was bought with, not the plan as it is now.
  insert into public.ff_memberships(workspace,member_id,plan_id,start_date,end_date,terms) values(reg.workspace,u.id,reg.plan_id,reg.start_date,reg.end_date,reg.terms) returning id into membership;
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
end $function$;

CREATE OR REPLACE FUNCTION ff_private.paymongo_prepare(body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.ff_profiles; m public.ff_profiles; r public.ff_registrations; i public.ff_invoices; c public.ff_checkouts;
 request uuid; invoice uuid; description text; name text; email text; details jsonb;
begin
 a:=ff_private.actor();request:=(body->>'requestId')::uuid;
 if a.id is null or a.workspace not in ('production','demo') then raise exception 'PayMongo requires an authorized workspace account.' using errcode='42501'; end if;
 if (body->>'livemode')::boolean is distinct from false then raise exception 'Only PayMongo test mode is allowed.'; end if;
 if jsonb_typeof(body->'methods') is distinct from 'array' then raise exception 'Invalid checkout methods.'; end if;
 if jsonb_array_length(body->'methods')<1 or not (body->'methods') <@ '["gcash","paymaya","grab_pay","card"]'::jsonb then raise exception 'Invalid checkout methods.'; end if;
 if body->>'kind' not in ('registration','invoice','renewal') or body->>'kind' is null then raise exception 'Invalid checkout kind.'; end if;
 details:=jsonb_strip_nulls(jsonb_build_object('kind',body->>'kind','registrationId',body->>'registrationId','invoiceId',body->>'invoiceId','memberId',body->>'memberId','plan',body->>'plan','start',body->>'start'));
 if request is null then raise exception 'Checkout request is required.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.workspace||request::text,0));
 select * into c from public.ff_checkouts where id=request;
 if found then
  if c.workspace<>a.workspace or c.livemode or c.created_by<>a.id then raise exception 'Checkout request is unavailable.' using errcode='42501'; end if;
  if body->>'kind'='registration' and c.registration_id is distinct from (body->>'registrationId')::uuid then raise exception 'Request was used for another registration.'; end if;
  if body->>'kind'='invoice' and c.invoice_id is distinct from (body->>'invoiceId')::uuid then raise exception 'Request was used for another invoice.'; end if;
  if body->>'kind'='renewal' then
   if c.member_id is distinct from (body->>'memberId')::uuid or not exists(select 1 from public.ff_invoices x join public.ff_memberships y on y.id=x.membership_id where x.id=c.invoice_id and y.plan_id=body->>'plan' and y.start_date=(body->>'start')::date) then raise exception 'Request was used for another renewal.'; end if;
  end if;
  if c.request_details<>'{}'::jsonb and c.request_details is distinct from details then raise exception 'Request was used for different checkout details.'; end if;
  return jsonb_build_object('checkout',to_jsonb(c),'create',false);
 end if;
 if body->>'kind'='registration' then
  if a.role not in ('admin','staff') then raise exception 'Gym staff access is required.' using errcode='42501'; end if;
  if coalesce((body->>'emailConfirmed')::boolean,false) is not true then raise exception 'Check the member email first.'; end if;
  select * into r from public.ff_registrations where id=(body->>'registrationId')::uuid and workspace=a.workspace for update;
  if not found or r.status<>'awaiting_payment' then raise exception 'Registration is already paid or unavailable.'; end if;
  if r.end_date<ff_private.today() then raise exception 'Registration has expired.'; end if;
  select * into c from public.ff_checkouts where registration_id=r.id and status in ('creating','pending','needs_review');
  if found then return jsonb_build_object('checkout',to_jsonb(c),'create',false); end if;
  -- Task 12A: a registration keeps the terms it was made with, so it stays payable if its plan is retired since.
  description:=r.plan_name||' first membership';name:=r.name;email:=r.email;
 elsif body->>'kind' in ('invoice','renewal') then
  if body->>'kind'='renewal' then
   select * into m from public.ff_profiles where id=(body->>'memberId')::uuid and workspace=a.workspace and role='member' and enabled for update;
   if not found or (a.role not in ('admin','staff') and a.id<>m.id) then raise exception 'Member not found.' using errcode='42501'; end if;
   -- Task 12A: a cycle already created for this plan and start stays payable on its own terms, even if the plan is
   -- retired since; a new cycle still needs an available plan, which new_membership checks.
   select x.id into invoice from public.ff_invoices x join public.ff_memberships y on y.id=x.membership_id where x.workspace=a.workspace and x.member_id=m.id and y.plan_id=body->>'plan' and y.start_date=(body->>'start')::date;
   if invoice is null then invoice:=ff_private.new_membership(a.workspace,m.id,body->>'plan',(body->>'start')::date); end if;
  else invoice:=(body->>'invoiceId')::uuid; end if;
  select * into i from public.ff_invoices where id=invoice and workspace=a.workspace for update;
  if not found or (a.role not in ('admin','staff') and a.id<>i.member_id) then raise exception 'Invoice not found.' using errcode='42501'; end if;
  if i.amount_cents<=i.paid_cents then raise exception 'Invoice is already settled.'; end if;
  if exists(select 1 from public.ff_submissions where invoice_id=i.id and status='pending') then raise exception 'A payment submission is awaiting review. Do not pay again.'; end if;
  select * into c from public.ff_checkouts where invoice_id=i.id and status in ('creating','pending','needs_review');
  if found then return jsonb_build_object('checkout',to_jsonb(c),'create',false); end if;
  select * into m from public.ff_profiles where id=i.member_id and enabled;
  if not found then raise exception 'Member is disabled.'; end if;
  description:='Membership invoice';name:=m.name;email:=m.email;
 else raise exception 'Choose registration, renewal or invoice checkout.'; end if;
 if not (body->'methods') <@ '["gcash","paymaya","grab_pay","card"]'::jsonb or jsonb_array_length(body->'methods')<1 then raise exception 'Invalid checkout methods.'; end if;
 insert into public.ff_checkouts(id,workspace,created_by,member_id,registration_id,invoice_id,amount_cents,methods,livemode,request_details)
 values(request,a.workspace,a.id,m.id,r.id,i.id,coalesce(r.amount_cents,i.amount_cents-i.paid_cents),array(select jsonb_array_elements_text(body->'methods')),false,details) returning * into c;
 return jsonb_build_object('checkout',to_jsonb(c),'create',true,'description',description,'name',name,'email',email);
end $function$;

-- Grants: administrators call plan management through public.ff_plan_admin; the helpers are nobody's. The service key
-- has no use for it (and plan_admin refuses a caller without a session), so the hosted default grant to service_role
-- on new public functions is taken back too, leaving the same grants as a local stack.
revoke all on function ff_private.focus_tags(text[]),ff_private.plan_features_ok(jsonb),ff_private.plan_features_flat(text,jsonb,text[]),
 ff_private.plan_included(text,jsonb,text),ff_private.plan_reaches(text,text,text),ff_private.plan_terms(public.ff_plans,text),ff_private.terms_ok(jsonb),ff_private.purchased_terms(),
 ff_private.plan_guard(),ff_private.plan_admin(text,jsonb) from public,anon,authenticated;
grant execute on function ff_private.plan_admin(text,jsonb) to authenticated;
revoke all on function public.ff_plan_admin(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ff_plan_admin(text,jsonb) to authenticated;
NOTIFY pgrst, 'reload schema';
