-- Task 12A: plan management and purchased terms, in the database. Local fixtures only; everything, including the Auth
-- rows and the plan edits, rolls back. No emails are sent and PayMongo is never called (its settlement is simulated
-- the way the webhook calls it, as service_role).
begin;
set constraints auth.ff_auth_user_created immediate;
create temporary table pl_log(label text);
grant select,insert on pl_log to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAILED: %',label; end if; insert into pl_log values(label); end $$;
create function pg_temp.denied(statement text,label text) returns void language plpgsql as $$
declare failed boolean:=false;
begin begin execute statement; exception when others then failed:=true; end; perform pg_temp.ok(failed,label); end $$;
create function pg_temp.fails_with(statement text,expected text,label text) returns void language plpgsql as $$
declare msg text:='(no error raised)';
begin begin execute statement; exception when others then msg:=sqlerrm; end; perform pg_temp.ok(position(expected in msg)=1,label||' ['||msg||']'); end $$;
create function pg_temp.id(k text) returns uuid language sql as $$ select (current_setting('pl.ids')::jsonb->>k)::uuid $$;
create function pg_temp.as_user(k text) returns void language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id(k),'role','authenticated','session_id',pg_temp.id(k||'Session'))::text,true) $$;
-- A complete, valid plan body; a test changes only what it needs.
create function pg_temp.plan(changes jsonb) returns jsonb language sql as $$
 select jsonb_build_object('id','zz-test','name','LOCAL TEST Plan','priceCents',120000,'days',28,'description','A plan made by the tests.',
  'features',jsonb_build_array('Gym floor','Everything in Essential'),'available',true,'coaching','group','coachSessions',2,'focusTags',jsonb_build_array('cardio','strength'))||changes $$;
-- A complete body from a production plan as it is now, with some fields changed.
create function pg_temp.body(plan_id text,changes jsonb default '{}') returns jsonb language sql as $$
 select jsonb_build_object('id',id,'name',name,'priceCents',price_cents,'days',days,'description',description,'features',features,'available',available,
  'coaching',coaching,'coachSessions',coach_sessions,'focusTags',to_jsonb(focus_tags))||changes from public.ff_plans where workspace='production' and id=plan_id $$;
create function pg_temp.cycle(k text,plan text) returns public.ff_memberships language sql as $$
 select * from public.ff_memberships where member_id=pg_temp.id(k) and plan_id=plan order by start_date desc limit 1 $$;
create function pg_temp.invoice(k text,plan text) returns public.ff_invoices language sql as $$
 select i.* from public.ff_invoices i where i.membership_id=(pg_temp.cycle(k,plan)).id $$;
-- Staff take cash at the desk (the full remaining balance unless an amount is given).
create function pg_temp.cash(k text,plan text,amount integer default null) returns void language plpgsql as $$
declare inv public.ff_invoices:=pg_temp.invoice(k,plan);
begin
 perform pg_temp.as_user('staff');
 perform public.ff_command('payments',jsonb_build_object('invoiceId',inv.id,'amountCents',coalesce(amount,inv.amount_cents-inv.paid_cents),'method','Cash','verified',true,'idempotencyKey',gen_random_uuid()));
end $$;
select set_config('pl.ids',(select jsonb_object_agg(k,gen_random_uuid()) from unnest(array['admin','adminSession','staff','staffSession','member','memberSession','other','otherSession',
 'demoAdmin','demoAdminSession','m1','m1Session','m2','m2Session','m3','m3Session','m4','m4Session','m5','m6','m6Session','walk','walkSession','reg','pm','pmSession','legacy']) k)::text,true);
select set_config('pl.today',ff_private.today()::text,true);
-- The accounts, the way the app makes them. m1 to m6, walk and pm are production members with no plan yet.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
select pg_temp.id(k),'pl-'||lower(k)||'@example.invalid',jsonb_build_object('ff_workspace',case when k='demoAdmin' then 'demo' else 'production' end,'ff_role',case when k in ('admin','demoAdmin') then 'admin' when k='staff' then 'staff' else 'member' end),
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Plans '||k,'phone','09170000050')
from unnest(array['admin','staff','member','other','demoAdmin','m1','m2','m3','m4','m6','walk','pm']) k;
insert into auth.sessions(id,user_id) select pg_temp.id(k||'Session'),pg_temp.id(k) from unnest(array['admin','staff','member','other','demoAdmin','m1','m2','m3','m4','m6','walk','pm']) k;

-- 1. The coaching defaults, in both workspaces; everything the plans had before stays as it was. ------------------
select pg_temp.ok((select count(*)=6 from public.ff_plans where (id,coaching,coach_sessions,focus_tags) in
 (('basic','none',0,array['strength','cardio']),('plus','group',0,array['cardio','mobility','group_classes']),('elite','personal',4,array['strength','mobility']))),'The three plans have their coaching defaults and focus tags in both workspaces');
select pg_temp.ok((select count(*)=6 from public.ff_plans where (id,name,price_cents,days,available,description,features) in (
 ('basic','Essential',89900,30,true,'A solid foundation for your fitness routine.','["Unlimited gym access","All strength equipment","Locker room access","Fitness orientation"]'::jsonb),
 ('plus','Momentum',149900,30,true,'More variety. More support. More momentum.','["Everything in Essential","Unlimited group classes","Monthly fitness check-in","One guest pass per cycle"]'::jsonb),
 ('elite','Performance',249900,30,true,'Focused coaching for your personal best.','["Everything in Momentum","4 personal training sessions","Personalized workout plan","Priority class booking"]'::jsonb))),
 'Their IDs, names, prices, lengths, availability, descriptions and features are unchanged');
