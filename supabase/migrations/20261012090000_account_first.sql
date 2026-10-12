-- Task 10: account-first registration, and clean-up of member accounts that never paid.

-- 1. A member account can start without a plan: staff create the account first, and the member (or
-- staff at the desk) chooses a plan later through the existing renew → invoice path. Scripts and seeds
-- that pass a plan still get their first cycle and invoice. Everything else is unchanged.
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
 values(u.id,w,r,trim(d->>'name'),lower(u.email),phone,left(coalesce(nullif(trim(d->>'goal'),''),'Improve fitness'),100));
 if r='member' and nullif(trim(coalesce(d->>'plan','')),'') is not null then perform ff_private.new_membership(w,u.id,d->>'plan',(d->>'start')::date); end if;
 return new;
end $$;

-- 2. Gym staff create member accounts. The server creates the Auth user with the service key, so the
-- database checks first that the caller is gym staff and that no account uses the email.
create function ff_private.member_admin(action text,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles;
begin
 a:=ff_private.actor();
 if a.id is null or a.role not in ('admin','staff') then raise exception using errcode='42501',message='Gym staff access is required.'; end if;
 if action='prepare-create' then return jsonb_build_object('email',ff_private.claim_email(body->>'email'),'workspace',a.workspace); end if;
 raise exception 'Unknown member action.';
end $$;

-- 3. The clean-up log: one row per deleted account, written only by ff_private.delete_never_paid.
-- Administrators can read it; nobody can insert, change or remove rows directly.
create table public.ff_account_cleanup_log(
 id uuid primary key default gen_random_uuid(),
 workspace text not null check (workspace in ('production','demo')),
 account_id uuid not null,
 email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
 account_created_at timestamptz not null,
 age_days integer not null check (age_days>=0),
 deleted_by uuid,
 actor text not null check (actor in ('admin','automatic')),
 reason text not null check (length(reason) between 1 and 200),
 details jsonb not null default '{}',
 deleted_at timestamptz not null default now(),
 check ((actor='admin')=(deleted_by is not null))
);
alter table public.ff_account_cleanup_log enable row level security;
create policy ff_account_cleanup_log_read on public.ff_account_cleanup_log for select to authenticated
 using (workspace=(select ff_private.workspace()) and (select ff_private.is_admin()));
revoke all on public.ff_account_cleanup_log from public,anon,authenticated,service_role;
grant select on public.ff_account_cleanup_log to authenticated,service_role;
create function ff_private.append_only() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'This log is append-only.'; end $$;
create trigger ff_account_cleanup_log_append_only before update or delete on public.ff_account_cleanup_log
 for each row execute function ff_private.append_only();

-- 4. A deleted account's closed online checkouts stay as history, detached from the account: no member,
-- invoice or (if the member started it) creator, with detached_at set. Open checkouts are never detached.
alter table public.ff_checkouts alter column created_by drop not null, add column detached_at timestamptz;
alter table public.ff_checkouts drop constraint ff_checkouts_check,
 add constraint ff_checkouts_target check (detached_at is not null or ((registration_id is null) <> (invoice_id is null)));

-- 5. Never-paid: a member account with no payment ever, no paid checkout and no payment submission
-- waiting for review. Anything else that ties money or a visit to the account also blocks deletion;
-- those accounts can only be disabled. An empty array means the account can be deleted.
create function ff_private.cleanup_blockers(m public.ff_profiles) returns text[]
language sql stable security definer set search_path='' as $$
 select array_remove(array[
  case when m.role<>'member' then 'Only never-paid member accounts can be deleted. Staff and administrator accounts can only be disabled.' end,
  case when exists(select 1 from public.ff_payments p where p.member_id=m.id) then 'Only never-paid member accounts can be deleted. This one has a payment on record, so it can only be disabled.' end,
  case when exists(select 1 from public.ff_checkouts c where c.status='paid' and (c.member_id=m.id or c.invoice_id in (select i.id from public.ff_invoices i where i.member_id=m.id))) then 'Only never-paid member accounts can be deleted. This one has a paid online checkout, so it can only be disabled.' end,
  case when exists(select 1 from public.ff_submissions s where s.member_id=m.id and s.status='pending') then 'Only never-paid member accounts can be deleted. This one has a payment submission waiting for review.' end,
  case when exists(select 1 from public.ff_invoices i where i.member_id=m.id and i.paid_cents>0) then 'Only never-paid member accounts can be deleted. This one has a paid or partly paid invoice, so it can only be disabled.' end,
  case when exists(select 1 from public.ff_checkins k where k.member_id=m.id) then 'Only never-paid member accounts can be deleted. This one has check-ins on record, so it can only be disabled.' end,
  case when exists(select 1 from public.ff_registrations r where r.member_id=m.id or r.created_by=m.id or r.paid_by=m.id) then 'Only never-paid member accounts can be deleted. This one is linked to a first registration on record.' end,
  case when exists(select 1 from public.ff_paymongo_attempts t where t.member_id=m.id) then 'Only never-paid member accounts can be deleted. This one has retired online payment attempts on record.' end,
  case when exists(select 1 from public.ff_staff_audit s where s.actor_id=m.id or s.target_id=m.id) then 'Only never-paid member accounts can be deleted. This one appears in the staff audit log.' end
 ],null) $$;
create function ff_private.open_checkouts(m uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'sessionId',coalesce(c.session_id,c.review_details->>'sessionId')) order by c.created_at),'[]')
 from public.ff_checkouts c where c.status in ('creating','pending','needs_review')
  and (c.member_id=m or c.invoice_id in (select i.id from public.ff_invoices i where i.member_id=m)) $$;
