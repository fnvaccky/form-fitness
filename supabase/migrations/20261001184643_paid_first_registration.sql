-- Pending registrations have no Auth account until a verified full cash payment.
create table public.ff_registrations (
 id uuid primary key default gen_random_uuid(), workspace text not null check(workspace='production'),
 request_id uuid not null, name text not null check(length(name) between 2 and 70 and name !~ '[<>\r\n]'),
 email text not null, phone text not null check(phone ~ '^09[0-9]{9}$'), goal text not null default 'Improve fitness',
 plan_id text not null, plan_name text not null, features jsonb not null, days integer not null,
 start_date date not null, end_date date not null, amount_cents integer not null check(amount_cents>0),
 status text not null default 'awaiting_payment' check(status in ('awaiting_payment','paid','provisioned')),
 created_by uuid not null references public.ff_profiles(id), created_at timestamptz not null default now(),
 paid_by uuid references public.ff_profiles(id), paid_at timestamptz, payment_request uuid unique,
 member_id uuid unique references public.ff_profiles(id),
 email_status text not null default 'queued' check(email_status in ('queued','sending','sent','failed','needs_review')),
 email_claimed_at timestamptz, email_sent_at timestamptz,
 unique(workspace,request_id), unique(workspace,email),
 foreign key(workspace,plan_id) references public.ff_plans(workspace,id)
);
alter table public.ff_registrations enable row level security;
revoke all on public.ff_registrations from public,anon,authenticated;
grant select on public.ff_registrations to authenticated;
grant all on public.ff_registrations to service_role;
create policy ff_registration_staff_read on public.ff_registrations for select to authenticated
 using(workspace=(select ff_private.workspace()) and (select ff_private.is_gym_staff()));
create index ff_registration_queue on public.ff_registrations(workspace,status,created_at);