select pg_temp.ok((select count(*)=0 from public.ff_memberships where terms is null) and (select count(*)=0 from public.ff_registrations where terms is null),'Every existing cycle and registration has its purchased terms');

-- 2. Plan management: administrators of the caller's own workspace only. -------------------------------------------
select pg_temp.as_user('admin');
set local role authenticated;
select set_config('pl.saved',public.ff_plan_admin('create',pg_temp.plan('{}'))::text,true);
select pg_temp.ok((select p->>'workspace'='production' and p->>'id'='zz-test' and p->>'name'='LOCAL TEST Plan' and (p->>'price_cents')::int=120000 and (p->>'days')::int=28
 and p->>'coaching'='group' and (p->>'coach_sessions')::int=2 and p->'focus_tags'='["strength","cardio"]'::jsonb and (p->>'available')::boolean
 from (select current_setting('pl.saved')::jsonb p) x),'An administrator adds a plan; it is saved in their own workspace, focus tags in their usual order');
select pg_temp.ok((public.ff_plan_admin('create',pg_temp.plan('{}'))->>'alreadySaved')::boolean,'Repeating the same Add plan returns the saved plan instead of a second one');
select pg_temp.fails_with($q$select public.ff_plan_admin('create',pg_temp.plan('{"priceCents":99900}'))$q$,'A plan with this ID already exists.','Adding an existing ID with other details is refused');
select pg_temp.fails_with($q$select public.ff_plan_admin('create',pg_temp.plan('{"id":"zz-other","name":"essential"}'))$q$,'Another plan already uses this name.','Plan names are unique in a workspace, ignoring case');
select public.ff_plan_admin('update',pg_temp.plan('{"name":"LOCAL TEST Plan edited","priceCents":125050,"days":31,"description":"Edited.","features":["Gym floor","Sauna"],"coaching":"personal","coachSessions":6,"focusTags":["mobility"]}'));
select pg_temp.ok((select name='LOCAL TEST Plan edited' and price_cents=125050 and days=31 and description='Edited.' and features='["Gym floor","Sauna"]' and coaching='personal' and coach_sessions=6 and focus_tags=array['mobility']
 from public.ff_plans where workspace='production' and id='zz-test'),'An administrator edits every field but the ID');
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"id":"zz-missing"}'))$q$,'Plan not found.','Editing a plan that does not exist is refused');
select public.ff_plan_admin('update',pg_temp.plan('{"name":"LOCAL TEST Plan edited","available":false}'));
select pg_temp.ok((select not available from public.ff_plans where workspace='production' and id='zz-test'),'Retiring a plan makes it unavailable');
select pg_temp.ok((select count(*)=1 from public.ff_plans where id='zz-test'),'A retired plan stays readable to the gym');
select public.ff_plan_admin('update',pg_temp.plan('{"available":true}'));
reset role;
-- Everyone else is refused, and an administrator never reaches another workspace.
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Administrator access is required.','Staff cannot change a plan');
select pg_temp.fails_with($q$select public.ff_plan_admin('create',pg_temp.plan('{"id":"zz-staff"}'))$q$,'Administrator access is required.','Staff cannot add a plan');
select pg_temp.ok((select count(*)=4 and bool_and(coaching is not null) from public.ff_plans where workspace='production'),'Staff read the plans, coaching included');
reset role;
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Administrator access is required.','A member cannot change a plan');
reset role;
set local role anon;
select pg_temp.denied($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Signed-out callers cannot change a plan');
select pg_temp.ok((select count(*)=4 from public.ff_plans),'Signed-out callers see only the available production plans');
reset role;
update public.ff_profiles set enabled=false where id=pg_temp.id('admin');
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Please sign in to continue.','A disabled administrator cannot change a plan');
reset role;
update public.ff_profiles set enabled=true where id=pg_temp.id('admin');
delete from auth.sessions where id=pg_temp.id('adminSession');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Please sign in to continue.','A revoked session cannot change a plan');
reset role;
insert into auth.sessions(id,user_id) values(pg_temp.id('adminSession'),pg_temp.id('admin'));
select pg_temp.as_user('demoAdmin');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":1}'))$q$,'Plan not found.','A demo administrator cannot reach a production plan');
select pg_temp.ok((select count(*)=0 from public.ff_plans where id='zz-test'),'nor read it');
select public.ff_plan_admin('create',pg_temp.plan('{"name":"LOCAL TEST Demo plan","priceCents":50000}'));
reset role;
select pg_temp.ok((select count(*)=2 and count(distinct workspace)=2 from public.ff_plans where id='zz-test')
 and (select price_cents=50000 from public.ff_plans where workspace='demo' and id='zz-test') and (select price_cents=120000 from public.ff_plans where workspace='production' and id='zz-test'),
 'The same ID in another workspace is another plan; each administrator changed only their own');

-- 3. Every field is checked in the database, whoever calls. --------------------------------------------------------
select pg_temp.as_user('admin');
set local role authenticated;
do $$ declare c record; begin
 for c in select * from (values
  ('{"workspace":"demo"}'::jsonb,'Send only the plan''s details.'),('{"role":"admin"}','Send only the plan''s details.'),
  ('{"id":"Bad ID"}','Plan ID:'),('{"id":"a"}','Plan ID:'),('{"id":"1plan"}','Plan ID:'),('{"id":"abcdefghijklmnopqrstuvwxyz0123456"}','Plan ID:'),('{"id":7}','Plan ID:'),
  ('{"name":"A"}','Enter a plan name'),('{"name":"<b>Bold</b>"}','Enter a plan name'),('{"name":"Line\nbreak"}','Enter a plan name'),('{"name":12}','Enter a plan name'),
  ('{"priceCents":0}','Enter a price'),('{"priceCents":-100}','Enter a price'),('{"priceCents":10000001}','Enter a price'),('{"priceCents":1999.5}','Enter a price'),('{"priceCents":"120000"}','Enter a price'),
  ('{"days":0}','Enter a cycle length'),('{"days":367}','Enter a cycle length'),('{"days":30.5}','Enter a cycle length'),('{"days":"30"}','Enter a cycle length'),
  ('{"description":"<script>"}','Keep the description'),('{"description":"Two\nlines"}','Keep the description'),('{"description":5}','Keep the description'),
  ('{"features":"Gym floor"}','List up to 10 features.'),('{"features":["1","2","3","4","5","6","7","8","9","10","11"]}','List up to 10 features.'),
  ('{"features":[""]}','Each feature is one line'),('{"features":["<b>"]}','Each feature is one line'),('{"features":[3]}','Each feature is one line'),('{"features":["Gym","Gym"]}','List each feature once.'),
  ('{"available":"true"}','Choose whether the plan is available'),('{"available":null}','Choose whether the plan is available'),
  ('{"coaching":"coach"}','Choose the coaching'),('{"coaching":1}','Choose the coaching'),
  ('{"coachSessions":31}','Enter 0 to 30 coach sessions'),('{"coachSessions":-1}','Enter 0 to 30 coach sessions'),('{"coachSessions":1.5}','Enter 0 to 30 coach sessions'),('{"coachSessions":"2"}','Enter 0 to 30 coach sessions'),
  ('{"coaching":"none","coachSessions":3}','A plan with no coach has 0 coach sessions.'),
  ('{"focusTags":["yoga"]}','Choose focus tags'),('{"focusTags":["cardio","cardio"]}','Choose focus tags'),('{"focusTags":"cardio"}','Choose focus tags'),('{"focusTags":[null]}','Choose focus tags')
 ) as t(changes,expected) loop
  perform pg_temp.fails_with(format('select public.ff_plan_admin(%L,%L::jsonb)','update',pg_temp.plan(c.changes)),c.expected,'Refused: '||c.changes::text);
 end loop;
end $$;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.plan('{}')-'days')$q$,'Enter a cycle length','A missing field is refused');
select pg_temp.fails_with($q$select public.ff_plan_admin('delete',pg_temp.plan('{}'))$q$,'Unknown plan action.','There is no delete action');
select pg_temp.fails_with($q$select public.ff_plan_admin('update',null)$q$,'Send only the plan''s details.','No details are refused');
select pg_temp.fails_with($q$select public.ff_plan_admin('update','[]')$q$,'Send only the plan''s details.','Details that are not an object are refused');
select pg_temp.ok((select name='LOCAL TEST Plan' and price_cents=120000 from public.ff_plans where workspace='production' and id='zz-test'),'A refused change leaves the plan as it was');
select public.ff_plan_admin('update',pg_temp.plan('{"name":"  LOCAL TEST Plan  ","description":"  Trimmed.  ","features":["  Gym floor  ","Everything in Essential"],"coaching":"none","coachSessions":0,"focusTags":[]}'));
select pg_temp.ok((select name='LOCAL TEST Plan' and description='Trimmed.' and features='["Gym floor","Everything in Essential"]' and coaching='none' and coach_sessions=0 and focus_tags='{}'
 from public.ff_plans where workspace='production' and id='zz-test'),'Names, descriptions and features are trimmed; no focus tags is allowed');
