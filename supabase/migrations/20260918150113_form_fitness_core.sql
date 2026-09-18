-- Additive application schema. No existing tables or auth users are replaced.
create schema if not exists ff_private;
revoke all on schema ff_private from public, anon;
grant usage on schema ff_private to authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;

create table public.ff_profiles (
  id uuid primary key references auth.users(id),
  workspace text not null check (workspace in ('production','demo')),
  role text not null default 'member' check (role in ('admin','member')),
  name text not null check (length(name) between 2 and 70 and name !~ '[<>\r\n]'),
  email text not null check (length(email) <= 100 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone text not null check (phone ~ '^09[0-9]{9}$'),
  goal text not null default 'Improve fitness',
  photo text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace,id), unique(workspace,email)
);
create table public.ff_plans (
  workspace text not null check (workspace in ('production','demo')),
  id text not null check (id ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name text not null check (length(name) between 2 and 60),
  price_cents integer not null check (price_cents between 1 and 10000000),
  days integer not null default 30 check (days between 1 and 366),
  available boolean not null default true,
  description text not null default '', features jsonb not null default '[]',
  primary key(workspace,id)
);
insert into public.ff_plans(workspace,id,name,price_cents,description,features)
select w, id, name, price, description, features::jsonb
from (values ('production'),('demo')) ws(w) cross join (values
 ('basic','Essential',89900,'A solid foundation for your fitness routine.','["Unlimited gym access","All strength equipment","Locker room access","Fitness orientation"]'),
 ('plus','Momentum',149900,'More variety. More support. More momentum.','["Everything in Essential","Unlimited group classes","Monthly fitness check-in","One guest pass per cycle"]'),
 ('elite','Performance',249900,'Focused coaching for your personal best.','["Everything in Momentum","4 personal training sessions","Personalized workout plan","Priority class booking"]')
) p(id,name,price,description,features);
create table public.ff_memberships (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid not null, plan_id text not null,
  start_date date not null, end_date date not null check (end_date >= start_date),
  created_at timestamptz not null default now(),
  foreign key(workspace,member_id) references public.ff_profiles(workspace,id),
  foreign key(workspace,plan_id) references public.ff_plans(workspace,id),
  unique(workspace,id), unique(workspace,member_id,start_date)
);
create table public.ff_invoices (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid not null, membership_id uuid not null unique,
  amount_cents integer not null check (amount_cents > 0),
  paid_cents integer not null default 0 check (paid_cents >= 0 and paid_cents <= amount_cents),
  created_at timestamptz not null default now(),
  foreign key(workspace,member_id) references public.ff_profiles(workspace,id),
  foreign key(workspace,membership_id) references public.ff_memberships(workspace,id),
  unique(workspace,id), unique(workspace,id,member_id)
);
create table public.ff_submissions (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid not null, invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  method text not null check(method in ('GCash','Bank transfer')),
  reference text not null, reference_key text not null,
  receipt text not null default '', status text not null default 'pending' check(status in ('pending','approved','rejected')),
  reviewed_by uuid references public.ff_profiles(id), reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(workspace,invoice_id,member_id) references public.ff_invoices(workspace,id,member_id),
  unique(workspace,reference_key), unique(workspace,id)
);
create table public.ff_payments (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid not null, invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  method text not null check(method in ('Cash','GCash','Bank transfer')),
  reference text not null default '', reference_key text not null,
  idempotency_key uuid not null, submission_id uuid references public.ff_submissions(id),
  payment_date date not null, recorded_by uuid not null references public.ff_profiles(id),
  created_at timestamptz not null default now(),
  foreign key(workspace,invoice_id,member_id) references public.ff_invoices(workspace,id,member_id),
  unique(workspace,reference_key), unique(workspace,idempotency_key), unique(submission_id)
);
create table public.ff_checkins (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid not null, membership_id uuid not null references public.ff_memberships(id),
  nonce uuid not null unique, confirmed_by uuid not null references public.ff_profiles(id),
  created_at timestamptz not null default now(),
  foreign key(workspace,member_id) references public.ff_profiles(workspace,id)
);
create table public.ff_settings (
  workspace text primary key check(workspace in ('production','demo')),
  payments jsonb not null default '{}'
);
insert into public.ff_settings(workspace) values ('production'),('demo');
create table public.ff_notifications (
  id uuid primary key default gen_random_uuid(), workspace text not null,
  member_id uuid references public.ff_profiles(id), recipient text not null,
  subject text not null, body text not null,
  event_key text not null unique,
  status text not null default 'queued' check(status in ('queued','sending','sent','failed','needs_review','suppressed')),
  error text, created_at timestamptz not null default now(), claimed_at timestamptz, sent_at timestamptz
);
create table ff_private.secrets (name text primary key, value text not null);
insert into ff_private.secrets values ('qr', encode(extensions.gen_random_bytes(32),'hex'));
alter table ff_private.secrets enable row level security;
create index ff_profiles_workspace on public.ff_profiles(workspace,role);
create index ff_memberships_member on public.ff_memberships(workspace,member_id,start_date desc);
create index ff_invoices_member on public.ff_invoices(workspace,member_id);
create index ff_submissions_member on public.ff_submissions(workspace,member_id,status);
create index ff_payments_member on public.ff_payments(workspace,member_id);
create index ff_payments_invoice on public.ff_payments(invoice_id);
create index ff_checkins_member on public.ff_checkins(workspace,member_id,created_at desc);
create index ff_notifications_queue on public.ff_notifications(workspace,status,created_at);

create function ff_private.today() returns date language sql stable set search_path='' as
$$ select (now() at time zone 'Asia/Manila')::date $$;
create function ff_private.actor() returns public.ff_profiles
language sql stable security definer set search_path='' as $$
 select p from public.ff_profiles p where p.id=(select auth.uid()) and p.enabled
 and exists (select 1 from auth.sessions s where s.user_id=p.id and s.id=(auth.jwt()->>'session_id')::uuid)
$$;
create function ff_private.workspace() returns text language sql stable security definer set search_path='' as
$$ select (ff_private.actor()).workspace $$;
create function ff_private.is_admin() returns boolean language sql stable security definer set search_path='' as
$$ select coalesce((ff_private.actor()).role='admin',false) $$;

do $$ declare t text; begin
 foreach t in array array['profiles','plans','memberships','invoices','submissions','payments','checkins','settings','notifications'] loop
   execute format('alter table public.ff_%I enable row level security',t);
   execute format('revoke all on public.ff_%I from anon, authenticated',t);
   execute format('grant select on public.ff_%I to authenticated',t);
   execute format('grant all on public.ff_%I to service_role',t);
 end loop;
end $$;
create policy ff_profile_read on public.ff_profiles for select to authenticated
 using(workspace=(select ff_private.workspace()) and (id=(select auth.uid()) or (select ff_private.is_admin())));
create policy ff_plan_read on public.ff_plans for select to authenticated using(workspace=(select ff_private.workspace()));
create policy ff_settings_read on public.ff_settings for select to authenticated using(workspace=(select ff_private.workspace()));
do $$ declare t text; begin
 foreach t in array array['memberships','invoices','submissions','payments','checkins','notifications'] loop
   execute format('create policy ff_own_read on public.ff_%I for select to authenticated using (workspace=(select ff_private.workspace()) and (member_id=(select auth.uid()) or (select ff_private.is_admin())))',t);
 end loop;
end $$;

create function ff_private.notify(w text, m uuid, subject text, body text, event text) returns void
language sql security definer set search_path='' as $$
 insert into public.ff_notifications(workspace,member_id,recipient,subject,body,event_key,status)
 select w,m,p.email,subject,body,event,case when w='demo' then 'suppressed' else 'queued' end
 from public.ff_profiles p where p.id=m and p.workspace=w
 on conflict(event_key) do nothing
$$;
create function ff_private.new_membership(w text, m uuid, plan text, starts date) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.ff_plans; membership uuid; inv uuid;
begin
 select * into p from public.ff_plans where workspace=w and id=plan and available for share;
 if not found then raise exception 'Select an available membership plan.'; end if;
 if starts is null or starts<ff_private.today() or starts>ff_private.today()+365 then raise exception 'Choose a start date within the next year.'; end if;
 if exists(select 1 from public.ff_memberships where workspace=w and member_id=m and daterange(start_date,end_date,'[]') && daterange(starts,starts+p.days-1,'[]')) then raise exception 'Membership dates overlap an existing cycle.'; end if;
 insert into public.ff_memberships(workspace,member_id,plan_id,start_date,end_date) values(w,m,plan,starts,starts+p.days-1) returning id into membership;
 insert into public.ff_invoices(workspace,member_id,membership_id,amount_cents) values(w,m,membership,p.price_cents) returning id into inv;
 perform ff_private.notify(w,m,'FORM Fitness membership registered','Your membership is registered. Sign in to view your invoice. Activation requires confirmed full payment and a valid start date.','membership:'||membership);
 return inv;
end $$;
create function ff_private.register_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb:=new.raw_user_meta_data; w text; r text; phone text;
begin
 if coalesce(d->>'form_fitness','')<>'true' then return new; end if;
 -- Only trusted Auth administration can assign app_metadata; user_metadata never assigns roles/workspaces.
 w:=case when new.raw_app_meta_data->>'ff_workspace'='demo' then 'demo' else 'production' end;
 r:=case when new.raw_app_meta_data->>'ff_role'='admin' then 'admin' else 'member' end;
 phone:=regexp_replace(coalesce(d->>'phone',''),'[ ()-]','','g');
 if phone like '+63%' then phone:='0'||substring(phone from 4); end if;
 insert into public.ff_profiles(id,workspace,role,name,email,phone,goal)
 values(new.id,w,r,trim(d->>'name'),lower(new.email),phone,left(coalesce(d->>'goal','Improve fitness'),100));
 if r='member' then perform ff_private.new_membership(w,new.id,d->>'plan',(d->>'start')::date); end if;
 return new;
end $$;
create trigger ff_auth_user_created after insert on auth.users for each row execute function ff_private.register_auth_user();

-- One transactional command boundary, with authorization repeated inside PostgreSQL.
create function ff_private.command(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; m public.ff_profiles; p public.ff_plans; inv public.ff_invoices; sub public.ff_submissions;
 pay public.ff_payments; cycle public.ff_memberships; w text; amount integer; ref text; refkey text; method text;
 invoice_id uuid; item_id uuid; request_id uuid; payment_day date; key text; payload text; signature text; claims jsonb;
 expiry bigint; pass_nonce uuid; token text; dest jsonb; path text; old_pay public.ff_payments;
begin
 a:=ff_private.actor();
 if a.id is null then raise exception 'Please sign in to continue.' using errcode='42501'; end if;
 w:=a.workspace;
 if action in ('payments','review-payment','scan','check-in','settings/payments','plans','manage-member','email-retry') and a.role<>'admin' then raise exception 'Administrator access is required.' using errcode='42501'; end if;

 if action='profile' then
   if a.role<>'member' then raise exception 'Sign in as a member.'; end if;
   if lower(body->>'email')<>a.email then raise exception 'Email changes require administrator assistance.'; end if;
   path:=coalesce(body->>'photo',a.photo);
   if path<>'' and path not like w||'/'||a.id||'/photo/%' then raise exception 'Invalid photo path.'; end if;
   update public.ff_profiles set name=trim(body->>'name'),phone=regexp_replace(replace(body->>'phone','+63','0'),'[ ()-]','','g'),goal=left(coalesce(body->>'goal',goal),100),photo=path where id=a.id;
   return '{"ok":true}';
 elsif action='manage-member' then
   update public.ff_profiles set enabled=(body->>'enabled')::boolean where id=(body->>'id')::uuid and workspace=w and role='member';
   if not found then raise exception 'Member not found.'; end if;
   return '{"ok":true}';
 elsif action='plans' then
   update public.ff_plans set name=trim(body->>'name'),price_cents=(body->>'priceCents')::integer,available=(body->>'available')::boolean where workspace=w and id=body->>'id';
   if not found then raise exception 'Plan not found.'; end if;
   return '{"ok":true}';
 elsif action='renew' then
   select * into m from public.ff_profiles where workspace=w and id=coalesce((body->>'memberId')::uuid,a.id) and role='member' and enabled for update;
   if not found or (a.role<>'admin' and m.id<>a.id) then raise exception 'Member not found.' using errcode='42501'; end if;
   invoice_id:=ff_private.new_membership(w,m.id,body->>'plan',(body->>'start')::date);
   return jsonb_build_object('invoiceId',invoice_id);
 elsif action='settings/payments' then
   dest:='{}';
   foreach key in array array['gcash','bank'] loop
     if body ? key then
       path:=body->key->>'image';
       if path is null or path not like w||'/payments/%' or length(body->key->>'name') not between 2 and 100 or coalesce(body->key->>'detail','') ~ '[<>\r\n]' or length(coalesce(body->key->>'detail',''))>120 then raise exception 'Invalid payment destination.'; end if;
       dest:=dest||jsonb_build_object(key,body->key);
     end if;
   end loop;
   update public.ff_settings set payments=dest where workspace=w;
   return '{"ok":true}';
 elsif action='email-retry' then
   if body ? 'id' then
     if coalesce((body->>'checked')::boolean,false) is not true then raise exception 'Check Gmail Sent before retrying.'; end if;
     update public.ff_notifications set status='queued',error=null,claimed_at=null where id=(body->>'id')::uuid and workspace=w and w<>'demo' and status in ('failed','needs_review');
   end if;
   return '{"ok":true}';
 elsif action in ('payment-submissions','payments','review-payment') then
   if action='review-payment' then
     select * into sub from public.ff_submissions where id=(body->>'id')::uuid and workspace=w for update;
     if not found then raise exception 'Submission not found.'; end if;
     if sub.status<>'pending' then
       if sub.status='approved' and (body->>'approve')::boolean then return '{"ok":true,"alreadyProcessed":true}'; end if;
       raise exception 'This submission was already reviewed.';
     end if;
     if (body->>'approve')::boolean is false then
       update public.ff_submissions set status='rejected',reviewed_by=a.id,reviewed_at=now() where id=sub.id;
       perform ff_private.notify(w,sub.member_id,'FORM Fitness payment needs attention','The gym could not confirm your payment. Please contact staff before paying again.','rejected:'||sub.id);
       return '{"ok":true}';
     end if;
     if coalesce((body->>'approve')::boolean,false) is not true then raise exception 'Choose approve or reject.'; end if;
     invoice_id:=sub.invoice_id; amount:=sub.amount_cents; method:=sub.method; ref:=sub.reference; request_id:=sub.id;
   else
     invoice_id:=(body->>'invoiceId')::uuid; amount:=(body->>'amountCents')::integer; method:=body->>'method'; ref:=trim(coalesce(body->>'reference','')); request_id:=(body->>'idempotencyKey')::uuid;
   end if;
   if action<>'payment-submissions' and coalesce((body->>'verified')::boolean,false) is not true then raise exception 'Confirm receipt of funds first.'; end if;
   if amount is null or amount<1 or amount>10000000 or method is null or method not in ('Cash','GCash','Bank transfer') then raise exception 'Invalid amount or payment method.'; end if;
   if method<>'Cash' and ref !~ '^[a-zA-Z0-9 -]{6,80}$' then raise exception 'Enter a transaction reference of 6 to 80 characters.'; end if;
   refkey:=case when method='Cash' then 'CASH:'||request_id else method||':'||upper(regexp_replace(ref,'[ -]','','g')) end;
   -- Same ordering for both submission and direct payment serializes cross-table reference claims.
   perform pg_advisory_xact_lock(hashtextextended(w||refkey,0));
   select * into inv from public.ff_invoices where id=invoice_id and workspace=w for update;
   if not found or (a.role<>'admin' and inv.member_id<>a.id) then raise exception 'Invoice not found.' using errcode='42501'; end if;
   if action='payment-submissions' then
     if a.role<>'member' or method='Cash' then raise exception 'Sign in as the paying member and choose GCash or bank transfer.'; end if;
     key:=case when method='GCash' then 'gcash' else 'bank' end;
     if not exists(select 1 from public.ff_settings where workspace=w and payments->key->>'image' is not null) then raise exception 'The gym has not configured this payment method.'; end if;
     if exists(select 1 from public.ff_payments where workspace=w and reference_key=refkey) then raise exception 'This reference was already paid.'; end if;
     if amount>inv.amount_cents-inv.paid_cents then raise exception 'Amount exceeds the remaining balance.'; end if;
     path:=coalesce(body->>'receipt','');
     if path<>'' and path not like w||'/'||a.id||'/receipt/%' then raise exception 'Invalid receipt path.'; end if;
     insert into public.ff_submissions(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,receipt)
     values(w,a.id,inv.id,amount,method,ref,refkey,path) returning id into item_id;
     return jsonb_build_object('id',item_id);
   end if;
   if request_id is null then raise exception 'Payment request ID is required.'; end if;
   select * into old_pay from public.ff_payments where workspace=w and idempotency_key=request_id;
   if found then
     if old_pay.invoice_id<>inv.id or old_pay.amount_cents<>amount or old_pay.method<>method or old_pay.reference_key<>refkey then raise exception 'Request ID was used for a different payment.'; end if;
     return jsonb_build_object('payment',to_jsonb(old_pay),'alreadyProcessed',true);
   end if;
   if amount>inv.amount_cents-inv.paid_cents then raise exception 'Payment exceeds the remaining balance.'; end if;
   if exists(select 1 from public.ff_submissions where workspace=w and reference_key=refkey and id is distinct from sub.id) then raise exception 'This reference belongs to a submission. Review that submission.'; end if;
   payment_day:=coalesce((body->>'date')::date,ff_private.today());
   if payment_day<(inv.created_at at time zone 'Asia/Manila')::date or payment_day>ff_private.today() then raise exception 'Invalid payment date.'; end if;
   insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,submission_id,payment_date,recorded_by)
   values(w,inv.member_id,inv.id,amount,method,ref,refkey,request_id,sub.id,payment_day,a.id) returning * into pay;
   update public.ff_invoices set paid_cents=paid_cents+amount where id=inv.id;
   if sub.id is not null then update public.ff_submissions set status='approved',reviewed_by=a.id,reviewed_at=now() where id=sub.id; end if;
   perform ff_private.notify(w,inv.member_id,'FORM Fitness payment confirmed','The gym confirmed your payment of PHP '||(amount::numeric/100)::text||'. Sign in to view your receipt.','payment:'||pay.id);
   return jsonb_build_object('payment',to_jsonb(pay));
 elsif action in ('qr','scan','check-in') then
   if action='qr' then
     if a.role<>'member' then raise exception 'Sign in as a member.'; end if;
     m:=a; expiry:=extract(epoch from now())::bigint+90; pass_nonce:=gen_random_uuid();
   else
     token:=body->>'token';
     if token is null or length(token)>1000 or split_part(token,'.',1)<>'FORM2' or array_length(string_to_array(token,'.'),1)<>3 then raise exception 'Invalid member pass.'; end if;
     payload:=split_part(token,'.',2);
     select value into key from ff_private.secrets where name='qr';
     signature:=encode(extensions.hmac(payload,key,'sha256'),'hex');
     if signature<>split_part(token,'.',3) then raise exception 'Invalid member pass signature.'; end if;
     claims:=convert_from(decode(payload,'base64'),'UTF8')::jsonb;
     expiry:=(claims->>'exp')::bigint; pass_nonce:=(claims->>'nonce')::uuid;
     if expiry<=extract(epoch from now())::bigint or expiry>extract(epoch from now())::bigint+95 or claims->>'workspace'<>w then raise exception 'This pass has expired or belongs to another workspace.'; end if;
     select * into m from public.ff_profiles where id=(claims->>'memberId')::uuid and workspace=w for update;
     if not found then raise exception 'Member not found.'; end if;
     if exists(select 1 from public.ff_checkins where nonce=pass_nonce) then raise exception 'This pass was already used.'; end if;
   end if;
   if not m.enabled then raise exception 'This membership is inactive.'; end if;
   select ms.* into cycle from public.ff_memberships ms join public.ff_invoices i on i.membership_id=ms.id
     where ms.workspace=w and ms.member_id=m.id and ff_private.today() between ms.start_date and ms.end_date and i.paid_cents=i.amount_cents
     order by ms.start_date desc limit 1;
   if not found then raise exception 'Check-in denied: membership is unpaid, expired, or not yet active.'; end if;
   if action='qr' then
     payload:=replace(encode(convert_to(jsonb_build_object('memberId',m.id,'workspace',w,'exp',expiry,'nonce',pass_nonce)::text,'UTF8'),'base64'),E'\n','');
     select value into key from ff_private.secrets where name='qr';
     return jsonb_build_object('token','FORM2.'||payload||'.'||encode(extensions.hmac(payload,key,'sha256'),'hex'),'expires',expiry);
   elsif action='scan' then return jsonb_build_object('member',to_jsonb(m),'expires',expiry);
   end if;
   if coalesce((body->>'confirmed')::boolean,false) is not true then raise exception 'Match the member to their photo or photo ID first.'; end if;
   insert into public.ff_checkins(workspace,member_id,membership_id,nonce,confirmed_by) values(w,m.id,cycle.id,pass_nonce,a.id) returning id into item_id;
   perform ff_private.notify(w,m.id,'FORM Fitness check-in confirmed','Staff confirmed your gym check-in. Contact the gym if this was not you.','checkin:'||item_id);
   return jsonb_build_object('id',item_id);
 end if;
 raise exception 'Unknown command.';
end $$;
create function public.ff_command(action text, body jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select ff_private.command(action,body) $$;
create function public.ff_public_plans() returns setof public.ff_plans
language sql stable security definer set search_path='' as $$ select * from public.ff_plans where workspace='production' and available $$;
revoke all on all functions in schema ff_private from public,anon,authenticated;
grant execute on function ff_private.actor(),ff_private.workspace(),ff_private.is_admin(),ff_private.command(text,jsonb) to authenticated;
revoke all on function public.ff_command(text,jsonb) from public,anon;
grant execute on function public.ff_command(text,jsonb) to authenticated;
revoke all on function public.ff_public_plans() from public;
grant execute on function public.ff_public_plans() to anon,authenticated;

-- Private images; URLs are signed using the caller's RLS-scoped client.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('form-fitness-private','form-fitness-private',false,650000,array['image/png','image/jpeg','image/webp']) on conflict(id) do nothing;
create policy ff_image_read on storage.objects for select to authenticated using(
 bucket_id='form-fitness-private' and (storage.foldername(name))[1]=(select ff_private.workspace()) and
 ((storage.foldername(name))[2]='payments' or (storage.foldername(name))[2]=(select auth.uid())::text or (select ff_private.is_admin()))
);
create policy ff_image_insert on storage.objects for insert to authenticated with check(
 bucket_id='form-fitness-private' and (storage.foldername(name))[1]=(select ff_private.workspace()) and
 (((storage.foldername(name))[2]=(select auth.uid())::text and (storage.foldername(name))[3] in ('photo','receipt')) or
 ((storage.foldername(name))[2]='payments' and (select ff_private.is_admin())))
);
