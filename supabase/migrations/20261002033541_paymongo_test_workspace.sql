-- PayMongo TEST MODE is independent of the application's workspace name.
-- Preserve both workspaces and payment history; allow only non-live checkout rows.
alter table public.ff_checkouts drop constraint ff_checkout_demo_only;
alter table public.ff_checkouts add constraint ff_checkout_test_only check(livemode is false) not valid;

create or replace function ff_private.paymongo_prepare(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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

create or replace function ff_private.paymongo_settle(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; r public.ff_registrations; i public.ff_invoices; payment uuid; method text;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid;
 if not found or c.workspace not in ('production','demo') or c.livemode then raise exception 'Test checkout not found.'; end if;
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
  perform ff_private.notify(c.workspace,i.member_id,'RepReady payment confirmed','Your test online membership payment is confirmed.','payment:'||payment);
 end if;
 return to_jsonb(c);
end $$;

create or replace function ff_private.paymongo_bind(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid for update;
 if not found or c.workspace not in ('production','demo') or c.livemode then raise exception 'Test checkout not found.'; end if;
 if body->>'sessionId' is null or body->>'sessionId' !~ '^cs_[a-zA-Z0-9]+$' then raise exception 'Invalid provider session.'; end if;
 if c.session_id is not null and c.session_id<>body->>'sessionId' then raise exception 'Checkout is bound to another session.'; end if;
 update public.ff_checkouts set session_id=body->>'sessionId',checkout_url=coalesce(body->>'url',checkout_url),
 review_reason=case when review_reason in ('creation_outcome_uncertain','stale_creation_claim') then null else review_reason end,
 status=case when status='paid' then status else 'pending' end where id=c.id returning * into c;
 return to_jsonb(c);
end $$;

create or replace function ff_private.paymongo_review(body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; details jsonb;
begin
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid for update;
 if not found or c.workspace not in ('production','demo') or c.livemode then raise exception 'Test checkout not found.'; end if;
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
-- Keep preparation session-scoped and final financial writes service-only.
revoke all on function ff_private.paymongo_prepare(jsonb),public.ff_paymongo_prepare(jsonb) from public,anon;
grant execute on function ff_private.paymongo_prepare(jsonb),public.ff_paymongo_prepare(jsonb) to authenticated;
revoke all on function ff_private.paymongo_settle(jsonb),public.ff_paymongo_settle(jsonb),ff_private.paymongo_bind(jsonb),public.ff_paymongo_bind(jsonb),ff_private.paymongo_review(jsonb),public.ff_paymongo_review(jsonb) from public,anon,authenticated;
grant execute on function ff_private.paymongo_settle(jsonb),public.ff_paymongo_settle(jsonb),ff_private.paymongo_bind(jsonb),public.ff_paymongo_bind(jsonb),ff_private.paymongo_review(jsonb),public.ff_paymongo_review(jsonb) to service_role;
NOTIFY pgrst, 'reload schema';
