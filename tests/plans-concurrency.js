import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
// Task 12A: two administrators changing one workspace's plans at the same moment, in two real database sessions.
// ff_private.plan_admin takes a workspace lock before it reads or checks anything, so the second change waits for the
// first to commit, then is checked against the plans as committed: no loop of "Everything in" lines and no line that
// names no plan, whatever the timing. Another workspace never waits, and purchased terms never change.
// Local fixtures only (administrators, a member and their plans), all removed afterwards. Plans can't be deleted through
// the app, so a local superuser transaction removes the test plans with the plan table's row guard off inside itself.
const args=['exec','-i','supabase_db_RepReady','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-At'];
const env={...process.env,MSYS_NO_PATHCONV:'1'};
const psql=sql=>{const r=spawnSync('docker',args,{input:sql,encoding:'utf8',env});if(r.status)throw Error(r.stderr);return r.stdout.trim();};
const session=sql=>new Promise(resolve=>{const p=spawn('docker',args,{env});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>resolve({code,out:out.trim(),err:err.trim()}));p.stdin.end(sql);});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const passed=[],pass=label=>{passed.push(label);console.log('PASS: '+label);};
const tag=randomBytes(3).toString('hex');
const people={a:'admin',b:'admin',demo:'admin',buyer:'member'},id={},sid={};
for(const k of Object.keys(people)){id[k]=randomUUID();sid[k]=randomUUID();}
const as=k=>`select set_config('request.jwt.claims','${JSON.stringify({sub:id[k],role:'authenticated',session_id:sid[k]})}',true);\nset local role authenticated;`;
const json=v=>`'${JSON.stringify(v).replace(/'/g,"''")}'::jsonb`;
const plan=(planId,name,features)=>({id:planId,name,priceCents:100000,days:30,description:'Concurrency test plan.',features,available:true,coaching:'none',coachSessions:0,focusTags:[]});
// One plan_admin call, reported as a NOTICE with the database clock: SAVED, or REFUSED with the reason.
const attempt=(label,action,body)=>`do $$ begin perform public.ff_plan_admin('${action}',${json(body)}); raise notice '${label}|SAVED|%',to_char(clock_timestamp(),'HH24:MI:SS.US');
exception when others then raise notice '${label}|REFUSED|%|%',to_char(clock_timestamp(),'HH24:MI:SS.US'),sqlerrm; end $$;`;
const outcome=(r,label)=>{const line=r.err.split('\n').find(l=>l.includes(label+'|'));assert(line,`${label}: no outcome in ${r.err}`);const [,state,at,reason='']=line.replace(/^NOTICE:\s+/,'').split('|');return {state,at,reason};};
const advisoryWaits=()=>Number(psql(`select count(*) from pg_stat_activity where state='active' and wait_event_type='Lock' and wait_event='advisory' and query like '%ff_plan_admin%' and pid<>pg_backend_pid();`));
// The first session saves its change and holds its transaction for 4 seconds; the second starts 1.5 seconds later.
async function race(first,second,{firstUser='a',secondUser='b'}={}){
 const one=session(`begin;\n${as(firstUser)}\n${first}\nselect pg_sleep(4);\nselect 'COMMIT|'||to_char(clock_timestamp(),'HH24:MI:SS.US');\ncommit;`);
 await wait(1500);const two=session(`begin;\n${as(secondUser)}\n${second}\ncommit;`);
 await wait(1500);const waiting=advisoryWaits();
 const [r1,r2]=await Promise.all([one,two]);assert.equal(r1.code,0,r1.err);assert.equal(r2.code,0,r2.err);
 return {first:outcome(r1,'FIRST'),second:outcome(r2,'SECOND'),committed:r1.out.split('\n').find(l=>l.startsWith('COMMIT|')).slice(7),waiting};
}
const P=(n,s)=>`zz-race-${tag}-${n}${s}`,N=(n,s)=>`ZZ ${n} ${tag}-${s}`;
const unresolved=w=>psql(`select count(*) from public.ff_plans x cross join lateral jsonb_array_elements_text(x.features) as f(line)
 where x.workspace='${w}' and x.id like 'zz-race-${tag}-%' and f.line ~* '^everything in .'
 and not exists(select 1 from public.ff_plans r where r.workspace=x.workspace and r.id<>x.id and lower(r.name)=lower(btrim(substr(f.line,15))));`);
