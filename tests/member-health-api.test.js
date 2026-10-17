import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handle} from '../src/api.js';
import {healthView} from '../src/member-health.js';

const blank = {heightCm:null,weightKg:null,ageBand:null,conditions:[]};
const filled = {heightCm:170.5,weightKg:65.2,ageBand:'20plus',conditions:['diabetes','asthma']};

// Two ephemeral loopback servers exercise the real API/session/state code; all auth/data is simulated.
async function fixture(role='member') {
  const id='11111111-2222-4333-8444-555555555555', encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires=Math.floor(Date.now()/1000)+3600;
  const user={id,aud:'authenticated',role:'authenticated',email:'local-health@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-10-01T00:00:00Z'};
  const state={requests:[],health:null,profile:{id,workspace:'production',role,name:'LOCAL TEST Health',email:user.email,phone:'09170000001',enabled:true,goal:'Improve fitness',photo:'',created_at:user.created_at}};
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,aud:'authenticated',exp:expires,session_id:'66666666-7777-4888-9999-000000000000'})}.test-signature`,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fake-refresh',user};
  const mock=http.createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:url.pathname,method:req.method,query:url.searchParams,body});
    res.setHeader('Content-Type','application/json');
    const send=value=>res.end(JSON.stringify(value));
    if(url.pathname==='/auth/v1/token') return send(session);
    if(url.pathname==='/auth/v1/user') return send(user);
    if(url.pathname==='/rest/v1/ff_profiles') return send([state.profile]);
    if(url.pathname==='/rest/v1/ff_settings') return send({payments:{}});
    if(url.pathname==='/rest/v1/ff_member_health') return send(state.health?[state.health]:[]);
    if(url.pathname==='/rest/v1/rpc/ff_save_member_health') {
      if(state.rpcError) {res.statusCode=403;return send(state.rpcError);}
      state.health={id,workspace:'production',height_cm:body.body.heightCm,weight_kg:body.body.weightKg,age_band:body.body.ageBand,conditions:body.body.conditions,updated_at:'2026-10-17T06:20:00Z'};
      return send(state.health);
    }
    if(url.pathname.startsWith('/rest/v1/')) return send([]);
    res.statusCode=404;return send({});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-fixture',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${api.address().port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'fixture-only'})});
  assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return {state,origin,
    post:(path,body,options={})=>fetch(origin+'/api'+path,{method:'POST',headers:{Origin:options.origin||origin,'Content-Type':'application/json',...(options.signedOut?{}:{Cookie:cookie})},body:JSON.stringify(body)}),
    get:path=>fetch(origin+'/api'+path,{headers:{Cookie:cookie}}),
    close:()=>Promise.all([new Promise(resolve=>api.close(resolve)),new Promise(resolve=>mock.close(resolve))])};
}
const saves = state => state.requests.filter(request=>request.path==='/rest/v1/rpc/ff_save_member_health');

test('dedicated member health API saves canonical optional fields, replaces and clears them',async()=>{
  const f=await fixture();
  try {
    const response=await f.post('/member-health',filled);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(body,{memberHealth:{...filled,conditions:['asthma','diabetes'],updatedAt:'2026-10-17T06:20:00Z'}});
    assert.deepEqual(saves(f.state)[0].body,{body:{...filled,conditions:['asthma','diabetes']}},'no client identity or workspace reaches the RPC');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    const clear=await f.post('/member-health',blank);
    assert.equal(clear.status,200);
    assert.deepEqual(await clear.json(),{memberHealth:{...blank,updatedAt:'2026-10-17T06:20:00Z'}});
    assert.equal(saves(f.state).length,2);
    assert.equal(f.state.requests.some(request=>request.path==='/rest/v1/rpc/ff_command'||request.path==='/rest/v1/rpc/ff_save_member_survey'),false);
  } finally {await f.close();}
});

test('invalid, extra, partial or conflicting health fields fail before any save without echoing values',async()=>{
  const f=await fixture();
  try {
    for(const body of [{...blank,heightCm:49},{...blank,weightKg:500.2},{...blank,heightCm:170.55},{...blank,ageBand:'adult'},
      {...blank,conditions:['none','asthma']},{...blank,conditions:['prefer_not','other']},{...blank,conditions:['asthma','asthma']},
      {...blank,conditions:['PRIVATE-UNKNOWN-VALUE']},{...blank,memberId:'PRIVATE-ACCOUNT'},{...blank,bmi:22},
      {...blank,diagnosis:'PRIVATE-DIAGNOSIS'},{heightCm:null},{...blank,heightCm:'170.5'}]) {
      const response=await f.post('/member-health',body);
      assert.equal(response.status,400);
      assert.doesNotMatch((await response.json()).error,/PRIVATE-|170\.55|500\.2/);
    }
    assert.equal(saves(f.state).length,0);
    assert.equal((await f.post('/member-health',blank,{origin:'https://other.invalid'})).status,403);
    assert.equal((await f.post('/member-health',blank,{signedOut:true})).status,401);
    assert.equal(saves(f.state).length,0);
  } finally {await f.close();}
});

test('member state reads only its owner health fields and keeps them outside shared members/surveys',async()=>{
  const f=await fixture();
  try {
    const empty=await f.get('/state');
    assert.equal(empty.status,200);
    assert.equal((await empty.json()).memberHealth,null);
    await f.post('/member-health',filled);
    const response=await f.get('/state'),body=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(body.memberHealth,{...filled,conditions:['asthma','diabetes'],updatedAt:'2026-10-17T06:20:00Z'});
    assert.equal(body.members.length,1);
    assert.equal(body.members[0].survey,null);
    for(const key of ['memberHealth','heightCm','weightKg','ageBand','conditions']) assert.equal(Object.hasOwn(body.members[0],key),false);
    const healthQueries=f.state.requests.filter(request=>request.path==='/rest/v1/ff_member_health');
    assert.ok(healthQueries.every(request=>request.query.get('id')===`eq.${f.state.profile.id}`));
    assert.ok(healthQueries.every(request=>request.query.get('select')==='height_cm,weight_kg,age_band,conditions,updated_at'));
    assert.equal(body.invoices.length,0);assert.equal(body.payments.length,0);
  } finally {await f.close();}
});

test('staff, administrators and disabled members cannot save or fetch owner health through app state',async()=>{
  for(const role of ['staff','admin','member']) {
    const f=await fixture(role);
    try {
      if(role==='member') f.state.profile.enabled=false;
      f.state.health={height_cm:170,weight_kg:60,age_band:'20plus',conditions:['asthma'],updated_at:'2026-10-17T06:20:00Z'};
      assert.equal((await f.post('/member-health',filled)).status,403,role);
      const response=await f.get('/state');assert.equal(response.status,200);
      assert.equal(Object.hasOwn(await response.json(),'memberHealth'),false);
      assert.equal(f.state.requests.some(request=>request.path==='/rest/v1/ff_member_health'),false,'no health query for '+role);
      assert.equal(saves(f.state).length,0);
    } finally {await f.close();}
  }
});

test('health view and database refusals expose no identity, internal fields or submitted values',async()=>{
  assert.deepEqual(healthView({id:'private',workspace:'production',height_cm:'170.5',weight_kg:null,age_band:null,conditions:[],updated_at:'time',bmi:99,notes:'private'}),{heightCm:170.5,weightKg:null,ageBand:null,conditions:[],updatedAt:'time'});
  assert.equal(healthView(null),null);
  const f=await fixture();
  try {
    f.state.rpcError={code:'42501',message:'PRIVATE-HEALTH-VALUE'};
    const response=await f.post('/member-health',filled);
    assert.equal(response.status,403);
    assert.deepEqual(await response.json(),{error:'Access denied. Sign in to an authorized account.'});
  } finally {await f.close();}
});
