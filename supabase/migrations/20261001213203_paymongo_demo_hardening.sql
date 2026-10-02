-- Preserve historical production rows. All new PayMongo transactions must be demo/test only.
alter table public.ff_registrations drop constraint ff_registrations_workspace_check;
alter table public.ff_registrations add constraint ff_registrations_workspace_check check(workspace in ('production','demo'));
alter table public.ff_checkouts drop constraint ff_checkouts_workspace_check;
alter table public.ff_checkouts add constraint ff_checkouts_workspace_check check(workspace in ('production','demo'));
alter table public.ff_checkouts add constraint ff_checkout_demo_only check(workspace='demo' and livemode is false) not valid;
alter table public.ff_checkouts add constraint ff_checkout_methods_allowlist check(cardinality(methods)>0 and methods <@ array['gcash','paymaya','grab_pay','card']::text[]) not valid;
alter table public.ff_checkouts add column request_details jsonb not null default '{}';
alter table public.ff_checkouts add column review_reason text;
alter table public.ff_checkouts add column review_details jsonb not null default '{}';
alter table public.ff_checkouts add column review_log jsonb not null default '[]';
alter table public.ff_checkouts add column verified_at timestamptz;

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

create or replace function ff_private.paymongo_prepare(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; m public.ff_profiles; r public.ff_registrations; i public.ff_invoices; c public.ff_checkouts;
 request uuid; invoice uuid; description text; name text; email text; details jsonb;
begin
 a:=ff_private.actor();request:=(body->>'requestId')::uuid;
 if a.id is null or a.workspace<>'demo' then raise exception 'PayMongo requires the demo workspace.' using errcode='42501'; end if;
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
  if not exists(select 1 from public.ff_plans where workspace=a.workspace and id=r.plan_id and available) then raise exception 'Select an available membership plan.'; end if;
  description:=r.plan_name||' first membership';name:=r.name;email:=r.email;
 elsif body->>'kind' in ('invoice','renewal') then
  if body->>'kind'='renewal' then
   select * into m from public.ff_profiles where id=(body->>'memberId')::uuid and workspace=a.workspace and role='member' and enabled for update;
   if not found or (a.role not in ('admin','staff') and a.id<>m.id) then raise exception 'Member not found.' using errcode='42501'; end if;
   if not exists(select 1 from public.ff_plans where workspace=a.workspace and id=body->>'plan' and available) then raise exception 'Select an available membership plan.'; end if;
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
end $$;

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



create or replace function ff_private.paymongo_settle(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; r public.ff_registrations; i public.ff_invoices; payment uuid; method text;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid;
 if not found or c.workspace<>'demo' or c.livemode then raise exception 'Demo checkout not found.'; end if;
 if c.registration_id is not null then select * into r from public.ff_registrations where id=c.registration_id and workspace=c.workspace for update;
 else select * into i from public.ff_invoices where id=c.invoice_id and workspace=c.workspace for update; end if;
 if not found then raise exception 'Checkout target not found.'; end if;
 select * into c from public.ff_checkouts where id=c.id for update;
 method:=case body->>'source' when 'gcash' then 'GCash' when 'paymaya' then 'Maya' when 'grab_pay' then 'GrabPay' when 'card' then 'Card' end;
 if c.session_id is distinct from body->>'sessionId' or body->>'reference' is distinct from c.id::text or
 c.amount_cents is distinct from (body->>'amountCents')::integer or body->>'paymentId' is null or
 body->>'paymentId' !~ '^pay_[a-zA-Z0-9]+$' or method is null or not coalesce((body->>'source')=any(c.methods),false) or
 body->>'currency' is distinct from 'PHP' or body->>'status' is distinct from 'paid' or
 (body->>'livemode')::boolean is distinct from false then raise exception 'Verified test payment does not match checkout.'; end if;
 if c.status='paid' then
  if c.payment_id is distinct from body->>'paymentId' then raise exception 'Checkout has another paid reference.'; end if;
  return to_jsonb(c);
 end if;
 update public.ff_checkouts set status='paid',payment_id=body->>'paymentId',paid_at=now(),verified_at=now(),review_reason=null where id=c.id returning * into c;
 if c.registration_id is not null then
  if r.status<>'awaiting_payment' then raise exception 'Registration was already paid separately. Review this payment.'; end if;
  update public.ff_registrations set status='paid',paid_by=c.created_by,paid_at=now(),payment_request=c.id,payment_method=method,payment_reference=c.payment_id where id=r.id;
 else
  if i.amount_cents-i.paid_cents<>c.amount_cents then raise exception 'Invoice balance changed. Review this payment.'; end if;
  insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,payment_date,recorded_by)
  values(c.workspace,i.member_id,i.id,c.amount_cents,method,c.payment_id,'PAYMONGO:'||c.payment_id,c.id,ff_private.today(),c.created_by) returning id into payment;
  update public.ff_invoices set paid_cents=paid_cents+c.amount_cents where id=i.id;
  perform ff_private.notify(c.workspace,i.member_id,'RepReady payment confirmed','Your demo online membership payment is confirmed.','payment:'||payment);
 end if;
 return to_jsonb(c);
end $$;

create function ff_private.paymongo_bind(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid for update;
 if not found or c.workspace<>'demo' or c.livemode then raise exception 'Demo checkout not found.'; end if;
 if body->>'sessionId' is null or body->>'sessionId' !~ '^cs_[a-zA-Z0-9]+$' then raise exception 'Invalid provider session.'; end if;
 if c.session_id is not null and c.session_id<>body->>'sessionId' then raise exception 'Checkout is bound to another session.'; end if;
 update public.ff_checkouts set session_id=body->>'sessionId',checkout_url=coalesce(body->>'url',checkout_url),
 review_reason=case when review_reason in ('creation_outcome_uncertain','stale_creation_claim') then null else review_reason end,
 status=case when status='paid' then status else 'pending' end where id=c.id returning * into c;
 return to_jsonb(c);
end $$;

create function ff_private.paymongo_review(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; details jsonb;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid for update;
 if not found or c.workspace<>'demo' or c.livemode then raise exception 'Demo checkout not found.'; end if;
 details:=jsonb_strip_nulls(jsonb_build_object('category',left(body->>'category',50),
 'sessionId',left(body->>'sessionId',100),'paymentId',left(body->>'paymentId',100),
 'amountCents',body->'amountCents','currency',left(body->>'currency',10),
 'source',left(body->>'source',30),'livemode',body->'livemode'));
 update public.ff_checkouts set status=case when status='paid' then status else 'needs_review' end,
 review_reason=coalesce(details->>'category','verification_failed'),review_details=details,
 review_log=case when review_details is distinct from details then review_log||jsonb_build_array(details||jsonb_build_object('at',now())) else review_log end
 where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
revoke all on function ff_private.paymongo_bind(jsonb),ff_private.paymongo_review(jsonb) from public,anon,authenticated;
grant execute on function ff_private.paymongo_bind(jsonb),ff_private.paymongo_review(jsonb) to service_role;
create function public.ff_paymongo_bind(body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.paymongo_bind(body) $$;
create function public.ff_paymongo_review(body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.paymongo_review(body) $$;
revoke all on function public.ff_paymongo_bind(jsonb),public.ff_paymongo_review(jsonb) from public,anon,authenticated;
grant execute on function public.ff_paymongo_bind(jsonb),public.ff_paymongo_review(jsonb) to service_role;
-- Reassert settlement grants, including functions replaced above.
revoke all on function public.ff_paymongo_settle(jsonb),ff_private.paymongo_settle(jsonb) from public,anon,authenticated;
grant execute on function public.ff_paymongo_settle(jsonb),ff_private.paymongo_settle(jsonb) to service_role;
NOTIFY pgrst, 'reload schema';