-- No other way in: not the table, not ff_private.command's old 'plans' action, not the service key, not a delete.
select pg_temp.denied($q$update public.ff_plans set price_cents=1 where id='zz-test'$q$,'An administrator cannot write the plan table directly');
select pg_temp.denied($q$delete from public.ff_plans where id='zz-test'$q$,'nor delete from it');
select pg_temp.fails_with($q$select public.ff_command('plans',jsonb_build_object('id','zz-test','name','Old form','priceCents',100,'available',true))$q$,'Plans are changed only in plan management.','The old plans action of ff_private.command is closed');
reset role;
set local role service_role;
select pg_temp.fails_with($q$update public.ff_plans set price_cents=1 where id='zz-test'$q$,'Plans are changed only in plan management.','The service key cannot change a plan');
select pg_temp.fails_with($q$insert into public.ff_plans(workspace,id,name,price_cents) values('production','zz-service','LOCAL TEST Service',100)$q$,'Plans are changed only in plan management.','nor add one');
select pg_temp.fails_with($q$delete from public.ff_plans where id='zz-test'$q$,'Plans can''t be deleted.','nor delete one');
reset role;
select pg_temp.fails_with($q$delete from public.ff_plans where id='zz-test'$q$,'Plans can''t be deleted.','Plans can''t be deleted at all, even by the database owner');
select pg_temp.fails_with($q$update public.ff_plans set name='LOCAL TEST Owner' where id='zz-test'$q$,'Plans are changed only in plan management.','The database owner goes through plan management too');
select set_config('ff.plan_admin','on',true);
select pg_temp.fails_with($q$update public.ff_plans set id='zz-renamed' where workspace='production' and id='zz-test'$q$,'A plan''s ID can''t be changed.','A plan''s ID never changes');
select pg_temp.denied($q$update public.ff_plans set focus_tags=array['cardio','strength'] where workspace='production' and id='zz-test'$q$,'The table keeps focus tags in their order');
select pg_temp.denied($q$update public.ff_plans set coaching='none',coach_sessions=2 where workspace='production' and id='zz-test'$q$,'The table keeps no-coach plans at 0 sessions');
select pg_temp.denied($q$update public.ff_plans set features='["<b>"]' where workspace='production' and id='zz-test'$q$,'The table keeps features safe');
select set_config('ff.plan_admin','',true);

