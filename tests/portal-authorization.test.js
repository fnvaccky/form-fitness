import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handle} from '../src/api.js';
import {today} from '../src/validation.js';

// Real API/session authorization, with every Supabase request confined to a loopback mock.
// Mock RPC success checks API routing; it does not claim to execute PostgreSQL/RLS.
async function fixture(role) {
  const id='11111111-2222-4333-8444-555555555555', encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires=Math.floor(Date.now()/1000)+3600;
  // User-editable metadata deliberately claims admin: only the stored profile is authoritative.
  const user={id,aud:'authenticated',role:'authenticated',email:'local-portal@example.invalid',app_metadata:{},user_metadata:{role:'admin',ff_role:'admin'},created_at:'2026-10-01T00:00:00Z'};
  const state={requests:[],profile:{id,workspace:'production',role,name:'LOCAL TEST Portal',email:user.email,phone:'09170000001',enabled:true,goal:'Improve fitness',photo:'',created_at:user.created_at}};
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,aud:'authenticated',exp:expires,session_id:'66666666-7777-4888-9999-000000000000'})}.test-signature`,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh',user};
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:url.pathname,method:req.method,query:url.searchParams,body});
    res.setHeader('Content-Type','application/json');
    const send=value=>res.end(JSON.stringify(value));
    if(url.pathname==='/auth/v1/token')return send(session);
    if(url.pathname==='/auth/v1/user')return send(user);
    if(url.pathname==='/rest/v1/ff_profiles')return send([state.profile]);
    if(url.pathname==='/rest/v1/ff_settings')return send({payments:{}});
    if(url.pathname==='/rest/v1/rpc/ff_plan_admin')return send({id:'basic',name:'Basic',price_cents:10000,days:30,features:[],available:true,coaching:'none',coach_sessions:0,focus_tags:[]});
    if(url.pathname==='/rest/v1/rpc/ff_staff_admin')return send({...state.profile,id:'22222222-3333-4444-8555-666666666666',role:'staff'});
    if(url.pathname==='/rest/v1/rpc/ff_command')return send({ok:true,invoiceId:'existing-invoice'});
    if(url.pathname.startsWith('/rest/v1/'))return send([]);
    res.statusCode=404;return send({});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-fixture',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${api.address().port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'fixture-only'})});
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return {state,
    get:path=>fetch(origin+'/api'+path,{headers:{Cookie:cookie}}),
    post:(path,body={})=>fetch(origin+'/api'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}),
    close:()=>Promise.all([new Promise(resolve=>api.close(resolve)),new Promise(resolve=>mock.close(resolve))])};
}
const rpcs=state=>state.requests.filter(request=>request.path.startsWith('/rest/v1/rpc/'));
const forged={mode:'admin',role:'admin',can:{manageStaff:true,plans:true,recordOnlinePayment:true},user:{role:'admin'}};

test('session role and capabilities come from the authenticated profile, ignoring preview and metadata claims',async()=>{
  for(const role of ['admin','staff','member']) {
    const f=await fixture(role);
    try {
      const response=await f.get('/session?mode=admin&role=admin');assert.equal(response.status,200);
      const {user}=await response.json();assert.equal(user.role,role);
      assert.equal(user.can.manageStaff,role==='admin'?true:undefined);
      assert.equal(user.can.recordCashPayment,role==='member'?undefined:true);
      assert.ok(f.state.requests.filter(r=>r.path==='/rest/v1/ff_profiles').every(r=>r.query.get('id')===`eq.${f.state.profile.id}`));
    } finally {await f.close();}
  }
});

test('staff and members cannot invoke administrator operations through forged view or role input',async()=>{
  const paths=['/review-payment','/settings/payments','/settings/email','/plans','/manage-member','/email-retry','/staff','/staff/update','/staff/enable','/staff/resend','/members/delete-unpaid','/paymongo/recover','/paymongo/cancel'];
  for(const role of ['staff','member']) {
    const f=await fixture(role);
    try {
      for(const path of paths) {
        const response=await f.post(path,forged);assert.equal(response.status,403,`${role} ${path}`);
        assert.match((await response.json()).error,/Administrator access/);
      }
      assert.equal((await f.get('/staff?mode=admin')).status,403);
      assert.equal(rpcs(f.state).length,0,'all privileged requests refused before an RPC');
    } finally {await f.close();}
  }
});

test('members cannot use staff cash, registration or attendance routes by claiming a staff view',async()=>{
  const f=await fixture('member');
  try {
    for(const path of ['/members','/registration-payment','/registration-fulfill','/walkin-renew','/payments','/scan','/check-in']) {
      const response=await f.post(path,{...forged,mode:'admin',role:'staff'});
      assert.equal(response.status,403,path);assert.match((await response.json()).error,/Gym staff access/);
    }
    assert.equal((await f.get('/reports/attendance?from=2026-10-01&to=2026-10-01&mode=admin')).status,403);
    assert.equal(rpcs(f.state).length,0);
    assert.equal(f.state.requests.some(r=>r.path==='/rest/v1/ff_checkins'),false);
  } finally {await f.close();}
});

test('staff retain operational state, cash, scan, check-in, renewal and attendance regardless of displayed mode',async()=>{
  const f=await fixture('staff');
  try {
    const response=await f.get('/state?mode=member');assert.equal(response.status,200);
    const state=await response.json();assert.equal(state.user.role,'staff');assert.equal(state.user.can.roster,true);assert.equal(state.user.can.recordCashPayment,true);
    assert.equal(Object.hasOwn(state,'staff'),false);assert.equal(Object.hasOwn(state,'unpaidAccounts'),false);
    const operations=[['/payments',{invoiceId:'existing-invoice',amount:'100',method:'Cash',verified:true}],['/scan',{token:'isolated-pass'}],['/check-in',{token:'isolated-pass'}],['/renew',{memberId:'existing-member',plan:'basic',start:today()}]];
    for(const [path,body] of operations)assert.equal((await f.post(path,{...body,mode:'member'})).status,200,path);
    assert.deepEqual(rpcs(f.state).filter(r=>r.path==='/rest/v1/rpc/ff_command').map(r=>r.body.action),['payments','scan','check-in','renew']);
    const attendance=await f.get('/reports/attendance?from=2026-10-01&to=2026-10-01&mode=member');assert.equal(attendance.status,200);
    assert.deepEqual((await attendance.json()).totals,{visits:0,uniqueMembers:0,days:1,dailyAverage:0});
  } finally {await f.close();}
});

test('administrators retain plan and staff operations while displaying member preview',async()=>{
  const f=await fixture('admin');
  try {
    assert.equal((await f.post('/plans',{action:'update',id:'basic',name:'Basic',price:'100',days:30,description:'',features:[],available:true,coaching:'none',coachSessions:0,focusTags:[],mode:'member'})).status,200);
    assert.equal((await f.post('/staff/enable',{id:'22222222-3333-4444-8555-666666666666',enabled:true,mode:'member'})).status,200);
    assert.deepEqual(rpcs(f.state).map(r=>r.path),['/rest/v1/rpc/ff_plan_admin','/rest/v1/rpc/ff_staff_admin']);
  } finally {await f.close();}
});

test('a stale administrator client cannot retain access after its stored account role changes',async()=>{
  const f=await fixture('admin');
  try {
    assert.equal((await (await f.get('/session')).json()).user.role,'admin');
    f.state.profile.role='staff';
    assert.equal((await f.post('/staff/enable',{...forged,id:'22222222-3333-4444-8555-666666666666',enabled:true})).status,403);
    assert.equal((await f.post('/plans',{...forged,action:'update'})).status,403);
    assert.equal((await (await f.get('/session')).json()).user.role,'staff');
    assert.equal(rpcs(f.state).length,0);
  } finally {await f.close();}
});
