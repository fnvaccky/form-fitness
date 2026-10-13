-- Task 13B: the short manual pass code. Local fixtures only; everything, including Auth rows, rolls back.
-- now() is the transaction's start time, so a pass issued here stays live for the whole script.
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table pc_log(label text);
grant select,insert on pc_log to authenticated,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into pc_log values(label); end $$;
create function pg_temp.fails_with(statement text,expected text,label text) returns void language plpgsql as $$
declare msg text:='(no error raised)';
begin begin execute statement; exception when others then msg:=sqlerrm; end; perform pg_temp.ok(position(expected in msg)=1,label||' ['||msg||']'); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare state text:='';
begin begin execute statement; exception when others then state:=sqlstate; end; perform pg_temp.ok(state='42501',label||' ['||state||']'); end $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('pc.ids')::jsonb->>k,'role','authenticated','session_id',current_setting('pc.ids')::jsonb->>(k||'Session'))::text,true) $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('pc.ids')::jsonb->>k)::uuid $$;
-- A staff lookup, as the staff member who is currently signed in.
create function pg_temp.lookup(code text) returns jsonb language sql as $$ select public.ff_pass_code('lookup',jsonb_build_object('code',code)) $$;
select set_config('pc.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['staff','staffSession','guesser','guesserSession','demostaff','demostaffSession',
 'paid','paidSession','second','secondSession','disabled','disabledSession','unpaid','unpaidSession']) k)::text,true);
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'pc-'||k||'@example.invalid',jsonb_build_object('ff_workspace',case when k='demostaff' then 'demo' else 'production' end,'ff_role',case when k in ('staff','guesser','demostaff') then 'staff' else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Code '||k,'phone','09170000070')||case when k in ('paid','second','disabled','unpaid') then jsonb_build_object('plan','basic','start',ff_private.today()) else '{}'::jsonb end
from unnest(array['staff','guesser','demostaff','paid','second','disabled','unpaid']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['staff','guesser','demostaff','paid','second','disabled','unpaid']) k;
-- Staff record cash for three of the members, so they have a live pass.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('payments',jsonb_build_object('invoiceId',i.id,'amountCents',i.amount_cents,'method','Cash','idempotencyKey',gen_random_uuid(),'verified',true))
from public.ff_invoices i where i.member_id in (pg_temp.id('paid'),pg_temp.id('second'),pg_temp.id('disabled'));
reset role;

-- The member's pass: the QR and, paired with it, a code shown as XXXX-XXXX.
select pg_temp.as_user('paid');
set local role authenticated;
select set_config('pc.qr1',public.ff_command('qr','{}')->>'token',true);
select set_config('pc.code1',public.ff_pass_code('issue',jsonb_build_object('token',current_setting('pc.qr1')))->>'code',true);
select pg_temp.ok(current_setting('pc.code1') ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$','The code is 8 Crockford base32 characters, shown as XXXX-XXXX');
select pg_temp.fails_with(format('select public.ff_pass_code(%L,jsonb_build_object(%L,%L))','issue','token',current_setting('pc.qr1')),'This pass already has a code.','One code per pass');
select pg_temp.denied('select * from public.ff_pass_codes','Members can''t read pass codes');
select pg_temp.denied('select * from public.ff_pass_code_attempts','Members can''t read the attempt log');
select pg_temp.denied('insert into public.ff_pass_codes(workspace,member_id,code_hash,nonce,expires_at) values(''production'',auth.uid(),''x'',gen_random_uuid(),now())','Members can''t write pass codes');
select pg_temp.fails_with($q$select public.ff_pass_code('lookup','{"code":"7KQ2-M9XD"}')$q$,'Gym staff access is required.','Members can''t look codes up');
reset role;
select pg_temp.ok((select count(*)=1 from public.ff_pass_codes where member_id=pg_temp.id('paid') and nonce=(convert_from(decode(split_part(current_setting('pc.qr1'),'.',2),'base64'),'UTF8')::jsonb->>'nonce')::uuid
 and expires_at=to_timestamp((convert_from(decode(split_part(current_setting('pc.qr1'),'.',2),'base64'),'UTF8')::jsonb->>'exp')::bigint)),'The code is paired with the QR: the same nonce and the same expiry');
select pg_temp.ok(not exists(select 1 from public.ff_pass_codes where code_hash ilike '%'||replace(current_setting('pc.code1'),'-','')||'%'),'Only a keyed hash of the code is stored, never the plain code');
-- Issuing a code for someone else's pass, a forged pass or an expired pass is refused.
select pg_temp.as_user('second');
set local role authenticated;
select pg_temp.fails_with(format('select public.ff_pass_code(%L,jsonb_build_object(%L,%L))','issue','token',current_setting('pc.qr1')),'This pass belongs to another member.','A member can''t get a code for another member''s pass');
select pg_temp.fails_with(format('select public.ff_pass_code(%L,jsonb_build_object(%L,%L))','issue','token',left(current_setting('pc.qr1'),-4)||'0000'),'Invalid member pass signature.','A forged pass gets no code');
reset role;

-- Staff type the code: any case, with or without the dash or spaces. It brings the same signed pass as the QR.
select pg_temp.ok(ff_private.pass_code_normal(' 7kq2 m9-xd ')='7KQ2M9XD' and ff_private.pass_code_normal('o1L-i')='0111','Normalising: upper case, no dashes or spaces, and Crockford''s O as 0, I and L as 1');
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code1'))->>'token'=current_setting('pc.qr1'),'The code brings back exactly the member''s QR pass');
select pg_temp.ok(pg_temp.lookup(lower(replace(current_setting('pc.code1'),'-','  ')))->>'token'=current_setting('pc.qr1'),'Lower case and spaces instead of the dash work');
select pg_temp.ok((public.ff_command('scan',jsonb_build_object('token',pg_temp.lookup(current_setting('pc.code1'))->>'token'))->'member'->>'id')::uuid=pg_temp.id('paid'),'The scan that follows identifies the member');
select pg_temp.ok(pg_temp.lookup('7KQ2-M9X')->>'error'='Enter the 8-character pass code, for example 7KQ2-M9XD.','A code of the wrong length is a typo, not a guess');
select pg_temp.ok(pg_temp.lookup('UUUU-UUUU')->>'error'='Enter the 8-character pass code, for example 7KQ2-M9XD.','U is not a Crockford character');
reset role;
select pg_temp.ok((select count(*)=0 from public.ff_pass_code_attempts where staff_id=pg_temp.id('staff')),'Typos and good codes aren''t counted as wrong attempts');
-- Another workspace's staff can't use the code.
select pg_temp.as_user('demostaff');
set local role authenticated;
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code1'))->>'error'='Pass code not recognised. Check it with the member.','A code from another workspace is not recognised');
reset role;
select pg_temp.ok((select count(*)=1 from public.ff_pass_code_attempts where staff_id=pg_temp.id('demostaff')),'That counts as one wrong attempt');

-- Using the QR uses up the code: a check-in by QR, then the code.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('check-in',jsonb_build_object('token',current_setting('pc.qr1'),'confirmed',true));
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code1'))->>'error'='This pass code was already used.','After the QR checks the member in, its code is used up');
reset role;
select pg_temp.ok((select used_at is not null from public.ff_pass_codes where member_id=pg_temp.id('paid')),'The check-in marks the code used');
-- A fresh pass later the same day: its code leads to "Already recorded", and no second check-in.
select pg_temp.as_user('paid');
set local role authenticated;
select set_config('pc.qr2',public.ff_command('qr','{}')->>'token',true);
select set_config('pc.code2',public.ff_pass_code('issue',jsonb_build_object('token',current_setting('pc.qr2')))->>'code',true);
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((public.ff_command('scan',jsonb_build_object('token',pg_temp.lookup(current_setting('pc.code2'))->>'token'))->>'alreadyCheckedInAt') is not null,'A fresh code after today''s check-in shows the visit as already recorded');
select pg_temp.fails_with(format('select public.ff_command(%L,jsonb_build_object(%L,%L,%L,true))','check-in','token',pg_temp.lookup(current_setting('pc.code2'))->>'token','confirmed'),'Already checked in today.','and records no second check-in');
reset role;

-- Using the code uses up the QR: a check-in by code, then the QR.
select pg_temp.as_user('second');
set local role authenticated;
select set_config('pc.qr3',public.ff_command('qr','{}')->>'token',true);
select set_config('pc.code3',public.ff_pass_code('issue',jsonb_build_object('token',current_setting('pc.qr3')))->>'code',true);
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('check-in',jsonb_build_object('token',pg_temp.lookup(current_setting('pc.code3'))->>'token','confirmed',true));
select pg_temp.fails_with(format('select public.ff_command(%L,jsonb_build_object(%L,%L))','scan','token',current_setting('pc.qr3')),'This pass was already used.','After the code checks the member in, the QR is used up');
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code3'))->>'error'='This pass code was already used.','and so is the code');
reset role;
select pg_temp.ok((select count(*)=1 from public.ff_checkins where member_id=pg_temp.id('second')),'One check-in recorded by code');

-- Expired: the code shares the QR's 90 seconds.
select pg_temp.as_user('disabled');
set local role authenticated;
select set_config('pc.qr4',public.ff_command('qr','{}')->>'token',true);
select set_config('pc.code4',public.ff_pass_code('issue',jsonb_build_object('token',current_setting('pc.qr4')))->>'code',true);
select set_config('pc.qr5',public.ff_command('qr','{}')->>'token',true);
select set_config('pc.code5',public.ff_pass_code('issue',jsonb_build_object('token',current_setting('pc.qr5')))->>'code',true);
reset role;
update public.ff_pass_codes set expires_at=now()-interval '1 second' where nonce=(convert_from(decode(split_part(current_setting('pc.qr4'),'.',2),'base64'),'UTF8')::jsonb->>'nonce')::uuid;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code4'))->>'error'='Code expired — ask the member to refresh their pass.','An expired code is refused with its own message');
reset role;
-- Disabled: the code is found, and the scan refuses the member, exactly as for the QR.
update public.ff_profiles set enabled=false where id=pg_temp.id('disabled');
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.fails_with(format('select public.ff_command(%L,jsonb_build_object(%L,%L))','scan','token',pg_temp.lookup(current_setting('pc.code5'))->>'token'),'This membership is inactive.','A disabled member''s code is refused at the scan');
reset role;
-- Unpaid: no pass, so no code.
select pg_temp.as_user('unpaid');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_command('qr','{}')$q$,'Check-in denied','An unpaid member gets no pass, so no code');
reset role;

-- Brute force: 10 wrong codes in 5 minutes per staff account, then a pause, even for a good code.
select pg_temp.as_user('guesser');
set local role authenticated;
select pg_temp.ok(bool_and(pg_temp.lookup(lpad(n::text,8,'0'))->>'error'='Pass code not recognised. Check it with the member.'),'Ten wrong codes are each refused') from generate_series(1,10) n;
select pg_temp.ok(pg_temp.lookup('0000-0011')->>'error'='Too many attempts — wait a few minutes.','The eleventh attempt is stopped');
select pg_temp.ok((pg_temp.lookup(current_setting('pc.code2'))->>'status')='429','even with a good code, with status 429');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code2')) ? 'token','Other staff accounts are not affected');
reset role;
update public.ff_pass_code_attempts set attempted_at=now()-interval '6 minutes' where staff_id=pg_temp.id('guesser');
select pg_temp.as_user('guesser');
set local role authenticated;
select pg_temp.ok(pg_temp.lookup(current_setting('pc.code2')) ? 'token','After 5 minutes the staff member can look codes up again');
reset role;

-- Housekeeping: code rows go a day after they expire; recent ones stay. Codes are unique per workspace.
insert into public.ff_pass_codes(workspace,member_id,code_hash,nonce,expires_at,created_at) values
 ('production',pg_temp.id('paid'),'old-'||gen_random_uuid(),gen_random_uuid(),now()-interval '25 hours',now()-interval '25 hours'),
 ('production',pg_temp.id('paid'),'recent-'||gen_random_uuid(),gen_random_uuid(),now()-interval '1 hour',now()-interval '1 hour');
insert into public.ff_pass_code_attempts(workspace,staff_id,attempted_at) values('production',pg_temp.id('guesser'),now()-interval '25 hours');
select pg_temp.as_user('paid');
set local role authenticated;
select public.ff_pass_code('issue',jsonb_build_object('token',public.ff_command('qr','{}')->>'token'));
reset role;
select pg_temp.ok(not exists(select 1 from public.ff_pass_codes where code_hash like 'old-%') and exists(select 1 from public.ff_pass_codes where code_hash like 'recent-%'),'Expired code rows are removed after a day');
select pg_temp.ok(not exists(select 1 from public.ff_pass_code_attempts where attempted_at<now()-interval '1 day'),'and so are attempt records');
select pg_temp.ok(exists(select 1 from pg_constraint where conrelid='public.ff_pass_codes'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (workspace, code_hash)'),'Codes are unique within a workspace');

-- Grants: only signed-in accounts may call the entry point; the internals are nobody's.
select pg_temp.ok(not has_function_privilege('anon','public.ff_pass_code(text,jsonb)','execute'),'Signed-out callers can''t use pass codes');
select pg_temp.ok(not has_function_privilege('authenticated','ff_private.pass_code_hash(text,text)','execute') and not has_function_privilege('authenticated','ff_private.pass_code_normal(text)','execute'),'The hash and normaliser are internal');
select count(*) as passed_checks from pc_log;
rollback;