-- 4. Purchased terms survive catalog edits. --------------------------------------------------------------------------
-- m1: Momentum at the desk, partly paid. m2: Momentum, paid. m3: Performance, unpaid.
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',k,'plan',p,'start',current_setting('pl.today'))) from (values (pg_temp.id('m1'),'plus'),(pg_temp.id('m2'),'plus'),(pg_temp.id('m3'),'elite')) as x(k,p);
reset role;
select pg_temp.cash('m1','plus',50000);select pg_temp.cash('m2','plus');
reset role;
select pg_temp.ok((select terms=ff_private.plan_terms(p,'purchase') and terms->>'source'='purchase' from public.ff_memberships m join public.ff_plans p on p.workspace=m.workspace and p.id=m.plan_id where m.id=(pg_temp.cycle('m1','plus')).id),
 'A desk plan keeps the plan''s terms from the moment its cycle was created');
select pg_temp.ok((select terms->'included'='[{"line":"Everything in Essential","plan":"Essential","features":["Unlimited gym access","All strength equipment","Locker room access","Fitness orientation"]}]'::jsonb
 from public.ff_memberships where id=(pg_temp.cycle('m1','plus')).id),'"Everything in Essential" is frozen as Essential''s features at that moment');
select pg_temp.ok((select terms->'included'->0->>'plan'='Momentum' and jsonb_array_length(terms->'included'->0->'features')=7 and terms->'included'->0->'features' ? 'Fitness orientation'
 from public.ff_memberships where id=(pg_temp.cycle('m3','elite')).id),'Performance''s "Everything in Momentum" includes Momentum''s own features and Essential''s');
create temporary table pl_before as select m.id,m.terms,i.amount_cents,i.paid_cents from public.ff_memberships m join public.ff_invoices i on i.membership_id=m.id;
-- The administrator then changes Momentum and Essential.
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',jsonb_build_object('id','plus','name','Momentum Max','priceCents',159900,'days',28,'description','Edited by the tests.',
 'features',jsonb_build_array('Everything in Essential','Unlimited group classes','Weekly check-in'),'available',true,'coaching','personal','coachSessions',2,'focusTags',jsonb_build_array('group_classes')));
select public.ff_plan_admin('update',jsonb_build_object('id','basic','name','Essential','priceCents',89900,'days',30,'description','A solid foundation for your fitness routine.',
 'features',jsonb_build_array('Unlimited gym access','All strength equipment','Locker room access','Free towel'),'available',true,'coaching','none','coachSessions',0,'focusTags',jsonb_build_array('strength','cardio')));
reset role;
select pg_temp.ok((select features->0='"Everything in Momentum Max"'::jsonb from public.ff_plans where workspace='production' and id='elite'),'Renaming Momentum updated Performance''s "Everything in" line');
select pg_temp.ok((select count(*)=0 from pl_before b join public.ff_memberships m on m.id=b.id join public.ff_invoices i on i.membership_id=m.id
 where m.terms is distinct from b.terms or i.amount_cents<>b.amount_cents or i.paid_cents<>b.paid_cents),'Plan edits rewrite no cycle''s terms and no invoice');
select pg_temp.ok((select terms->>'name'='Momentum' and (terms->>'priceCents')::int=149900 and (terms->>'days')::int=30 and terms->>'coaching'='group' and terms->'features' ? 'Monthly fitness check-in'
 and terms->'included'->0->'features' ? 'Fitness orientation' from public.ff_memberships where id=(pg_temp.cycle('m1','plus')).id),'The partly paid cycle still shows Momentum as bought');
select pg_temp.cash('m1','plus');
reset role;
select pg_temp.ok((select paid_cents=amount_cents and amount_cents=149900 from public.ff_invoices where id=(pg_temp.invoice('m1','plus')).id),'and its balance is paid at the price it was bought for');
-- A new cycle uses the plan as it is now.
select pg_temp.as_user('m2');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('plan','plus','start',(select end_date+1 from public.ff_memberships where member_id=pg_temp.id('m2'))));
reset role;
select pg_temp.ok((select m.terms->>'name'='Momentum Max' and (m.terms->>'priceCents')::int=159900 and (m.terms->>'days')::int=28 and m.end_date=m.start_date+27 and i.amount_cents=159900
 and m.terms->>'coaching'='personal' and (m.terms->>'coachSessions')::int=2 and m.terms->'included'->0->'features' ? 'Free towel' and not m.terms->'included'->0->'features' ? 'Fitness orientation'
 from public.ff_memberships m join public.ff_invoices i on i.membership_id=m.id where m.id=(pg_temp.cycle('m2','plus')).id),'A new cycle takes the edited plan: name, price, length, coaching and what "Everything in Essential" means now');
