-- Local database-only synthetic fixtures. Everything, including Auth rows, rolls back.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table pm_log(label text);
grant select,insert on pm_log to authenticated,service_role;
create function pg_temp.pm_ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if;insert into pm_log values(label);end $$;
create function pg_temp.pm_fail(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement;exception when others then failed:=true;end;perform pg_temp.pm_ok(failed,label);end $$;
-- Passes only on a privilege error (42501), so a retired function that still runs and raises a business error fails it.
create function pg_temp.pm_denied(statement text,label text) returns void language plpgsql as $$
declare state text:='';
begin begin execute statement;exception when others then state:=sqlstate;end;perform pg_temp.pm_ok(state='42501',label);end $$;
select set_config('pm.ids',jsonb_build_object('staff',gen_random_uuid(),'one',gen_random_uuid(),'two',gen_random_uuid(),'session',gen_random_uuid(),'memberSession',gen_random_uuid(),'c1',gen_random_uuid(),'c2',gen_random_uuid())::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select (current_setting('pm.ids')::jsonb->>key)::uuid,'pm-db-'||key||'@example.invalid',jsonb_build_object('ff_workspace','demo','ff_role',case when key='staff' then 'staff' else 'member' end),jsonb_build_object('form_fitness',true,'name','LOCAL TEST PayMongo DB','phone','09170000009','plan','basic','start',ff_private.today()) from unnest(array['staff','one','two']) key;
insert into auth.sessions(id,user_id) values((current_setting('pm.ids')::jsonb->>'session')::uuid,(current_setting('pm.ids')::jsonb->>'staff')::uuid),((current_setting('pm.ids')::jsonb->>'memberSession')::uuid,(current_setting('pm.ids')::jsonb->>'one')::uuid);
select set_config('pm.i1',(select id::text from public.ff_invoices where member_id=(current_setting('pm.ids')::jsonb->>'one')::uuid),true);
select set_config('pm.i2',(select id::text from public.ff_invoices where member_id=(current_setting('pm.ids')::jsonb->>'two')::uuid),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pm.ids')::jsonb->>'staff','role','authenticated','session_id',current_setting('pm.ids')::jsonb->>'session')::text,true);
set local role authenticated;
select pg_temp.pm_fail($q$select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i1'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',true))$q$,'DB rejects live prepare');
select pg_temp.pm_fail($q$select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i1'),'requestId',gen_random_uuid(),'livemode',false))$q$,'DB rejects missing method array');
select pg_temp.pm_fail($q$select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i1'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('qrph'),'livemode',false))$q$,'DB rejects unsupported method');
select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i1'),'requestId',current_setting('pm.ids')::jsonb->>'c1','methods',jsonb_build_array('card'),'livemode',false));
select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i2'),'requestId',current_setting('pm.ids')::jsonb->>'c2','methods',jsonb_build_array('card'),'livemode',false));
select pg_temp.pm_ok((select count(*)=2 from public.ff_checkouts where id in ((current_setting('pm.ids')::jsonb->>'c1')::uuid,(current_setting('pm.ids')::jsonb->>'c2')::uuid)),'Staff can see own workspace targets');
select pg_temp.pm_fail($q$select public.ff_paymongo_settle('{}')$q$,'Authenticated actor cannot settle');
select pg_temp.pm_fail($q$select public.ff_paymongo_bind('{}')$q$,'Authenticated actor cannot bind provider session');
select pg_temp.pm_fail($q$select public.ff_paymongo_review('{}')$q$,'Authenticated actor cannot write review');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pm.ids')::jsonb->>'one','role','authenticated','session_id',current_setting('pm.ids')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.pm_ok((select count(*)=1 from public.ff_checkouts where id in ((current_setting('pm.ids')::jsonb->>'c1')::uuid,(current_setting('pm.ids')::jsonb->>'c2')::uuid)),'Member checkout RLS isolates other member');
select pg_temp.pm_fail($q$update public.ff_checkouts set status='paid'$q$,'Direct customer status write forbidden');
reset role;
select set_config('pm.payment',jsonb_build_object('id',current_setting('pm.ids')::jsonb->>'c1','sessionId','cs_DatabaseOne','reference',current_setting('pm.ids')::jsonb->>'c1','paymentId','pay_DatabaseOne','source','card','amountCents',(select amount_cents from public.ff_invoices where id=current_setting('pm.i1')::uuid),'currency','PHP','status','paid','livemode',false)::text,true);
set local role service_role;
select public.ff_paymongo_bind(jsonb_build_object('id',current_setting('pm.ids')::jsonb->>'c1','sessionId','cs_DatabaseOne','url','https://checkout.paymongo.com/cs_DatabaseOne'));
select pg_temp.pm_fail($q$select public.ff_paymongo_bind(jsonb_build_object('id',current_setting('pm.ids')::jsonb->>'c2','sessionId','cs_DatabaseOne'))$q$,'Unique provider session enforced');
select pg_temp.pm_fail($q$select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb||'{"currency":"USD"}')$q$,'Wrong currency rolls back');
select pg_temp.pm_fail($q$select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb||'{"livemode":true}')$q$,'Live settlement rolls back');
select pg_temp.pm_fail($q$select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb||'{"amountCents":1}')$q$,'Wrong amount rolls back');
select pg_temp.pm_ok((select paid_cents=0 from public.ff_invoices where id=current_setting('pm.i1')::uuid),'Invalid settlement leaves invoice unpaid');
select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb);
select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb);
select pg_temp.pm_ok((select count(*)=1 from public.ff_payments where invoice_id=current_setting('pm.i1')::uuid),'Service settlement and replay insert one payment');
select pg_temp.pm_ok((select paid_cents=amount_cents from public.ff_invoices where id=current_setting('pm.i1')::uuid),'Payment and invoice balance committed together');
select pg_temp.pm_ok((select status='paid' from public.ff_checkouts where id=(current_setting('pm.ids')::jsonb->>'c1')::uuid),'jsonb ff_paymongo_settle still settles as service_role');
select public.ff_paymongo_bind(jsonb_build_object('id',current_setting('pm.ids')::jsonb->>'c2','sessionId','cs_DatabaseTwo','url','https://checkout.paymongo.com/cs_DatabaseTwo'));
select pg_temp.pm_fail($q$select public.ff_paymongo_settle(current_setting('pm.payment')::jsonb||jsonb_build_object('id',current_setting('pm.ids')::jsonb->>'c2','reference',current_setting('pm.ids')::jsonb->>'c2','sessionId','cs_DatabaseTwo'))$q$,'Unique provider payment rejects double credit');
select pg_temp.pm_ok((select status='pending' and payment_id is null from public.ff_checkouts where id=(current_setting('pm.ids')::jsonb->>'c2')::uuid),'Failed transaction rolls back checkout update');
select pg_temp.pm_ok((select paid_cents=0 from public.ff_invoices where id=current_setting('pm.i2')::uuid),'Failed transaction rolls back invoice update');
select pg_temp.pm_ok((select count(*)=0 from public.ff_payments where invoice_id=current_setting('pm.i2')::uuid),'Failed transaction rolls back ledger insert');
-- Task 09 Part B: an administrator closes an unpaid checkout through ff_paymongo_cancel, which checks the role
-- again in the database and appends an audit entry. The server calls it only after PayMongo confirms the expiry.
reset role;
select set_config('pm.cancel',jsonb_build_object('admin',gen_random_uuid(),'adminSession',gen_random_uuid(),'three',gen_random_uuid(),'four',gen_random_uuid(),'prod',gen_random_uuid(),'c3',gen_random_uuid(),'c4',gen_random_uuid(),'cp',gen_random_uuid())::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select (current_setting('pm.cancel')::jsonb->>key)::uuid,'pm-db-'||key||'@example.invalid',jsonb_build_object('ff_workspace',case when key='prod' then 'production' else 'demo' end,'ff_role',case when key='admin' then 'admin' else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST PayMongo cancel','phone','09170000009','plan','basic','start',ff_private.today()) from unnest(array['admin','three','four','prod']) key;
insert into auth.sessions(id,user_id) values((current_setting('pm.cancel')::jsonb->>'adminSession')::uuid,(current_setting('pm.cancel')::jsonb->>'admin')::uuid);
select set_config('pm.i3',(select id::text from public.ff_invoices where member_id=(current_setting('pm.cancel')::jsonb->>'three')::uuid),true);
select set_config('pm.i4',(select id::text from public.ff_invoices where member_id=(current_setting('pm.cancel')::jsonb->>'four')::uuid),true);
insert into public.ff_checkouts(id,workspace,created_by,member_id,invoice_id,amount_cents,methods,livemode,status,session_id)
select (current_setting('pm.cancel')::jsonb->>'cp')::uuid,'production',i.member_id,i.member_id,i.id,i.amount_cents,array['card'],false,'pending','cs_DatabaseProd'
from public.ff_invoices i where i.member_id=(current_setting('pm.cancel')::jsonb->>'prod')::uuid;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pm.ids')::jsonb->>'staff','role','authenticated','session_id',current_setting('pm.ids')::jsonb->>'session')::text,true);
set local role authenticated;
select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i3'),'requestId',current_setting('pm.cancel')::jsonb->>'c3','methods',jsonb_build_array('card'),'livemode',false));
select public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',current_setting('pm.i4'),'requestId',current_setting('pm.cancel')::jsonb->>'c4','methods',jsonb_build_array('card'),'livemode',false));
select pg_temp.pm_denied($q$select public.ff_paymongo_cancel('check',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3'))$q$,'Staff cannot cancel a checkout');
reset role;
set local role service_role;
select public.ff_paymongo_bind(jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','url','https://checkout.paymongo.com/cs_DatabaseThree'));
-- c4 has the shape of the six stuck live checkouts: needs_review, never bound, session id kept in review_details.
select public.ff_paymongo_review(jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c4','category','checkout_reference_mismatch','sessionId','cs_DatabaseFour'));
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pm.ids')::jsonb->>'one','role','authenticated','session_id',current_setting('pm.ids')::jsonb->>'memberSession')::text,true);
set local role authenticated;
select pg_temp.pm_denied($q$select public.ff_paymongo_cancel('check',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3'))$q$,'A member cannot cancel a checkout');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pm.cancel')::jsonb->>'admin','role','authenticated','session_id',current_setting('pm.cancel')::jsonb->>'adminSession')::text,true);
set local role authenticated;
select pg_temp.pm_ok((select public.ff_paymongo_cancel('check',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3'))->>'status')='pending','Admin check returns the open checkout');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('check',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'cp'))$q$,'Admin cannot cancel another workspace''s checkout');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_SomeoneElse','providerStatus',200,'via','expire'))$q$,'Cancel refuses a session the checkout is not bound to');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','providerStatus','ok','via','expire'))$q$,'Cancel requires PayMongo''s HTTP status');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','providerStatus',200,'via','guess'))$q$,'Cancel requires a known outcome');
select pg_temp.pm_fail($q$select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('pm.i3'),'amountCents',100,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true))$q$,'An open checkout blocks cash before the cancel');
select pg_temp.pm_ok((select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','providerStatus',200,'via','expire'))->>'status')='expired','Admin cancel marks the checkout expired');
select pg_temp.pm_ok((select status='expired' and review_reason is null and review_log->-1->>'action'='cancel' and review_log->-1->>'by'=current_setting('pm.cancel')::jsonb->>'admin' and (review_log->-1->>'providerStatus')::int=200
 and review_log->-1->>'sessionId'='cs_DatabaseThree' and review_log->-1->>'via'='expire' and review_log->-1 ? 'at' from public.ff_checkouts where id=(current_setting('pm.cancel')::jsonb->>'c3')::uuid),'Cancel appends who, when, PayMongo status and session to review_log');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','providerStatus',200,'via','expire'))$q$,'A closed checkout cannot be cancelled again');
select pg_temp.pm_fail($q$select public.ff_paymongo_cancel('check',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3'))$q$,'A closed checkout fails the check');
select pg_temp.pm_ok((select public.ff_paymongo_cancel('expire',jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c4','sessionId','cs_DatabaseFour','providerStatus',200,'via','already_expired'))->>'status')='expired','An unbound stuck checkout is cancelled with its saved session');
select pg_temp.pm_ok((select session_id='cs_DatabaseFour' and review_reason is null and review_details->>'category'='checkout_reference_mismatch' and review_log->-1->>'via'='already_expired'
 from public.ff_checkouts where id=(current_setting('pm.cancel')::jsonb->>'c4')::uuid),'Cancel binds the verified session and keeps the original review details');
select public.ff_command('payments',jsonb_build_object('invoiceId',current_setting('pm.i4'),'amountCents',(select amount_cents from public.ff_invoices where id=current_setting('pm.i4')::uuid),'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true));
select pg_temp.pm_ok((select paid_cents=amount_cents from public.ff_invoices where id=current_setting('pm.i4')::uuid),'After the cancel the invoice can be paid another way');
reset role;
-- The race: PayMongo confirms a payment after the cancel. Settlement still records it, never discards it.
set local role service_role;
select public.ff_paymongo_settle(jsonb_build_object('id',current_setting('pm.cancel')::jsonb->>'c3','sessionId','cs_DatabaseThree','reference',current_setting('pm.cancel')::jsonb->>'c3','paymentId','pay_DatabaseThree','source','card',
 'amountCents',(select amount_cents from public.ff_invoices where id=current_setting('pm.i3')::uuid),'currency','PHP','status','paid','livemode',false));
select pg_temp.pm_ok((select c.status='paid' and c.payment_id='pay_DatabaseThree' and i.paid_cents=i.amount_cents from public.ff_checkouts c join public.ff_invoices i on i.id=c.invoice_id where c.id=(current_setting('pm.cancel')::jsonb->>'c3')::uuid),'A verified payment arriving after the cancel is still recorded');
reset role;
select pg_temp.pm_ok(not has_function_privilege('anon','public.ff_paymongo_cancel(text,jsonb)','execute'),'Anonymous cannot cancel a checkout');
set local role service_role;
-- main's retired PayMongo design (20261010120000): closed to service_role, history kept readable.
select pg_temp.pm_denied($q$select public.ff_paymongo_reserve(gen_random_uuid(),gen_random_uuid(),'demo',false,gen_random_uuid())$q$,'service_role cannot execute retired ff_paymongo_reserve');
select pg_temp.pm_denied($q$select public.ff_paymongo_settle(gen_random_uuid(),'cs_Retired','pay_Retired',100,'gcash',false)$q$,'service_role cannot execute retired 6-argument ff_paymongo_settle');
select pg_temp.pm_denied($q$insert into public.ff_paymongo_attempts(id,workspace,member_id,invoice_id,amount_cents,live) values(gen_random_uuid(),'demo',(current_setting('pm.ids')::jsonb->>'two')::uuid,current_setting('pm.i2')::uuid,100,false)$q$,'service_role cannot insert into ff_paymongo_attempts');
select pg_temp.pm_ok(has_table_privilege('service_role','public.ff_paymongo_attempts','select') and not has_table_privilege('service_role','public.ff_paymongo_attempts','update') and not has_table_privilege('service_role','public.ff_paymongo_attempts','delete') and not has_table_privilege('service_role','public.ff_paymongo_attempts','truncate'),'Attempt history stays readable but cannot be changed or erased by service_role');
reset role;
select pg_temp.pm_ok(not has_function_privilege('anon','public.ff_paymongo_settle(jsonb)','execute'),'Anonymous cannot settle');
select pg_temp.pm_ok(not has_function_privilege('anon','public.ff_paymongo_prepare(jsonb)','execute'),'Anonymous cannot prepare a checkout');
select count(*) as passed_checks from pm_log;
rollback;
