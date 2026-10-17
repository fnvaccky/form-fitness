import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handle} from '../src/api.js';

const OWNER='11111111-2222-4333-8444-555555555555', OTHER='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TABLES=['ff_checkins','ff_attendance_schedules','ff_invoices','ff_payments'];
const scope=(row,member_id=OWNER,workspace='production')=>({...row,member_id,workspace});
const columns={ff_checkins:'id,created_at',ff_attendance_schedules:'id,effective_from,available_days',
  ff_invoices:'id,amount_cents,paid_cents,membership:ff_memberships(start_date,end_date)',ff_payments:'id,invoice_id,amount_cents,created_at'};

// The real API runs on loopback; all Auth and PostgREST requests terminate at a second local mock.
async function fixture(role='member') {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),expires=Math.floor(Date.now()/1000)+3600;
  const user={id:OWNER,aud:'authenticated',role:'authenticated',email:'local-attendance@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-10-01T00:00:00Z'};
  const state={requests:[],profile:{id:OWNER,workspace:'production',role,name:'LOCAL TEST Attendance',email:user.email,enabled:true},
    rows:{ff_checkins:[scope({id:'own-event',created_at:'2026-10-12T16:15:00Z'}),scope({id:'OTHER-MEMBER-EVENT',created_at:'2026-10-12T16:15:00Z'},OTHER),scope({id:'OTHER-WORKSPACE-EVENT',created_at:'2026-10-12T16:15:00Z'},OWNER,'demo')],
      ff_attendance_schedules:[scope({id:'own-schedule',effective_from:'2026-10-12',available_days:['tue','thu']}),scope({id:'OTHER-SCHEDULE',effective_from:'2026-10-01',available_days:['mon']},OTHER)],
      ff_invoices:[scope({id:'own-invoice',amount_cents:89900,paid_cents:89900,membership:{start_date:'2026-10-01',end_date:'2026-10-30'}}),scope({id:'OTHER-INVOICE',amount_cents:89900,paid_cents:89900,membership:{start_date:'2026-10-01',end_date:'2026-10-30'}},OTHER)],
      ff_payments:[scope({id:'own-payment',invoice_id:'own-invoice',amount_cents:89900,created_at:'2026-10-01T00:00:00Z'}),scope({id:'OTHER-PAYMENT',invoice_id:'OTHER-INVOICE',amount_cents:89900,created_at:'2026-10-01T00:00:00Z'},OTHER)]}};
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:OWNER,aud:'authenticated',exp:expires,session_id:'66666666-7777-4888-9999-000000000000'})}.fixture-signature`,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fixture-refresh',user};
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:url.pathname,method:req.method,query:url.searchParams,body});
    res.setHeader('Content-Type','application/json');const send=value=>res.end(JSON.stringify(value));
    if(url.pathname==='/auth/v1/token')return send(session);
    if(url.pathname==='/auth/v1/user')return send(user);
    if(url.pathname==='/rest/v1/ff_profiles')return send(state.profile?[state.profile]:[]);
    const table=url.pathname.replace('/rest/v1/','');
    if(TABLES.includes(table)) {
      if(state.failTable===table){res.statusCode=503;return send({code:'08006',message:'Fixture read unavailable'});}
      let rows=state.rows[table].filter(row=>`eq.${row.member_id}`===url.searchParams.get('member_id')&&`eq.${row.workspace}`===url.searchParams.get('workspace'));
      if(table==='ff_checkins')rows=rows.filter(row=>{
        const lower=url.searchParams.get('created_at')?.replace('gte.','');
        const upper=url.searchParams.getAll('created_at').find(value=>value.startsWith('lt.'))?.slice(3);
        return (!lower||Date.parse(row.created_at)>=Date.parse(lower))&&(!upper||Date.parse(row.created_at)<Date.parse(upper));
      });
      if(table==='ff_attendance_schedules')rows=rows.filter(row=>row.effective_from<=url.searchParams.get('effective_from')?.replace('lte.',''));
      const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||1000);
      return send(rows.slice(offset,offset+limit));
    }
    res.statusCode=404;return send({error:'Unexpected fixture request'});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  let origin='';const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-fixture',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${api.address().port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'fixture-only'})});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');state.requests=[];
  return {state,get:(path,options={})=>fetch(origin+'/api'+path,{headers:options.signedOut?{}:{Cookie:cookie}}),
    close:()=>Promise.all([new Promise(resolve=>api.close(resolve)),new Promise(resolve=>mock.close(resolve))])};
}
const reads=f=>f.state.requests.filter(request=>TABLES.some(table=>request.path==='/rest/v1/'+table));
const assertReadOnly=f=>{
  assert.equal(f.state.requests.some(request=>request.path.includes('health')),false,'attendance does not read private health');
  assert.ok(f.state.requests.every(request=>request.method==='GET'),'attendance makes no writes or RPC calls');
};

test('member attendance reads its authenticated owner and workspace only, without names or health',async()=>{
  const f=await fixture();
  try {
    const response=await f.get('/member-attendance?period=week&date=2026-10-17');assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');const body=await response.json();
    assert.deepEqual([body.from,body.to,body.timeZone,body.trackingStart],['2026-10-12','2026-10-18','Asia/Manila','2026-10-12']);
    assert.deepEqual(body.summary,{attendedDays:1,events:1,completedPlanned:2,completedAttended:1,percentage:50,label:'Building consistency'});
    assert.deepEqual(body.history,[{id:'own-event',at:'2026-10-12T16:15:00Z',date:'2026-10-13'}]);
    assert.doesNotMatch(JSON.stringify(body),/OTHER-|LOCAL TEST|member_id|workspace|height|weight|conditions|health|email/);
    assert.equal(reads(f).length,4);
    for(const request of reads(f)) {
      const table=request.path.replace('/rest/v1/','');
      assert.equal(request.query.get('member_id'),`eq.${OWNER}`);assert.equal(request.query.get('workspace'),'eq.production');
      assert.equal(request.query.get('select'),columns[table]);assert.equal(request.query.get('order'),'id.asc');
    }
    const checkin=reads(f).find(request=>request.path.endsWith('/ff_checkins'));
    assert.deepEqual(checkin.query.getAll('created_at'),['gte.2026-10-12T00:00:00+08:00','lt.2026-10-19T00:00:00+08:00']);
    const month=await f.get('/member-attendance?period=month&date=2026-10-17');assert.equal(month.status,200);
    const monthly=await month.json();assert.deepEqual([monthly.from,monthly.to],['2026-10-01','2026-10-31']);assertReadOnly(f);
  } finally {await f.close();}
});

test('the Vercel rewritten API route accepts routing metadata while preserving owner scope',async()=>{
  const f=await fixture();
  try {
    const response=await f.get('?__path=member-attendance&path=member-attendance&period=week&date=2026-10-17');
    assert.equal(response.status,200);const body=await response.json();assert.equal(body.summary.attendedDays,1);
    for(const request of reads(f))assert.deepEqual([request.query.get('member_id'),request.query.get('workspace')],[`eq.${OWNER}`,'eq.production']);
    assert.equal((await f.get(`?__path=member-attendance&period=week&date=2026-10-17&memberId=${OTHER}`)).status,400);
    assertReadOnly(f);
  } finally {await f.close();}
});

test('staff, admins and disabled members are refused before any attendance data query',async()=>{
  for(const role of ['staff','admin','member']) {
    const f=await fixture(role);
    try {
      if(role==='member')f.state.profile.enabled=false;
      assert.equal((await f.get('/member-attendance?period=week&date=2026-10-17')).status,403,role);
      assert.equal(reads(f).length,0);assertReadOnly(f);
    } finally {await f.close();}
  }
});

test('anonymous or unauthorized workspace sessions cannot read attendance',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.get('/member-attendance',{signedOut:true})).status,401);
    f.state.profile.workspace='demo';assert.equal((await f.get('/member-attendance')).status,401);
    assert.equal(reads(f).length,0);assertReadOnly(f);
  } finally {await f.close();}
});

test('bad periods, impossible/future dates and identity spoofing fail before reading data',async()=>{
  const f=await fixture();
  try {
    for(const query of ['period=year','date=2026-02-30','date=9999-12-31','date=2026-1-1',`memberId=${OTHER}`,'workspace=demo','period=week&mode=admin']) {
      const response=await f.get('/member-attendance?'+query);assert.equal(response.status,400,query);
      assert.doesNotMatch(JSON.stringify(await response.json()),/aaaaaaaa|bbbb|eeee/);
    }
    assert.equal(reads(f).length,0);assertReadOnly(f);
  } finally {await f.close();}
});

test('owner attendance paginates beyond 1000 events and counts one attended business day',async()=>{
  const f=await fixture();
  try {
    f.state.rows.ff_checkins=Array.from({length:1001},(_,index)=>scope({id:`own-${String(index).padStart(4,'0')}`,created_at:'2026-10-12T16:15:00Z'}));
    const response=await f.get('/member-attendance?period=week&date=2026-10-17');assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.summary.events,1001);assert.equal(body.summary.attendedDays,1);
    assert.equal(body.summary.completedAttended,1);assert.equal(body.history.length,1001);
    const pages=reads(f).filter(request=>request.path.endsWith('/ff_checkins'));
    assert.deepEqual(pages.map(request=>Number(request.query.get('offset'))),[0,1000]);assert.ok(pages.every(request=>request.query.get('limit')==='1000'));
    assertReadOnly(f);
  } finally {await f.close();}
});

test('read failures return an error rather than invented successful attendance',async()=>{
  const f=await fixture();
  try {
    f.state.failTable='ff_attendance_schedules';const response=await f.get('/member-attendance?period=week&date=2026-10-17');
    assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'The database request could not be completed.'});assertReadOnly(f);
  } finally {await f.close();}
});
