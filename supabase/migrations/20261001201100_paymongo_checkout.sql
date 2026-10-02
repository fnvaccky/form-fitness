-- Provider checkouts are durable before the outbound API call. Only the server may settle them.
alter table public.ff_payments drop constraint ff_payments_method_check;
alter table public.ff_payments add constraint ff_payments_method_check check(method in ('Cash','GCash','Bank transfer','Maya','GrabPay','Card'));
alter table public.ff_registrations add column payment_method text not null default 'Cash';
alter table public.ff_registrations add column payment_reference text not null default '';

create table public.ff_checkouts (
 id uuid primary key, workspace text not null check(workspace='production'),
 created_by uuid not null references public.ff_profiles(id), member_id uuid references public.ff_profiles(id),
 registration_id uuid references public.ff_registrations(id), invoice_id uuid references public.ff_invoices(id),
 amount_cents integer not null check(amount_cents>0), methods text[] not null, livemode boolean not null,
 status text not null default 'creating' check(status in ('creating','pending','paid','failed','needs_review','expired')),
 session_id text unique, checkout_url text, payment_id text unique, created_at timestamptz not null default now(), paid_at timestamptz,
 check((registration_id is null)<>(invoice_id is null))
);
create unique index ff_checkout_registration_open on public.ff_checkouts(registration_id) where status in ('creating','pending','needs_review');
create unique index ff_checkout_invoice_open on public.ff_checkouts(invoice_id) where status in ('creating','pending','needs_review');
create index ff_checkouts_creator on public.ff_checkouts(created_by);
create index ff_checkouts_member on public.ff_checkouts(member_id);
alter table public.ff_checkouts enable row level security;
revoke all on public.ff_checkouts from public,anon,authenticated;
grant select on public.ff_checkouts to authenticated;
grant all on public.ff_checkouts to service_role;
create policy ff_checkout_read on public.ff_checkouts for select to authenticated
 using(workspace=(select ff_private.workspace()) and ((select ff_private.is_gym_staff()) or member_id=(select auth.uid())));

