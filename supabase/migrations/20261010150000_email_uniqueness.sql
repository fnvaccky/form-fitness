-- One email, one account (BUG-010). Every create path refuses an email that any Auth user, profile
-- or registration already uses, in any workspace, for any role and in any letter case, with
-- "An account already uses this email." The rule lives in one place, ff_private.claim_email, and is
-- serialized with an advisory lock on the lower-cased address.
--
-- Callers: member registration (ff_private.registration), staff creation (ff_private.staff_admin,
-- an early check before the Auth admin API call), and the Auth trigger ff_private.register_auth_user,
-- which every new app account passes through (paid-first provisioning, staff, create-admin and seed
-- scripts). Auth users created without RepReady metadata (for example in the Supabase dashboard) get
-- no profile and are not checked by the trigger, but every app path treats their email as taken.
-- Gmail dots and +tags are not normalized: they are different addresses.
-- Additive: no row is changed or deleted.

-- Serializes concurrent claims of one address until the calling transaction ends.
create function ff_private.lock_email(candidate text) returns text
language plpgsql security definer set search_path='' as $$
declare e text:=lower(trim(coalesce(candidate,'')));
begin
 perform pg_advisory_xact_lock(hashtextextended('ff_email:'||e,0));
 return e;
end $$;

-- The one shared check. own_registration and own_user let the Auth trigger ignore the registration
-- being provisioned and the account being created.
create function ff_private.claim_email(candidate text, own_registration uuid default null, own_user uuid default null) returns text
language plpgsql security definer set search_path='' as $$
declare e text:=ff_private.lock_email(candidate);
begin
 if exists(select 1 from auth.users u where lower(trim(u.email))=e and u.id is distinct from own_user)
  or exists(select 1 from public.ff_profiles p where lower(trim(p.email))=e and p.id is distinct from own_user)
  or exists(select 1 from public.ff_registrations r where lower(trim(r.email))=e and r.id is distinct from own_registration) then
  raise exception 'An account already uses this email.';
 end if;
 return e;
end $$;
revoke all on function ff_private.lock_email(text),ff_private.claim_email(text,uuid,uuid) from public,anon,authenticated,service_role;

-- Member registration: the body is the current one from 20261001213203 with two changes: the
-- advisory lock key is the shared per-address lock, and both duplicate checks are the shared rule.
create or replace function ff_private.registration(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; p public.ff_plans; r public.ff_registrations; starts date; e text; request uuid;
begin
 a:=ff_private.actor();
 if a.id is null or a.role not in ('admin','staff') then raise exception 'Gym staff access is required.' using errcode='42501'; end if;
 if a.workspace not in ('production','demo') then raise exception 'Registration workspace is unavailable.'; end if;
 if action='create' then
  e:=lower(trim(body->>'email'));request:=(body->>'requestId')::uuid;
  if request is null or e is null or length(e)>100 or e !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then raise exception 'Invalid registration email or request.'; end if;
  -- The same per-address lock as ff_private.claim_email, taken before the idempotency check.
  perform ff_private.lock_email(e);
  select * into r from public.ff_registrations where workspace=a.workspace and request_id=request;
  if found then
   if r.email<>e or r.plan_id<>body->>'plan' or r.start_date<>(body->>'start')::date or r.name<>trim(body->>'name') or r.phone<>body->>'phone' or r.goal<>left(coalesce(body->>'goal','Improve fitness'),100) then raise exception 'Registration request was used for different details.'; end if;
   return to_jsonb(r);
  end if;
  -- One email, one account: no account, profile or registration in any workspace may use it.
  perform ff_private.claim_email(e);
  select * into p from public.ff_plans where workspace=a.workspace and id=body->>'plan' and available for share;
  if not found then raise exception 'Select an available plan.'; end if;
  starts:=(body->>'start')::date;
  if starts is null or starts<ff_private.today() or starts>ff_private.today()+365 then raise exception 'Choose a valid start date.'; end if;
  insert into public.ff_registrations(workspace,request_id,name,email,phone,goal,plan_id,plan_name,features,days,start_date,end_date,amount_cents,created_by)
  values(a.workspace,request,trim(body->>'name'),e,body->>'phone',left(coalesce(body->>'goal','Improve fitness'),100),p.id,p.name,p.features,p.days,starts,starts+p.days-1,p.price_cents,a.id) returning * into r;
 elsif action in ('cash','get') then
  select * into r from public.ff_registrations where id=(body->>'id')::uuid and workspace=a.workspace for update;
  if not found then raise exception 'Registration not found.'; end if;
  if action='cash' then
   if coalesce((body->>'verified')::boolean,false) is not true or coalesce((body->>'emailConfirmed')::boolean,false) is not true then raise exception 'Confirm the email and cash received first.'; end if;
   if body->>'method' is distinct from 'Cash' or (body->>'amountCents')::integer is distinct from r.amount_cents then raise exception 'First payment must be the full cash amount.'; end if;
   if r.status='awaiting_payment' then
    if r.end_date<ff_private.today() then raise exception 'This registration has expired. Contact an administrator before collecting payment.'; end if;
    request:=(body->>'idempotencyKey')::uuid;
    if request is null then raise exception 'Payment request is required.'; end if;
    update public.ff_registrations set status='paid',paid_by=a.id,paid_at=now(),payment_request=request where id=r.id returning * into r;
   end if;
  end if;
 else raise exception 'Unknown registration action.';
 end if;
 return to_jsonb(r);
end $$;

-- Staff creation: the body is the current one from 20261010140000 with its inline duplicate check
-- replaced by the shared rule.
create or replace function ff_private.staff_admin(action text, body jsonb) returns jsonb
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
  -- Nothing is written here. The shared rule refuses an address any account, profile or
  -- registration already uses; the Auth trigger applies it again when the account is created.
  perform ff_private.claim_email(v_email);
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

-- Every new app account: the body is the current one from 20261001213203 with the shared rule added
-- to both branches.
create or replace function ff_private.register_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb; w text; r text; phone text; u auth.users; reg public.ff_registrations; membership uuid; invoice uuid; payment uuid;
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
 values(u.id,w,r,trim(d->>'name'),lower(u.email),phone,left(coalesce(d->>'goal','Improve fitness'),100));
 if r='member' then perform ff_private.new_membership(w,u.id,d->>'plan',(d->>'start')::date); end if;
 return new;
end $$;

-- Database backstops behind the shared rule. Live had no duplicate when these were added.
create unique index ff_profiles_email_lower on public.ff_profiles (lower(email));
create unique index ff_registrations_open_email_lower on public.ff_registrations (lower(email)) where status in ('awaiting_payment','paid');
NOTIFY pgrst, 'reload schema';