-- Never-paid member accounts at least min_age old, with their age in days (Manila dates).
create function ff_private.unpaid_accounts(w text,min_age interval) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'email',p.email,'phone',p.phone,'createdAt',p.created_at,
   'ageDays',greatest(0,ff_private.today()-(p.created_at at time zone 'Asia/Manila')::date),'enabled',p.enabled,
   'hasPlan',exists(select 1 from public.ff_memberships ms where ms.member_id=p.id),'openCheckouts',ff_private.open_checkouts(p.id)) order by p.created_at),'[]')
 from public.ff_profiles p
 where p.workspace=w and p.role='member' and p.created_at<=now()-min_age and cardinality(ff_private.cleanup_blockers(p))=0 $$;

-- 6. Deletes one never-paid account: the Auth user, the profile, unpaid cycles and invoices, rejected
-- payment submissions and unsent notifications. Payments, paid invoices, check-ins and the staff audit log
-- are never deleted; an account with any of them is refused above. The server has already asked PayMongo
-- about every open online checkout and passes the confirmed expiries in "expired".
create function ff_private.delete_never_paid(member uuid,w text,by_user uuid,actor text,reason text,expired jsonb,min_age interval) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.ff_profiles; blockers text[]; e jsonb; c public.ff_checkouts; v_detached integer; v_submissions integer; v_notifications integer; v_invoices integer; v_cycles integer;
begin
 select * into m from public.ff_profiles where id=member and workspace=w for update;
 if not found then raise exception 'Account not found.'; end if;
 blockers:=ff_private.cleanup_blockers(m);
 if cardinality(blockers)>0 then raise exception using errcode='42501',message=blockers[1]; end if;
 if m.created_at>now()-min_age then raise exception 'This account is newer than 7 days, so automatic clean-up leaves it.'; end if;
 -- Online checkouts that PayMongo confirmed expired a moment ago.
 for e in select * from jsonb_array_elements(coalesce(expired,'[]')) loop
  select * into c from public.ff_checkouts where id=(e->>'id')::uuid and workspace=w for update;
  if not found or c.status not in ('creating','pending','needs_review')
   or not coalesce(c.member_id=m.id or c.invoice_id in (select i.id from public.ff_invoices i where i.member_id=m.id),false) then raise exception 'That checkout does not belong to this account.'; end if;
  if e->>'sessionId' is distinct from coalesce(c.session_id,c.review_details->>'sessionId') then raise exception 'Checkout is bound to another session.'; end if;
  if jsonb_typeof(e->'providerStatus') is distinct from 'number' or e->>'via' is null or e->>'via' not in ('expire','already_expired') then raise exception 'PayMongo confirmation is incomplete.'; end if;
  update public.ff_checkouts set status='expired',session_id=coalesce(session_id,e->>'sessionId'),review_reason=null,
   review_log=review_log||jsonb_build_array(jsonb_build_object('action','cancel','by',by_user,'actor',actor,'at',now(),'sessionId',e->>'sessionId',
    'providerStatus',(e->>'providerStatus')::integer,'sessionStatus','expired','via',e->>'via','reason','account clean-up'))
  where id=c.id;
 end loop;
 if jsonb_array_length(ff_private.open_checkouts(m.id))>0 then raise exception 'An online checkout for this account is still open. Close it first.'; end if;
 update public.ff_checkouts set member_id=null,invoice_id=null,created_by=case when created_by=m.id then null else created_by end,detached_at=now(),
  review_log=review_log||jsonb_build_array(jsonb_build_object('action','detach','at',now(),'reason','account clean-up'))
 where member_id=m.id or created_by=m.id or invoice_id in (select i.id from public.ff_invoices i where i.member_id=m.id);
 get diagnostics v_detached=row_count;
 delete from public.ff_submissions where member_id=m.id and status='rejected'; get diagnostics v_submissions=row_count;
 -- Unsent notifications go; sent ones stay as the delivery record, detached from the account.
 delete from public.ff_notifications where member_id=m.id and status<>'sent'; get diagnostics v_notifications=row_count;
 update public.ff_notifications set member_id=null where member_id=m.id;
 -- Survey answers: delete them here once that table exists.
 delete from public.ff_invoices where member_id=m.id; get diagnostics v_invoices=row_count;
 delete from public.ff_memberships where member_id=m.id; get diagnostics v_cycles=row_count;
 delete from public.ff_profiles where id=m.id;
 delete from auth.users where id=m.id;
 insert into public.ff_account_cleanup_log(workspace,account_id,email_hash,account_created_at,age_days,deleted_by,actor,reason,details)
 values(w,m.id,encode(extensions.digest(lower(m.email),'sha256'),'hex'),m.created_at,greatest(0,ff_private.today()-(m.created_at at time zone 'Asia/Manila')::date),by_user,actor,reason,
  jsonb_build_object('checkoutsExpired',jsonb_array_length(coalesce(expired,'[]')),'checkoutsDetached',v_detached,'rejectedSubmissions',v_submissions,
   'unsentNotifications',v_notifications,'invoices',v_invoices,'cycles',v_cycles));
 return jsonb_build_object('deleted',m.id,'checkoutsExpired',jsonb_array_length(coalesce(expired,'[]')));