select pg_temp.ok((select count(*)=2 and count(distinct terms->>'name')=2 from public.ff_memberships where member_id=pg_temp.id('m2')),'m2 now has a Momentum cycle and a Momentum Max one, each with its own terms');
-- Terms never change afterwards, whoever tries.
select pg_temp.fails_with($q$update public.ff_memberships set terms=terms||'{"name":"Changed"}' where id=(pg_temp.cycle('m1','plus')).id$q$,'Purchased terms can''t be changed.','The database owner cannot rewrite a cycle''s terms');
set local role service_role;
select pg_temp.fails_with($q$update public.ff_memberships set terms=terms||'{"priceCents":1}' where member_id=pg_temp.id('m3')$q$,'Purchased terms can''t be changed.','nor can the service key');
select pg_temp.fails_with($q$update public.ff_memberships set terms=null where member_id=pg_temp.id('m3')$q$,'Purchased terms can''t be changed.','nor clear them');
reset role;
select pg_temp.fails_with($q$insert into public.ff_memberships(workspace,member_id,plan_id,start_date,end_date,terms) values('production',pg_temp.id('m3'),'basic',current_date+200,current_date+229,'{"name":"x"}')$q$,'Purchased terms are incomplete.','Incomplete terms are refused');
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.ok((select count(*)=0 from public.ff_memberships where member_id in (pg_temp.id('m1'),pg_temp.id('m2'))),'A member cannot read other members'' terms');
reset role;
select pg_temp.as_user('m1');
set local role authenticated;
select pg_temp.ok((select count(*)=1 and bool_and(terms->>'name'='Momentum') from public.ff_memberships),'A member reads their own cycle''s terms');
reset role;

-- 5. Retiring a plan stops new cycles only. ------------------------------------------------------------------------
-- m4 has an unpaid cycle on zz-test; m6 an unpaid one made by a PayMongo renewal; reg a first registration awaiting cash.
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',pg_temp.plan('{"coaching":"group","coachSessions":0}'));
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('m4'),'plan','zz-test','start',current_setting('pl.today')));
select set_config('pl.registration',(public.ff_registration('create',jsonb_build_object('requestId',pg_temp.id('reg'),'name','LOCAL TEST Plans registration','email','pl-reg@example.invalid',
 'phone','09170000051','plan','zz-test','start',current_setting('pl.today')))->>'id'),true);
reset role;
select pg_temp.as_user('m6');
set local role authenticated;
select public.ff_paymongo_prepare(jsonb_build_object('kind','renewal','memberId',pg_temp.id('m6'),'plan','zz-test','start',current_setting('pl.today'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false));
reset role;
select pg_temp.ok((select terms->>'source'='registration' and terms->>'name'='LOCAL TEST Plan' and (terms->>'priceCents')::int=120000 from public.ff_registrations where id=current_setting('pl.registration')::uuid),
 'A first registration keeps the plan''s terms from when it was made');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',pg_temp.plan('{"priceCents":130000,"available":false,"coaching":"group","coachSessions":0}'));
reset role;
-- Nothing new on the retired plan, by any path.
select pg_temp.as_user('member');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_command('renew',jsonb_build_object('plan','zz-test','start',current_setting('pl.today')))$q$,'Select an available membership plan.','A member cannot renew onto a retired plan');
select pg_temp.fails_with($q$select public.ff_paymongo_prepare(jsonb_build_object('kind','renewal','memberId',auth.uid(),'plan','zz-test','start',current_setting('pl.today'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false))$q$,
 'Select an available membership plan.','nor start a new one online');
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_command('renew',jsonb_build_object('memberId',pg_temp.id('member'),'plan','zz-test','start',current_setting('pl.today')))$q$,'Select an available membership plan.','Staff cannot put a member on a retired plan');
select pg_temp.denied($q$select public.ff_walkin_renew(jsonb_build_object('memberId',pg_temp.id('member'),'plan','zz-test','start',current_setting('pl.today'),'amountCents',130000,'verified',true,'idempotencyKey',gen_random_uuid()))$q$,'nor take cash for a new cycle on it');
select pg_temp.fails_with($q$select public.ff_registration('create',jsonb_build_object('requestId',gen_random_uuid(),'name','LOCAL TEST Late','email','pl-late@example.invalid','phone','09170000052','plan','zz-test','start',current_setting('pl.today')))$q$,
 'Select an available plan.','nor register someone new on it');