const features=planId=>JSON.parse(psql(`select features from public.ff_plans where id='${planId}';`));
const allTerms=()=>psql(`select md5(coalesce(json_agg(terms order by id),'[]')::text) from (select id,terms from public.ff_memberships union all select id,terms from public.ff_registrations) x;`);
try{
 psql(Object.entries(people).map(([k,role])=>`insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('${id[k]}','race-${k}-${tag}@example.invalid',
 '${JSON.stringify({ff_workspace:k==='demo'?'demo':'production',ff_role:role})}','${JSON.stringify({form_fitness:true,name:'LOCAL TEST Race '+k,phone:'09170000090'})}');`).join('\n')
  +`\ninsert into auth.sessions(id,user_id) values ${Object.keys(people).map(k=>`('${sid[k]}','${id[k]}')`).join(',')};`);
 // The plans each race starts from: for 1, two unrelated plans; for 2 to 4, a base plan (Essential's place) and a plan
 // that includes it (Momentum's place); for 5, a plan in each workspace. The member buys the plan that includes the base.
 const start=[plan(P('x',1),N('X',1),['X floor']),plan(P('y',1),N('Y',1),['Y floor'])];
 for(const s of [2,3,4])start.push(plan(P('base',s),N('Essential',s),['Gym access','Lockers']),plan(P('incl',s),N('Momentum',s),[`Everything in ${N('Essential',s)}`,'Classes']),plan(P('other',s),N('Other',s),['Other floor']));
 start.push(plan(P('prod',5),N('Production',5),['Production floor']));
 psql(`begin;\n${as('a')}\n${start.map(p=>`select public.ff_plan_admin('create',${json(p)}) is not null;`).join('\n')}\ncommit;
begin;\n${as('demo')}\nselect public.ff_plan_admin('create',${json(plan(P('demo',5),N('Demo',5),['Demo floor']))}) is not null;\ncommit;
begin;\n${as('a')}\nselect public.ff_command('renew',${json({memberId:id.buyer,plan:P('incl',2),start:psql('select ff_private.today();')})}) is not null;\ncommit;`);
 const bought=psql(`select terms::text from public.ff_memberships where member_id='${id.buyer}';`),termsBefore=allTerms();

 // 1. Plan X includes Y while plan Y includes X.
 let r=await race(attempt('FIRST','update',plan(P('x',1),N('X',1),['X floor',`Everything in ${N('Y',1)}`])),attempt('SECOND','update',plan(P('y',1),N('Y',1),['Y floor',`Everything in ${N('X',1)}`])));
 assert.equal(r.first.state,'SAVED');assert(r.waiting>=1,'the second change waited on the workspace lock');
 assert.equal(r.second.state,'REFUSED');assert(r.second.at>r.committed,'and was checked only after the first committed');
 assert.equal(r.second.reason,`${N('X',1)} already includes ${N('Y',1)}, so ${N('Y',1)} can't include ${N('X',1)}.`);
 assert.equal(psql(`select ff_private.plan_reaches('production','${P('x',1)}','${P('y',1)}') and ff_private.plan_reaches('production','${P('y',1)}','${P('x',1)}');`),'f','no loop');
 assert.deepEqual(features(P('y',1)),['Y floor'],'Y is unchanged');
 pass('X includes Y while Y includes X at the same moment: the second waits, then is refused against the committed plans; no loop is created');

 // 2. The base plan is renamed while a new plan says "Everything in <old name>".
 r=await race(attempt('FIRST','update',plan(P('base',2),N('Essential Plus',2),['Gym access','Lockers'])),attempt('SECOND','create',plan(P('new',2),N('New',2),[`Everything in ${N('Essential',2)}`])));
 assert.equal(r.first.state,'SAVED');assert(r.waiting>=1);assert.equal(r.second.state,'REFUSED');assert(r.second.at>r.committed);
 assert.equal(r.second.reason,`"Everything in ${N('Essential',2)}" names no other plan. After "Everything in", use another plan's exact name.`);
 assert.equal(psql(`select count(*) from public.ff_plans where id='${P('new',2)}';`),'0','the new plan was not created');
 assert.deepEqual(features(P('incl',2)),[`Everything in ${N('Essential Plus',2)}`,'Classes'],'the plan that included it follows the rename');
 assert.equal(unresolved('production'),'0');
 pass('A plan is renamed while another administrator creates one saying "Everything in <old name>": the create waits, then is refused against the committed name; no line names no plan');

 // 3. The base plan is renamed while another plan is edited to say "Everything in <old name>".
 r=await race(attempt('FIRST','update',plan(P('base',3),N('Essential Plus',3),['Gym access','Lockers'])),attempt('SECOND','update',plan(P('other',3),N('Other',3),['Other floor',`Everything in ${N('Essential',3)}`])));
 assert.equal(r.first.state,'SAVED');assert(r.waiting>=1);assert.equal(r.second.state,'REFUSED');assert(r.second.at>r.committed);
 assert.match(r.second.reason,/names no other plan/);assert.deepEqual(features(P('other',3)),['Other floor'],'the edited plan is unchanged');
 assert.equal(unresolved('production'),'0');
 pass('A plan is renamed while another administrator edits a plan to say "Everything in <old name>": the edit waits, then is refused; no line names no plan');

 // 4. The other order: the edit saves first, and the rename waits, then also renames the edit's committed line.
 r=await race(attempt('FIRST','update',plan(P('other',4),N('Other',4),['Other floor',`Everything in ${N('Essential',4)}`])),attempt('SECOND','update',plan(P('base',4),N('Essential Plus',4),['Gym access','Lockers'])));
 assert.equal(r.first.state,'SAVED');assert(r.waiting>=1);assert.equal(r.second.state,'SAVED');assert(r.second.at>r.committed);
 assert.deepEqual(features(P('other',4)),['Other floor',`Everything in ${N('Essential Plus',4)}`],'the line saved first follows the rename');
 assert.deepEqual(features(P('incl',4)),[`Everything in ${N('Essential Plus',4)}`,'Classes']);assert.equal(unresolved('production'),'0');
 pass('The other order: an edit saying "Everything in <name>" commits first, the rename waits, then renames that committed line too');

 // 5. Another workspace doesn't wait: production holds its lock; a demo administrator's change saves at once.
 r=await race(attempt('FIRST','update',plan(P('prod',5),N('Production',5),['Production floor','Production extra'])),attempt('SECOND','update',plan(P('demo',5),N('Demo',5),['Demo floor','Demo extra'])),{secondUser:'demo'});
 assert.equal(r.first.state,'SAVED');assert.equal(r.second.state,'SAVED');assert(r.second.at<r.committed,'the demo change saved while production still held its lock');
 assert.equal(r.waiting,0,'and never waited');
 pass('Workspaces stay independent: a demo change saves at once while a production change holds the production lock');

 // 6. None of it changed a purchased snapshot.
 assert.equal(psql(`select terms::text from public.ff_memberships where member_id='${id.buyer}';`),bought,'the member\'s terms, bought before the rename, are unchanged');
 assert.equal(allTerms(),termsBefore,'and so is every stored terms value');
 pass('Purchased terms are unchanged: the member who bought before the renames, and every stored cycle and registration');
 console.log(`PASS: ${passed.length} concurrency checks`);
}finally{
 psql(`delete from public.ff_notifications where member_id='${id.buyer}';\ndelete from public.ff_invoices where member_id='${id.buyer}';\ndelete from public.ff_memberships where member_id='${id.buyer}';
begin;\nalter table public.ff_plans disable trigger ff_plans_guard;\ndelete from public.ff_plans where id like 'zz-race-${tag}-%';\nalter table public.ff_plans enable trigger ff_plans_guard;\ncommit;
delete from public.ff_profiles where id in (${Object.values(id).map(v=>`'${v}'`).join(',')});\ndelete from auth.users where id in (${Object.values(id).map(v=>`'${v}'`).join(',')});`);
 assert.equal(psql(`select count(*) from public.ff_plans where id like 'zz-race-${tag}-%';`),'0','the test plans are gone');
}
