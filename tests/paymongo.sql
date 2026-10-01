-- Synthetic database fixtures; no API payments or email. Everything rolls back.
begin;
set constraints auth.ff_auth_user_created immediate;
do $$
declare m uuid:=gen_random_uuid(); inv public.ff_invoices; a jsonb; b jsonb; outcome text;
begin
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 values(m,'paymongo-db-'||m||'@example.invalid','{"ff_workspace":"demo"}',jsonb_build_object('form_fitness',true,'name','Payment Test','phone','09170000002','plan','basic','start',ff_private.today()));
 select * into inv from public.ff_invoices where member_id=m;
 a:=public.ff_paymongo_reserve(inv.id,m,'demo',false,gen_random_uuid());
 b:=public.ff_paymongo_reserve(inv.id,m,'demo',false,gen_random_uuid());
 if a->>'id'<>b->>'id' then raise exception 'Duplicate checkout created'; end if;
 if (a->>'amount_cents')::int<>inv.amount_cents then raise exception 'Wrong authoritative amount'; end if;
 outcome:=public.ff_paymongo_settle((a->>'id')::uuid,'cs_testGCash','pay_testGCash',inv.amount_cents,'gcash',false);
 if outcome<>'paid' then raise exception 'GCash did not settle'; end if;
 perform public.ff_paymongo_settle((a->>'id')::uuid,'cs_testGCash','pay_testGCash',inv.amount_cents,'gcash',false);
 if (select count(*) from public.ff_payments where invoice_id=inv.id)<>1 then raise exception 'Duplicate payment'; end if;
 if (select paid_cents from public.ff_invoices where id=inv.id)<>inv.amount_cents then raise exception 'Wrong balance'; end if;
 if not exists(select 1 from public.ff_notifications where event_key='paymongo:'||(a->>'id') and status='suppressed') then raise exception 'Demo email not suppressed'; end if;
 if has_function_privilege('authenticated','public.ff_paymongo_settle(uuid,text,text,integer,text,boolean)','EXECUTE') then raise exception 'Customer can settle'; end if;
 if has_function_privilege('anon','public.ff_paymongo_reserve(uuid,uuid,text,boolean,uuid)','EXECUTE') then raise exception 'Anonymous can reserve'; end if;
 -- A second invoice tests QR Ph and preserves a mismatched amount for review.
 m:=gen_random_uuid();
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 values(m,'paymongo-db-'||m||'@example.invalid','{"ff_workspace":"demo"}',jsonb_build_object('form_fitness',true,'name','QR Ph Test','phone','09170000003','plan','basic','start',ff_private.today()));
 select * into inv from public.ff_invoices where member_id=m;
 a:=public.ff_paymongo_reserve(inv.id,m,'demo',false,gen_random_uuid());
 outcome:=public.ff_paymongo_settle((a->>'id')::uuid,'cs_testQR','pay_testQR',inv.amount_cents+1,'qrph',false);
 if outcome<>'review' then raise exception 'Mismatch not retained for review'; end if;
 if (select paid_cents from public.ff_invoices where id=inv.id)<>0 then raise exception 'Mismatch credited invoice'; end if;
 -- Third invoice confirms QR Ph normally.
 m:=gen_random_uuid();
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 values(m,'paymongo-db-'||m||'@example.invalid','{"ff_workspace":"demo"}',jsonb_build_object('form_fitness',true,'name','QR Ph Paid','phone','09170000004','plan','basic','start',ff_private.today()));
 select * into inv from public.ff_invoices where member_id=m;
 a:=public.ff_paymongo_reserve(inv.id,m,'demo',false,gen_random_uuid());
 -- Run the settlement using actual server role permissions.
 perform set_config('role','service_role',true);
 outcome:=public.ff_paymongo_settle((a->>'id')::uuid,'cs_testQRpaid','pay_testQRpaid',inv.amount_cents,'qrph',false);
 if outcome<>'paid' then raise exception 'QR Ph did not settle'; end if;
 perform set_config('role','postgres',true);
end $$;
select 'PASS: GCash/QR Ph settlement, duplicate prevention, invoice amounts, mismatch review, suppressed email and restricted settlement permissions' as result;
rollback;