create function ff_private.paymongo_prepare(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; m public.ff_profiles; r public.ff_registrations; i public.ff_invoices; c public.ff_checkouts;
 request uuid; invoice uuid; description text; name text; email text;
begin
 a:=ff_private.actor();request:=(body->>'requestId')::uuid;
 if a.id is null or a.workspace<>'production' then raise exception 'Sign in to the production workspace.' using errcode='42501'; end if;
 if request is null then raise exception 'Checkout request is required.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.workspace||request::text,0));
 select * into c from public.ff_checkouts where id=request;
 if found then
  if c.workspace<>a.workspace or c.created_by<>a.id then raise exception 'Checkout request is unavailable.' using errcode='42501'; end if;
  if body->>'kind'='registration' and c.registration_id is distinct from (body->>'registrationId')::uuid then raise exception 'Request was used for another registration.'; end if;
  if body->>'kind'='invoice' and c.invoice_id is distinct from (body->>'invoiceId')::uuid then raise exception 'Request was used for another invoice.'; end if;
  if body->>'kind'='renewal' then
   if c.member_id is distinct from (body->>'memberId')::uuid or not exists(select 1 from public.ff_invoices x join public.ff_memberships y on y.id=x.membership_id where x.id=c.invoice_id and y.plan_id=body->>'plan' and y.start_date=(body->>'start')::date) then raise exception 'Request was used for another renewal.'; end if;
  end if;
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
  description:=r.plan_name||' first membership';name:=r.name;email:=r.email;
 elsif body->>'kind' in ('invoice','renewal') then
  if body->>'kind'='renewal' then
   select * into m from public.ff_profiles where id=(body->>'memberId')::uuid and workspace=a.workspace and role='member' and enabled for update;
   if not found or (a.role not in ('admin','staff') and a.id<>m.id) then raise exception 'Member not found.' using errcode='42501'; end if;
   invoice:=ff_private.new_membership(a.workspace,m.id,body->>'plan',(body->>'start')::date);
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
 insert into public.ff_checkouts(id,workspace,created_by,member_id,registration_id,invoice_id,amount_cents,methods,livemode)
 values(request,a.workspace,a.id,m.id,r.id,i.id,coalesce(r.amount_cents,i.amount_cents-i.paid_cents),array(select jsonb_array_elements_text(body->'methods')),(body->>'livemode')::boolean) returning * into c;
 return jsonb_build_object('checkout',to_jsonb(c),'create',true,'description',description,'name',name,'email',email);
end $$;
revoke all on function ff_private.paymongo_prepare(jsonb) from public,anon;
grant execute on function ff_private.paymongo_prepare(jsonb) to authenticated;
create function public.ff_paymongo_prepare(body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.paymongo_prepare(body) $$;
revoke all on function public.ff_paymongo_prepare(jsonb) from public,anon;
grant execute on function public.ff_paymongo_prepare(jsonb) to authenticated;

-- An open online checkout blocks manual payment and legacy submissions for the same target.
create function ff_private.guard_open_checkout() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='ff_registrations' then
  if old.status='awaiting_payment' and new.status='paid' and exists(select 1 from public.ff_checkouts where registration_id=new.id and status in ('creating','pending','needs_review')) then raise exception 'Online checkout is open. Check its payment status before collecting cash.'; end if;
 else
  if exists(select 1 from public.ff_checkouts where invoice_id=new.invoice_id and status in ('creating','pending','needs_review')) then raise exception 'Online checkout is open. Check its payment status before collecting another payment.'; end if;
 end if;
 return new;
end $$;
revoke all on function ff_private.guard_open_checkout() from public,anon,authenticated;
create trigger ff_registration_checkout_guard before update on public.ff_registrations for each row execute function ff_private.guard_open_checkout();
create trigger ff_payment_checkout_guard before insert on public.ff_payments for each row execute function ff_private.guard_open_checkout();
create trigger ff_submission_checkout_guard before insert on public.ff_submissions for each row execute function ff_private.guard_open_checkout();

create function ff_private.paymongo_settle(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; r public.ff_registrations; i public.ff_invoices; payment uuid;
begin
 -- Lock the business target before its checkout, matching staff cash/payment lock order.
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid;
 if not found then raise exception 'Checkout not found.'; end if;
 if c.registration_id is not null then select * into r from public.ff_registrations where id=c.registration_id for update;
 else select * into i from public.ff_invoices where id=c.invoice_id for update; end if;
 select * into c from public.ff_checkouts where id=c.id for update;
 if c.session_id is distinct from body->>'sessionId' or c.amount_cents is distinct from (body->>'amountCents')::integer or body->>'paymentId' !~ '^pay_[a-zA-Z0-9]+$' or body->>'method' not in ('GCash','Maya','GrabPay','Card') then raise exception 'Verified payment does not match checkout.'; end if;
 if c.status='paid' then
  if c.payment_id is distinct from body->>'paymentId' then raise exception 'Checkout has another paid reference.'; end if;
  return to_jsonb(c);
 end if;
 update public.ff_checkouts set status='paid',payment_id=body->>'paymentId',paid_at=now() where id=c.id returning * into c;
 if c.registration_id is not null then
  if r.status<>'awaiting_payment' then raise exception 'Registration was already paid separately. Review this payment.'; end if;
  update public.ff_registrations set status='paid',paid_by=c.created_by,paid_at=now(),payment_request=c.id,payment_method=body->>'method',payment_reference=c.payment_id where id=r.id;
 else
  if i.amount_cents-i.paid_cents<>c.amount_cents then raise exception 'Invoice balance changed. Review this payment.'; end if;
  insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,payment_date,recorded_by)
  values(c.workspace,i.member_id,i.id,c.amount_cents,body->>'method',c.payment_id,'PAYMONGO:'||c.payment_id,c.id,ff_private.today(),c.created_by) returning id into payment;
  update public.ff_invoices set paid_cents=paid_cents+c.amount_cents where id=i.id;
  perform ff_private.notify(c.workspace,i.member_id,'RepReady payment confirmed','Your online membership payment is confirmed.','payment:'||payment);
 end if;
 return to_jsonb(c);
end $$;
revoke all on function ff_private.paymongo_settle(jsonb) from public,anon,authenticated;
grant execute on function ff_private.paymongo_settle(jsonb) to service_role;
create function public.ff_paymongo_settle(body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.paymongo_settle(body) $$;
revoke all on function public.ff_paymongo_settle(jsonb) from public,anon,authenticated;
grant execute on function public.ff_paymongo_settle(jsonb) to service_role;

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
  values(reg.workspace,u.id,invoice,reg.amount_cents,reg.payment_method,reg.payment_reference,case when reg.payment_method='Cash' then 'CASH:'||reg.payment_request else 'PAYMONGO:'||reg.payment_reference end,reg.payment_request,(reg.paid_at at time zone 'Asia/Manila')::date,reg.paid_by) returning id into payment;
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
