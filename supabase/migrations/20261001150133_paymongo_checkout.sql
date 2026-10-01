-- Provider checkout is isolated from manually verified transfers.
create table public.ff_paymongo_attempts (
 id uuid primary key, workspace text not null, member_id uuid not null,
 invoice_id uuid not null, amount_cents integer not null check(amount_cents>0),
 live boolean not null, status text not null default 'pending' check(status in ('pending','paid','review','closed')),
 session_id text unique, checkout_url text, provider_payment_id text unique,
 created_at timestamptz not null default now(),
 foreign key(workspace,invoice_id,member_id) references public.ff_invoices(workspace,id,member_id),
 check((live and workspace='production') or (not live and workspace='demo'))
);
create unique index ff_paymongo_one_open on public.ff_paymongo_attempts(invoice_id) where status in ('pending','review');
create index ff_paymongo_member on public.ff_paymongo_attempts(member_id);
alter table public.ff_paymongo_attempts enable row level security;
revoke all on public.ff_paymongo_attempts from anon,authenticated;
grant select on public.ff_paymongo_attempts to authenticated;
grant all on public.ff_paymongo_attempts to service_role;
create policy ff_paymongo_read on public.ff_paymongo_attempts for select to authenticated
 using(workspace=(select ff_private.workspace()) and (member_id=(select auth.uid()) or (select ff_private.is_admin())));

alter table public.ff_payments add column provider_payment_id text unique;
alter table public.ff_payments alter column recorded_by drop not null;
alter table public.ff_payments add constraint ff_payment_recorder check(recorded_by is not null or provider_payment_id is not null);

create function public.ff_paymongo_reserve(invoice uuid,member uuid,w text,is_live boolean,candidate uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare inv public.ff_invoices; attempt public.ff_paymongo_attempts;
begin
 if not ((is_live and w='production') or (not is_live and w='demo')) then raise exception 'Invalid payment workspace'; end if;
 if not exists(select 1 from public.ff_profiles where id=member and workspace=w and role='member' and enabled) then raise exception 'Member unavailable'; end if;
 select * into inv from public.ff_invoices where id=invoice and member_id=member and workspace=w for update;
 if not found or inv.paid_cents>=inv.amount_cents then raise exception 'Invoice unavailable or already paid'; end if;
 if exists(select 1 from public.ff_submissions where invoice_id=invoice and status='pending') then raise exception 'A manual payment is awaiting review'; end if;
 select * into attempt from public.ff_paymongo_attempts where invoice_id=invoice and status in ('pending','review');
 if found then
   if attempt.status='review' or attempt.amount_cents<>inv.amount_cents-inv.paid_cents then raise exception 'Contact staff to reconcile the existing checkout'; end if;
   return to_jsonb(attempt);
 end if;
 insert into public.ff_paymongo_attempts(id,workspace,member_id,invoice_id,amount_cents,live)
 values(candidate,w,member,invoice,inv.amount_cents-inv.paid_cents,is_live) returning * into attempt;
 return to_jsonb(attempt);
end $$;

create function public.ff_paymongo_settle(attempt_id uuid,session_id text,provider_payment_id text,amount integer,channel text,is_live boolean)
returns text language plpgsql security invoker set search_path='' as $$
declare a public.ff_paymongo_attempts; inv public.ff_invoices;
begin
 -- Lock invoice first, matching reserve/manual-payment lock order.
 select i.* into inv from public.ff_invoices i join public.ff_paymongo_attempts p on p.invoice_id=i.id where p.id=attempt_id for update of i;
 if not found then raise exception 'Unknown checkout'; end if;
 select * into a from public.ff_paymongo_attempts where id=attempt_id for update;
 if a.live<>is_live or (a.session_id is not null and a.session_id<>ff_paymongo_settle.session_id) then raise exception 'Checkout mismatch'; end if;
 if a.provider_payment_id is not null then
   if a.provider_payment_id<>ff_paymongo_settle.provider_payment_id then raise exception 'Additional payment needs reconciliation'; end if;
   return a.status;
 end if;
 if channel not in ('gcash','qrph') or amount<=0 then raise exception 'Invalid payment'; end if;
 update public.ff_paymongo_attempts set session_id=ff_paymongo_settle.session_id,provider_payment_id=ff_paymongo_settle.provider_payment_id where id=a.id;
 if a.status<>'pending' or amount<>a.amount_cents or amount>inv.amount_cents-inv.paid_cents then
   update public.ff_paymongo_attempts set status='review' where id=a.id;
   return 'review';
 end if;
 insert into public.ff_payments(workspace,member_id,invoice_id,amount_cents,method,reference,reference_key,idempotency_key,payment_date,recorded_by,provider_payment_id)
 values(a.workspace,a.member_id,a.invoice_id,amount,case when channel='gcash' then 'GCash' else 'Bank transfer' end,
 'PayMongo '||channel||': '||ff_paymongo_settle.provider_payment_id,'paymongo:'||ff_paymongo_settle.provider_payment_id,a.id,(now() at time zone 'Asia/Manila')::date,null,ff_paymongo_settle.provider_payment_id);
 update public.ff_invoices set paid_cents=paid_cents+amount where id=inv.id;
 update public.ff_paymongo_attempts set status='paid' where id=a.id;
 perform ff_private.notify(a.workspace,a.member_id,'RepReady payment confirmed','Your PayMongo payment has been confirmed. Sign in to view your membership balance.','paymongo:'||a.id);
 return 'paid';
end $$;
revoke all on function public.ff_paymongo_reserve(uuid,uuid,text,boolean,uuid) from public,anon,authenticated;
revoke all on function public.ff_paymongo_settle(uuid,text,text,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.ff_paymongo_reserve(uuid,uuid,text,boolean,uuid) to service_role;
grant execute on function public.ff_paymongo_settle(uuid,text,text,integer,text,boolean) to service_role;