reset role;
-- What already exists still works, on its own terms.
select pg_temp.as_user('m4');
set local role authenticated;
select pg_temp.ok((public.ff_paymongo_prepare(jsonb_build_object('kind','invoice','invoiceId',(pg_temp.invoice('m4','zz-test')).id,'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false))->'checkout'->>'amount_cents')::int=120000,
 'An unpaid invoice on a retired plan can still be paid online, at its own price');
reset role;
select pg_temp.as_user('m6');
set local role authenticated;
select pg_temp.ok((public.ff_paymongo_prepare(jsonb_build_object('kind','renewal','memberId',pg_temp.id('m6'),'plan','zz-test','start',current_setting('pl.today'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false))->'checkout'->>'amount_cents')::int=120000,
 'A renewal already created for a retired plan stays payable (new_membership is not asked again)');
reset role;
select pg_temp.ok((select count(*)=1 from public.ff_memberships where member_id=pg_temp.id('m6')),'and no second cycle is made');
-- m4's online checkout is still open, which blocks cash at the desk; close it the way an administrator's cancel would.
update public.ff_checkouts set status='expired' where invoice_id=(pg_temp.invoice('m4','zz-test')).id;
select pg_temp.cash('m4','zz-test');
reset role;
select pg_temp.ok((select paid_cents=amount_cents and amount_cents=120000 from public.ff_invoices where id=(pg_temp.invoice('m4','zz-test')).id),'Cash at the desk settles it at the price it was bought for');
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((public.ff_paymongo_prepare(jsonb_build_object('kind','registration','registrationId',current_setting('pl.registration'),'emailConfirmed',true,'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false))->'checkout'->>'amount_cents')::int=120000,
 'A first registration on a retired plan can still be paid online');
reset role;
update public.ff_checkouts set status='expired' where registration_id=current_setting('pl.registration')::uuid;
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_registration('cash',jsonb_build_object('id',current_setting('pl.registration'),'amountCents',120000,'method','Cash','verified',true,'emailConfirmed',true,'idempotencyKey',gen_random_uuid()));
reset role;
-- The account is created after payment (registration completion): the cycle takes the registration's terms.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('legacy'),'pl-reg@example.invalid',
 jsonb_build_object('ff_registration',current_setting('pl.registration'),'ff_workspace','production','ff_role','member'),'{"form_fitness":true}');
select pg_temp.ok((select m.terms=r.terms and m.terms->>'name'='LOCAL TEST Plan' and (m.terms->>'priceCents')::int=120000 and i.amount_cents=120000 and i.paid_cents=120000
 from public.ff_memberships m join public.ff_invoices i on i.membership_id=m.id join public.ff_registrations r on r.member_id=m.member_id where m.member_id=pg_temp.id('legacy')),
 'Registration completion copies the registration''s terms (not the plan''s new price) to the first cycle');
select pg_temp.ok((select count(*)=1 and bool_and(not available and price_cents=130000) from public.ff_plans where workspace='production' and id='zz-test'),'The retired plan is still there, as edited');

-- 6. Every way a cycle is created takes the terms then, and a repeated request reuses them. ----------------------------
-- Walk-in cash renewal, then a retry with the same key after a price change.
select pg_temp.as_user('staff');
set local role authenticated;
select set_config('pl.walk',jsonb_build_object('memberId',pg_temp.id('walk'),'plan','elite','start',current_setting('pl.today'),'amountCents',249900,'verified',true,'idempotencyKey',gen_random_uuid())::text,true);
select public.ff_walkin_renew(current_setting('pl.walk')::jsonb);
reset role;
select pg_temp.ok((select terms->>'source'='purchase' and terms->>'name'='Performance' and (terms->>'priceCents')::int=249900 from public.ff_memberships where member_id=pg_temp.id('walk')),'A walk-in cash renewal takes the plan''s terms');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',pg_temp.body('elite','{"priceCents":259900}'));
reset role;
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((public.ff_walkin_renew(current_setting('pl.walk')::jsonb)->>'alreadyProcessed')::boolean,'Retrying the walk-in after a price change returns the payment already made');
reset role;
select pg_temp.ok((select count(*)=1 and bool_and((terms->>'priceCents')::int=249900) from public.ff_memberships where member_id=pg_temp.id('walk')),'with no second cycle and the terms unchanged');
-- PayMongo renewal: the cycle is made at prepare; a retry (same request) and a new request for the same plan and start
-- reuse it, at its own price, even after the plan's price changes; settlement pays that amount.
select pg_temp.as_user('pm');
set local role authenticated;
select set_config('pl.pm',jsonb_build_object('kind','renewal','memberId',pg_temp.id('pm'),'plan','elite','start',current_setting('pl.today'),'requestId',gen_random_uuid(),'methods',jsonb_build_array('card'),'livemode',false)::text,true);
select set_config('pl.checkout',public.ff_paymongo_prepare(current_setting('pl.pm')::jsonb)->'checkout'->>'id',true);
select pg_temp.ok((public.ff_paymongo_prepare(current_setting('pl.pm')::jsonb)->'checkout'->>'id')=current_setting('pl.checkout'),'A retried PayMongo renewal returns the same checkout');
reset role;
select pg_temp.ok((select terms->>'source'='purchase' and (terms->>'priceCents')::int=259900 from public.ff_memberships where member_id=pg_temp.id('pm')),'A PayMongo renewal takes the plan''s terms when its cycle is made');
select pg_temp.as_user('admin');
set local role authenticated;
select public.ff_plan_admin('update',pg_temp.body('elite','{"priceCents":269900}'));
reset role;
update public.ff_checkouts set status='expired' where id=current_setting('pl.checkout')::uuid;
select pg_temp.as_user('pm');
set local role authenticated;
select set_config('pl.checkout',public.ff_paymongo_prepare(current_setting('pl.pm')::jsonb||jsonb_build_object('requestId',gen_random_uuid()))->'checkout'->>'id',true);
reset role;
select pg_temp.ok((select c.amount_cents=259900 and i.amount_cents=259900 from public.ff_checkouts c join public.ff_invoices i on i.id=c.invoice_id where c.id=current_setting('pl.checkout')::uuid)
 and (select count(*)=1 from public.ff_memberships where member_id=pg_temp.id('pm')),'A new request for the same renewal pays the existing cycle at its own price, not the new one');
set local role service_role;
select public.ff_paymongo_bind(jsonb_build_object('id',current_setting('pl.checkout'),'sessionId','cs_PlansDatabase','url','https://checkout.paymongo.com/cs_PlansDatabase'));
select public.ff_paymongo_settle(jsonb_build_object('id',current_setting('pl.checkout'),'sessionId','cs_PlansDatabase','reference',current_setting('pl.checkout'),'paymentId','pay_PlansDatabase','source','card',
 'amountCents',259900,'currency','PHP','status','paid','livemode',false));
reset role;
select pg_temp.ok((select i.paid_cents=259900 and m.terms->>'name'='Performance' and (m.terms->>'priceCents')::int=259900 from public.ff_invoices i join public.ff_memberships m on m.id=i.membership_id where m.member_id=pg_temp.id('pm')),
 'Settlement pays the cycle''s own price and leaves its terms as bought');
select pg_temp.ok((select count(*)=1 from public.ff_notifications n join public.ff_payments p on n.event_key='payment:'||p.id where p.member_id=pg_temp.id('pm')),'and queues the payment email, which reads those terms when it is sent');
-- The first registration retried with the same request returns the same row and terms.
select pg_temp.as_user('staff');
set local role authenticated;
select pg_temp.ok((public.ff_registration('create',jsonb_build_object('requestId',pg_temp.id('reg'),'name','LOCAL TEST Plans registration','email','pl-reg@example.invalid',
 'phone','09170000051','plan','zz-test','start',current_setting('pl.today')))->>'id')=current_setting('pl.registration'),'A retried first registration returns the one already made');
reset role;
select pg_temp.ok((select count(*)=1 and bool_and((terms->>'priceCents')::int=120000) from public.ff_registrations where request_id=pg_temp.id('reg')),'with its own terms');
-- A desk plan given at account creation (the older path through register_auth_user) also takes the terms then.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(pg_temp.id('m5'),'pl-m5@example.invalid','{"ff_workspace":"production","ff_role":"member"}',
 jsonb_build_object('form_fitness',true,'name','LOCAL TEST Plans m5','phone','09170000053','plan','basic','start',current_setting('pl.today')));
select pg_temp.ok((select terms->>'source'='purchase' and terms->'features' ? 'Free towel' from public.ff_memberships where member_id=pg_temp.id('m5')),'A plan given when the account is made takes the plan''s terms then');

-- 7. TRUNCATE can't empty the plans, or through CASCADE the history that references them. --------------------------
-- The fixtures above left cycles, invoices, payments, checkouts and registrations; every row of every table that
-- references plans, directly or not, must still be there after each refused TRUNCATE.
create temporary table pl_history as
 select 'plans' as t,count(*) as n from public.ff_plans union all select 'cycles',count(*) from public.ff_memberships
 union all select 'registrations',count(*) from public.ff_registrations union all select 'invoices',count(*) from public.ff_invoices
 union all select 'payments',count(*) from public.ff_payments union all select 'checkouts',count(*) from public.ff_checkouts
 union all select 'submissions',count(*) from public.ff_submissions union all select 'checkins',count(*) from public.ff_checkins
 union all select 'paymongo_attempts',count(*) from public.ff_paymongo_attempts;
grant select on pl_history to service_role;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
declare state text:='(no error)'; begin begin execute statement; exception when others then state:=sqlstate; end; return state; end $$;
select pg_temp.ok((select n>0 from pl_history where t='payments') and (select n>0 from pl_history where t='checkouts') and (select n>0 from pl_history where t='registrations'),'There is history to protect: payments, checkouts and registrations');
select pg_temp.ok(not has_table_privilege('service_role','public.ff_plans','truncate') and not has_table_privilege('authenticated','public.ff_plans','truncate') and not has_table_privilege('anon','public.ff_plans','truncate'),
 'No API role holds TRUNCATE on plans any more');
set local role service_role;
select pg_temp.ok(pg_temp.sqlstate_of('truncate public.ff_plans')='42501','The service key cannot TRUNCATE plans (permission denied)');
select pg_temp.ok(pg_temp.sqlstate_of('truncate public.ff_plans cascade')='42501','nor TRUNCATE ... CASCADE through them');
reset role;
select pg_temp.denied('truncate public.ff_plans','The database owner cannot TRUNCATE plans (their history references them)');
select pg_temp.fails_with('truncate public.ff_plans cascade','Plans can''t be deleted.','nor TRUNCATE ... CASCADE, which would empty every cycle, invoice, payment and check-in');
select pg_temp.fails_with('truncate public.ff_plans restart identity cascade','Plans can''t be deleted.','in any form');
select pg_temp.ok((select count(*)=0 from pl_history h where h.n<>(case h.t when 'plans' then (select count(*) from public.ff_plans) when 'cycles' then (select count(*) from public.ff_memberships)
  when 'registrations' then (select count(*) from public.ff_registrations) when 'invoices' then (select count(*) from public.ff_invoices) when 'payments' then (select count(*) from public.ff_payments)
  when 'checkouts' then (select count(*) from public.ff_checkouts) when 'submissions' then (select count(*) from public.ff_submissions) when 'checkins' then (select count(*) from public.ff_checkins)
  when 'paymongo_attempts' then (select count(*) from public.ff_paymongo_attempts) end)),'After every refused TRUNCATE, all plans and all dependent history are still there');
select pg_temp.ok((select tgtype&32<>0 and tgenabled='O' from pg_trigger where tgname='ff_plans_no_truncate' and tgrelid='public.ff_plans'::regclass),'A statement trigger refuses TRUNCATE on plans');

-- 8. Renaming a plan that others include keeps their "Everything in" line resolving; cycles already bought keep theirs.
-- Here Essential (basic) becomes "Essential Plus" and gains a benefit. Momentum (now "Momentum Max") includes it, and
-- Performance includes Momentum; m2's latest cycle is a Momentum purchase made before this rename.
create temporary table pl_snapshot as select id,terms from public.ff_memberships;
select pg_temp.as_user('admin');
set local role authenticated;
select set_config('pl.renamed',public.ff_plan_admin('update',pg_temp.body('basic',jsonb_build_object('name','Essential Plus',
 'features',(select features||'["Sauna access"]'::jsonb from public.ff_plans where workspace='production' and id='basic'))))::text,true);
reset role;
select pg_temp.ok((select jsonb_agg(u->>'id' order by u->>'id')='["plus","zz-test"]'::jsonb and bool_and(u->'features' ? 'Everything in Essential Plus')
 from jsonb_array_elements(current_setting('pl.renamed')::jsonb->'alsoUpdated') u),'Renaming Essential reports the plans whose line followed it: Momentum and the test plan that includes it');
select pg_temp.ok((select features ? 'Everything in Essential Plus' and not features ? 'Everything in Essential' from public.ff_plans where workspace='production' and id='plus'),
 'Momentum''s catalog line now names Essential Plus');
select pg_temp.ok((select features ? 'Everything in Momentum Max' from public.ff_plans where workspace='production' and id='elite'),'Performance''s line is untouched (Momentum wasn''t renamed now)');
select pg_temp.ok((select features ? 'Everything in Essential' from public.ff_plans where workspace='demo' and id='plus'),'The demo workspace''s plans are not touched');
select pg_temp.as_user('staff');
set local role authenticated;
select public.ff_command('renew',jsonb_build_object('memberId',k,'plan',p,'start',current_setting('pl.today'))) from (values (pg_temp.id('member'),'plus'),(pg_temp.id('other'),'elite')) as x(k,p);
reset role;
select pg_temp.ok((select terms->'included'=jsonb_build_array(jsonb_build_object('line','Everything in Essential Plus','plan','Essential Plus',
  'features','["Unlimited gym access","All strength equipment","Locker room access","Free towel","Sauna access"]'::jsonb)) and terms->'features' ? 'Everything in Essential Plus'
 from public.ff_memberships where member_id=pg_temp.id('member')),'A Momentum purchase after the rename includes Essential Plus''s benefits, the new one included');
select pg_temp.ok((select terms->'included'->0->>'line'='Everything in Momentum Max' and terms->'included'->0->'features' ? 'Sauna access' and terms->'included'->0->'features' ? 'Weekly check-in'
 from public.ff_memberships where member_id=pg_temp.id('other')),'A Performance purchase after it includes them too, through Momentum');
select pg_temp.ok((select count(*)=0 from pl_snapshot s join public.ff_memberships m using (id) where m.terms is distinct from s.terms),'Every cycle bought before the rename keeps its terms exactly');
select pg_temp.ok((select terms->'included'->0->>'plan'='Essential' and not terms->'included'->0->'features' ? 'Sauna access' and terms->'features' ? 'Everything in Essential'
 from public.ff_memberships where id=(select id from public.ff_memberships where member_id=pg_temp.id('m2') order by start_date desc limit 1)),'m2''s Momentum cycle still says "Everything in Essential", with the list as bought');
-- References must resolve: another plan's exact name, never the plan itself, and no plan ends up including itself.
select pg_temp.as_user('admin');
set local role authenticated;
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.body('plus','{"features":["Everything in Gold","Unlimited group classes"]}'))$q$,'"Everything in Gold" names no other plan.','A line naming no plan is refused');
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.body('plus','{"features":["Everything in Essential","Unlimited group classes"]}'))$q$,'"Everything in Essential" names no other plan.','A line naming a plan''s old name is refused');
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.body('basic','{"features":["Everything in Essential Plus"]}'))$q$,'A plan can''t include itself.','A plan can''t include itself');
select pg_temp.fails_with($q$select public.ff_plan_admin('update',pg_temp.body('basic','{"features":["Everything in Performance"]}'))$q$,'Performance already includes Essential Plus, so Essential Plus can''t include Performance.','nor a plan that already includes it, through another plan');
select public.ff_plan_admin('create',pg_temp.plan('{"id":"zz-loop","name":"LOCAL TEST Loop","features":["everything in local test plan"]}'));
reset role;
select pg_temp.ok((select ff_private.plan_terms(p,'purchase')->'included'->0->>'plan'='LOCAL TEST Plan' from public.ff_plans p where workspace='production' and id='zz-loop'),
 'A plan may name another in any letter case, and new purchases resolve it');