end $$;

-- 7. Entry points. Administrators: list never-paid accounts, check one, delete one (any age).
create function ff_private.account_cleanup(action text,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; m public.ff_profiles;
begin
 a:=ff_private.actor();
 if a.id is null or a.role<>'admin' then raise exception using errcode='42501',message='Administrator access is required.'; end if;
 if action='list' then return ff_private.unpaid_accounts(a.workspace,'0'::interval); end if;
 if action='check' then
  select * into m from public.ff_profiles where id=(body->>'id')::uuid and workspace=a.workspace;
  if not found then raise exception 'Account not found.'; end if;
  return jsonb_build_object('blockers',to_jsonb(ff_private.cleanup_blockers(m)),'openCheckouts',ff_private.open_checkouts(m.id));
 end if;
 if action='delete' then return ff_private.delete_never_paid((body->>'id')::uuid,a.workspace,a.id,'admin','Deleted by an administrator (force clean-up).',body->'expired','0'::interval); end if;
 raise exception 'Unknown clean-up action.';
end $$;
-- The daily job (the server, with the service key): never-paid accounts older than 7 days only.
create function ff_private.account_cleanup_auto(action text,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w text:=body->>'workspace';
begin
 if w is null or w not in ('production','demo') then raise exception 'Workspace is required.'; end if;
 if action='due' then return ff_private.unpaid_accounts(w,'7 days'::interval); end if;
 if action='delete' then return ff_private.delete_never_paid((body->>'id')::uuid,w,null,'automatic','Never paid within 7 days (automatic clean-up).',body->'expired','7 days'::interval); end if;
 raise exception 'Unknown clean-up action.';
end $$;

revoke all on function ff_private.member_admin(text,jsonb),ff_private.account_cleanup(text,jsonb),ff_private.account_cleanup_auto(text,jsonb),
 ff_private.cleanup_blockers(public.ff_profiles),ff_private.open_checkouts(uuid),ff_private.unpaid_accounts(text,interval),
 ff_private.delete_never_paid(uuid,text,uuid,text,text,jsonb,interval),ff_private.append_only() from public,anon,authenticated,service_role;
grant execute on function ff_private.member_admin(text,jsonb),ff_private.account_cleanup(text,jsonb) to authenticated;
grant execute on function ff_private.account_cleanup_auto(text,jsonb) to service_role;
create function public.ff_member_admin(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.member_admin(action,body) $$;
create function public.ff_account_cleanup(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.account_cleanup(action,body) $$;
create function public.ff_account_cleanup_auto(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.account_cleanup_auto(action,body) $$;
revoke all on function public.ff_member_admin(text,jsonb),public.ff_account_cleanup(text,jsonb),public.ff_account_cleanup_auto(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ff_member_admin(text,jsonb),public.ff_account_cleanup(text,jsonb) to authenticated;
grant execute on function public.ff_account_cleanup_auto(text,jsonb) to service_role;
NOTIFY pgrst, 'reload schema';
