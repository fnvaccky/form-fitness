-- Local fixtures only. All account, registration and payment rows roll back.
begin;
set constraints auth.ff_auth_user_created immediate;
create function pg_temp.expect_failure(statement text) returns void language plpgsql as $$
declare failed boolean:=false;
begin
 begin execute statement; exception when others then failed:=true; end;
 if not failed then raise exception 'Expected failure: %',statement; end if;
end $$;
do $$ declare staff uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); session uuid:=gen_random_uuid(); begin
 perform set_config('test.staff',staff::text,true);
 perform set_config('test.member',member::text,true);
 perform set_config('test.today',ff_private.today()::text,true);
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 values(staff,'paid-first-db-staff@example.invalid','{"ff_workspace":"production","ff_role":"staff"}',
 '{"form_fitness":true,"name":"LOCAL TEST Staff","phone":"09170000001"}');
 insert into auth.sessions(id,user_id) values(session,staff);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',staff,'role','authenticated','session_id',session)::text,true);
end $$;
set local role authenticated;
do $$ declare r jsonb; begin
 r:=public.ff_registration('create',jsonb_build_object('requestId',gen_random_uuid(),'name','LOCAL TEST Pending',
 'email','paid-first-db-member@example.invalid','phone','09170000002','plan','basic','start',current_setting('test.today')));
 perform set_config('test.registration',r->>'id',true);
 if r->>'status'<>'awaiting_payment' then raise exception 'Registration was not pending'; end if;
 perform pg_temp.expect_failure('update public.ff_registrations set status=''paid''');
 perform pg_temp.expect_failure('select public.ff_registration(''cash'',jsonb_build_object(''id'',current_setting(''test.registration''),''amountCents'',1,''method'',''Cash'',''verified'',true,''emailConfirmed'',true,''idempotencyKey'',gen_random_uuid()))');
end $$;
reset role;
do $$ begin
 if exists(select 1 from auth.users where email='paid-first-db-member@example.invalid') then
  raise exception 'Unpaid registration created an account';
 end if;
 perform pg_temp.expect_failure('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),''paid-first-db-member@example.invalid'',jsonb_build_object(''ff_registration'',current_setting(''test.registration'')),''{"form_fitness":true}'')');
 perform pg_temp.expect_failure('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),''paid-first-bypass@example.invalid'',''{}'',''{"form_fitness":true,"name":"Bypass Signup","phone":"09170000003","plan":"basic"}'')');
 if has_table_privilege('anon','public.ff_registrations','SELECT')
 or has_table_privilege('authenticated','public.ff_registrations','UPDATE') then
  raise exception 'Registration privileges are too broad';
 end if;
end $$;
set local role authenticated;
do $$ declare r jsonb; request uuid:=gen_random_uuid(); amount integer; begin
 select amount_cents into amount from public.ff_registrations where id=current_setting('test.registration')::uuid;
 r:=public.ff_registration('cash',jsonb_build_object('id',current_setting('test.registration'),'amountCents',amount,
 'method','Cash','verified',true,'emailConfirmed',true,'idempotencyKey',request));
 r:=public.ff_registration('cash',jsonb_build_object('id',current_setting('test.registration'),'amountCents',amount,
 'method','Cash','verified',true,'emailConfirmed',true,'idempotencyKey',request));
 if r->>'status'<>'paid' then raise exception 'Cash was not recorded'; end if;
end $$;
reset role;
do $$ declare m uuid:=current_setting('test.member')::uuid; begin
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
 values(m,'paid-first-db-member@example.invalid',jsonb_build_object('ff_registration',current_setting('test.registration'),
 'ff_workspace','production','ff_role','member'),'{"form_fitness":true}');
 if (select count(*) from public.ff_payments where member_id=m)<>1 then raise exception 'First payment duplicated'; end if;
 if not exists(select 1 from public.ff_invoices where member_id=m and paid_cents=amount_cents) then
  raise exception 'First invoice was not fully paid';
 end if;
 perform pg_temp.expect_failure('insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),''second-paid-account@example.invalid'',jsonb_build_object(''ff_registration'',current_setting(''test.registration'')),''{"form_fitness":true}'')');
end $$;
set local role authenticated;
do $$ declare body jsonb; starts date; amount integer; begin
 select max(end_date)+1 into starts from public.ff_memberships where member_id=current_setting('test.member')::uuid;
 select price_cents into amount from public.ff_plans where workspace='production' and id='plus';
 body:=jsonb_build_object('memberId',current_setting('test.member'),'plan','plus','start',starts,'amountCents',amount,
 'verified',true,'idempotencyKey',gen_random_uuid());
 perform public.ff_walkin_renew(body);
 perform public.ff_walkin_renew(body);
 if (select count(*) from public.ff_memberships where member_id=current_setting('test.member')::uuid)<>2 then
  raise exception 'Renewal duplicated';
 end if;
 perform pg_temp.expect_failure('select public.ff_walkin_renew('||quote_literal((body||'{"amountCents":1}')::text)||'::jsonb)');
end $$;
reset role;
do $$ declare session uuid:=gen_random_uuid(); begin
 insert into auth.sessions(id,user_id) values(session,current_setting('test.member')::uuid);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.member'),
 'role','authenticated','session_id',session)::text,true);
end $$;
set local role authenticated;
do $$ begin
 if exists(select 1 from public.ff_registrations) then raise exception 'Member can see staff registrations'; end if;
 perform pg_temp.expect_failure('select public.ff_registration(''get'',jsonb_build_object(''id'',current_setting(''test.registration'')))');
 perform pg_temp.expect_failure('select public.ff_walkin_renew(''{}'')');
end $$;
rollback;