-- 9. Grants: administrators use public.ff_plan_admin; the helpers are nobody's. ---------------------------------------
select pg_temp.ok(not has_function_privilege('anon','public.ff_plan_admin(text,jsonb)','execute') and has_function_privilege('authenticated','public.ff_plan_admin(text,jsonb)','execute'),'Only signed-in accounts may call plan management (and it checks for an administrator)');
select pg_temp.ok(not has_function_privilege('anon','ff_private.plan_admin(text,jsonb)','execute'),'Signed-out callers cannot reach the private function');
select pg_temp.ok((select not bool_or(has_function_privilege('authenticated',f,'execute')) and not bool_or(has_function_privilege('anon',f,'execute')) from unnest(array['ff_private.focus_tags(text[])','ff_private.plan_features_ok(jsonb)',
 'ff_private.plan_features_flat(text,jsonb,text[])','ff_private.plan_included(text,jsonb,text)','ff_private.plan_reaches(text,text,text)','ff_private.plan_terms(public.ff_plans,text)','ff_private.terms_ok(jsonb)','ff_private.purchased_terms()','ff_private.plan_guard()']) f),'The term and plan helpers are internal');
select pg_temp.ok(not has_table_privilege('authenticated','public.ff_plans','insert') and not has_table_privilege('authenticated','public.ff_plans','update') and not has_table_privilege('authenticated','public.ff_plans','delete')
 and not has_table_privilege('authenticated','public.ff_memberships','update'),'Signed-in accounts can only read plans and cycles');
select pg_temp.ok((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='ff_private.plan_admin(text,jsonb)'::regprocedure)
 and (select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.ff_plan_admin(text,jsonb)'::regprocedure),'plan_admin is a definer with a fixed, empty search path; its wrapper runs as the caller');
select count(*) as passed_checks from pl_log;
rollback;
