-- Staff management from the admin portal. Additive only: one new table and one new
-- administrator-only command boundary. No existing table, policy, function or row is changed.
--
-- The server creates the Auth account through the Auth admin API, because SQL cannot create a
-- proper Auth user, and ff_private.register_auth_user then provisions a staff profile with no
-- membership or invoice. Every staff-management decision is made here, inside PostgreSQL,
-- through ff_private.actor(); src/api.js repeats the administrator gate.
--
-- Out of scope by design: promoting staff, demoting administrators and deleting accounts.
-- Accounts are disabled, never deleted, because payments and check-ins reference them.

-- Append-only audit trail. Only ff_private.staff_admin writes it; administrators read their
-- own workspace's rows.
create table public.ff_staff_audit (
 id uuid primary key default gen_random_uuid(),
 workspace text not null check (workspace in ('production','demo')),
 actor_id uuid not null,
 target_id uuid not null,
 action text not null check (action in ('create','update','enable','disable','resend')),
 details jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key (workspace,actor_id) references public.ff_profiles(workspace,id),
 foreign key (workspace,target_id) references public.ff_profiles(workspace,id)
);
create index ff_staff_audit_target on public.ff_staff_audit(target_id,action,created_at desc);
alter table public.ff_staff_audit enable row level security;
revoke all on public.ff_staff_audit from public,anon,authenticated,service_role;
grant select on public.ff_staff_audit to authenticated,service_role;
create policy ff_staff_audit_read on public.ff_staff_audit for select to authenticated
 using(workspace=(select ff_private.workspace()) and (select ff_private.is_admin()));

create function ff_private.staff_admin(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; t public.ff_profiles; v_name text; v_email text; v_phone text; v_enabled boolean; changed text[]:='{}';
begin
 a:=ff_private.actor();
 if a.id is null then raise exception 'Please sign in to continue.' using errcode='42501'; end if;
 if a.role<>'admin' then raise exception 'Administrator access is required.' using errcode='42501'; end if;

 -- Contact rules match the ff_profiles check constraints and src/validation.js.
 if action in ('prepare-create','update') then
  v_name:=trim(coalesce(body->>'name',''));
  if length(v_name) not between 2 and 70 or v_name ~ '[<>\r\n]' then raise exception 'Enter a full name between 2 and 70 characters.'; end if;
  if action='prepare-create' then
   v_email:=lower(trim(coalesce(body->>'email','')));
   if length(v_email)>100 or v_email !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then raise exception 'Enter a valid email address.'; end if;
  end if;
  v_phone:=regexp_replace(coalesce(body->>'phone',''),'[[:space:]()-]','','g');
  if v_phone like '+63%' then v_phone:='0'||substring(v_phone from 4); end if;
  if v_phone !~ '^09[0-9]{9}$' then raise exception 'Mobile number is required. Use 09XXXXXXXXX or +639XXXXXXXXX.'; end if;
 end if;

 if action='prepare-create' then
  -- Nothing is written here. An address already claimed anywhere, in any workspace and in any
  -- letter case, is refused before the server calls the Auth admin API.
  if exists(select 1 from auth.users u where lower(u.email)=v_email)
   or exists(select 1 from public.ff_profiles p where lower(p.email)=v_email)
   or exists(select 1 from public.ff_registrations r where lower(r.email)=v_email and r.status in ('awaiting_payment','paid')) then
   raise exception 'An account already uses this email.';
  end if;
  return jsonb_build_object('workspace',a.workspace,'name',v_name,'email',v_email,'phone',v_phone);
 end if;

 if action not in ('log-create','get','update','set-enabled','resend') then raise exception 'Unknown staff action.'; end if;
 -- Always the actor's own workspace. The row lock serializes concurrent changes to one account.
 select * into t from public.ff_profiles where id=(body->>'id')::uuid and workspace=a.workspace for update;
 if not found or t.role='member' then raise exception 'Staff member not found.'; end if;
 -- Administrators are out of scope here, so the workspace can never lose its last enabled one.
 if action='set-enabled' and t.id=a.id then raise exception 'Administrators can''t disable their own account.' using errcode='42501'; end if;
 if t.role<>'staff' then raise exception 'Administrators can''t be changed here.' using errcode='42501'; end if;

 if action='get' then
  return to_jsonb(t)||jsonb_build_object('lastResendAt',(select max(s.created_at) from public.ff_staff_audit s where s.target_id=t.id and s.action='resend'));
 elsif action='log-create' then
  -- Records a staff profile the server has just provisioned, once.
  if exists(select 1 from public.ff_staff_audit s where s.target_id=t.id and s.action='create') then raise exception 'This staff account was already recorded.'; end if;
  if t.created_at<now()-interval '15 minutes' then raise exception 'Only a newly created staff account can be recorded.'; end if;
  insert into public.ff_staff_audit(workspace,actor_id,target_id,action,details) values(a.workspace,a.id,t.id,'create',jsonb_build_object('email',t.email));
  return to_jsonb(t);
 elsif action='update' then
  if v_name is distinct from t.name then changed:=changed||'name'::text; end if;
  if v_phone is distinct from t.phone then changed:=changed||'phone'::text; end if;
  -- Name and mobile only. Role, workspace and email are never written here.
  update public.ff_profiles set name=v_name,phone=v_phone where id=t.id returning * into t;
  insert into public.ff_staff_audit(workspace,actor_id,target_id,action,details) values(a.workspace,a.id,t.id,'update',jsonb_build_object('fields',to_jsonb(changed)));
  return to_jsonb(t);
 elsif action='set-enabled' then
  if jsonb_typeof(body->'enabled') is distinct from 'boolean' then raise exception 'Choose whether the account is enabled.'; end if;
  v_enabled:=(body->>'enabled')::boolean;
  update public.ff_profiles set enabled=v_enabled where id=t.id returning * into t;
  -- ff_private.actor() already refuses a disabled profile on every request. Deleting the sessions
  -- as well revokes their refresh tokens, so an open session can't be refreshed, and it can't
  -- come back to life if the account is enabled again later.
  if not v_enabled then delete from auth.sessions where user_id=t.id; end if;
  insert into public.ff_staff_audit(workspace,actor_id,target_id,action) values(a.workspace,a.id,t.id,case when v_enabled then 'enable' else 'disable' end);
  return to_jsonb(t);
 else
  if not t.enabled then raise exception 'Enable this account before resending the setup link.'; end if;
  -- The audit row is the sending claim. With the row lock above, a double-click or a second
  -- administrator can't send another link to the same person within 60 seconds.
  if exists(select 1 from public.ff_staff_audit s where s.target_id=t.id and s.action='resend' and s.created_at>now()-interval '60 seconds') then
   raise exception 'A setup link was sent less than a minute ago. Wait a minute, then try again.' using errcode='PT429';
  end if;
  insert into public.ff_staff_audit(workspace,actor_id,target_id,action,details) values(a.workspace,a.id,t.id,'resend',jsonb_build_object('email',t.email));
  return to_jsonb(t);
 end if;
end $$;
revoke all on function ff_private.staff_admin(text,jsonb) from public,anon,authenticated;
grant execute on function ff_private.staff_admin(text,jsonb) to authenticated;
create function public.ff_staff_admin(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.staff_admin(action,body) $$;
revoke all on function public.ff_staff_admin(text,jsonb) from public,anon;
grant execute on function public.ff_staff_admin(text,jsonb) to authenticated;
NOTIFY pgrst, 'reload schema';