create function ff_private.registration(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; p public.ff_plans; r public.ff_registrations; starts date; e text; request uuid;
begin
 a:=ff_private.actor();
 if a.id is null or a.role not in ('admin','staff') then raise exception 'Gym staff access is required.' using errcode='42501'; end if;
 if a.workspace<>'production' then raise exception 'Registration is unavailable in demo.'; end if;
 if action='create' then
  e:=lower(trim(body->>'email'));request:=(body->>'requestId')::uuid;
  if request is null or e is null or length(e)>100 or e !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then raise exception 'Invalid registration email or request.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.workspace||e,0));
  select * into r from public.ff_registrations where workspace=a.workspace and request_id=request;
  if found then
   if r.email<>e or r.plan_id<>body->>'plan' or r.start_date<>(body->>'start')::date or r.name<>trim(body->>'name') or r.phone<>body->>'phone' or r.goal<>left(coalesce(body->>'goal','Improve fitness'),100) then raise exception 'Registration request was used for different details.'; end if;
   return to_jsonb(r);
  end if;
  if exists(select 1 from auth.users where lower(email)=e) or exists(select 1 from public.ff_profiles where lower(email)=e) then raise exception 'An account already uses this email. Use walk-in renewal.'; end if;
  if exists(select 1 from public.ff_registrations where workspace=a.workspace and email=e) then raise exception 'A registration already uses this email. Continue it from Payments.'; end if;
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
revoke all on function ff_private.registration(text,jsonb) from public,anon,authenticated;
grant execute on function ff_private.registration(text,jsonb) to authenticated;
create function public.ff_registration(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.registration(action,body) $$;
revoke all on function public.ff_registration(text,jsonb) from public,anon;
grant execute on function public.ff_registration(text,jsonb) to authenticated;

-- One transaction creates a cycle and records a full cash renewal. Replay creates neither twice.
create function ff_private.walkin_renew(body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; m public.ff_profiles; p public.ff_plans; inv public.ff_invoices; cycle public.ff_memberships; pay public.ff_payments; invoice uuid; request uuid;
begin
 a:=ff_private.actor();
 if a.id is null or a.role not in ('admin','staff') then raise exception 'Gym staff access is required.' using errcode='42501'; end if;
 if coalesce((body->>'verified')::boolean,false) is not true then raise exception 'Confirm cash received first.'; end if;
 request:=(body->>'idempotencyKey')::uuid;
 if request is null then raise exception 'Payment request is required.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.workspace||request::text,0));
 select * into pay from public.ff_payments where workspace=a.workspace and idempotency_key=request;
 if found then
  select * into inv from public.ff_invoices where id=pay.invoice_id;
  select * into cycle from public.ff_memberships where id=inv.membership_id;
  if pay.member_id is distinct from (body->>'memberId')::uuid or cycle.plan_id is distinct from body->>'plan' or cycle.start_date is distinct from (body->>'start')::date or pay.amount_cents is distinct from (body->>'amountCents')::integer or pay.method<>'Cash' then raise exception 'Request ID was used for a different renewal.'; end if;
  return jsonb_build_object('payment',to_jsonb(pay),'alreadyProcessed',true);
 end if;
 select * into m from public.ff_profiles where workspace=a.workspace and id=(body->>'memberId')::uuid and role='member' and enabled for update;
 if not found then raise exception 'Member not found.'; end if;
 select * into p from public.ff_plans where workspace=a.workspace and id=body->>'plan' and available for share;
 if not found or p.price_cents is distinct from (body->>'amountCents')::integer then raise exception 'Plan price changed. Review the full cash amount.'; end if;
 invoice:=ff_private.new_membership(a.workspace,m.id,p.id,(body->>'start')::date);
 return ff_private.command('payments',jsonb_build_object('invoiceId',invoice,'amountCents',p.price_cents,'method','Cash','verified',true,'idempotencyKey',request));
end $$;
revoke all on function ff_private.walkin_renew(jsonb) from public,anon,authenticated;
grant execute on function ff_private.walkin_renew(jsonb) to authenticated;
create function public.ff_walkin_renew(body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.walkin_renew(body) $$;
revoke all on function public.ff_walkin_renew(jsonb) from public,anon;
grant execute on function public.ff_walkin_renew(jsonb) to authenticated;

create or replace function ff_private.register_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb; w text; r text; phone text; u auth.users; reg public.ff_registrations; membership uuid; invoice uuid; payment uuid;
begin
 select * into u from auth.users where id=new.id;
 d:=u.raw_user_meta_data;
 if coalesce(d->>'form_fitness','')<>'true' then return new; end if;
 if u.raw_app_meta_data ? 'ff_registration' then
  select * into reg from public.ff_registrations where id=(u.raw_app_meta_data->>'ff_registration')::uuid for update;
  if not found or reg.status<>'paid' or reg.member_id is not null or lower(u.email)<>reg.email or reg.workspace<>'production' then raise exception 'A fully paid registration is required before account creation.'; end if;
  insert into public.ff_profiles(id,workspace,role,name,email,phone,goal) values(u.id,reg.workspace,'member',reg.name,reg.email,reg.phone,reg.goal);
  insert into public.ff_memberships(workspace,member_id,plan_id,start_date,end_date) values(reg.workspace,u.id,reg.plan_id,reg.start_date,reg.end_date) returning id into membership;
  insert into public.ff_invoices(workspace,member_id,membership_id,amount_cents,paid_cents) values(reg.workspace,u.id,membership,reg.amount_cents,reg.amount_cents) returning id into invoice;
  insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,payment_date,recorded_by)
  values(reg.workspace,u.id,invoice,reg.amount_cents,'Cash','','CASH:'||reg.payment_request,reg.payment_request,(reg.paid_at at time zone 'Asia/Manila')::date,reg.paid_by) returning id into payment;
  update public.ff_registrations set status='provisioned',member_id=u.id where id=reg.id;
  perform ff_private.notify(reg.workspace,u.id,'RepReady payment confirmed','Your first membership payment was confirmed. Your account setup email follows separately.','payment:'||payment);
  return new;
 end if;

 if coalesce(u.raw_app_meta_data->>'ff_workspace','') not in ('production','demo') then raise exception 'First membership accounts require paid registration.'; end if;
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

NOTIFY pgrst, 'reload schema';
