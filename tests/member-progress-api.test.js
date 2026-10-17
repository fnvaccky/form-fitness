import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handle} from '../src/api.js';
import {goalView,weightView} from '../src/member-progress.js';
const id='11111111-2222-4333-8444-555555555555',requestId='66666666-7777-4888-9999-000000000000';
const goal={action:'save_goal',requestId,goalId:null,goalType:'gain',startDate:'2026-10-01',startingWeightKg:60,measurementDate:'2026-10-01',targetWeightKg:65};
async function fixture(role='member') {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),expires=Math.floor(Date.now()/1000)+3600;
  const user={id,aud:'authenticated',role:'authenticated',email:'progress@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-10-01T00:00:00Z'};
  const state={requests:[],goals:[],weights:[],health:{weight_kg:64,updated_at:'2026-10-02T01:00:00Z'},profile:{id,workspace:'production',role,name:'LOCAL TEST Progress',email:user.email,phone:'09170000001',enabled:true,goal:'Improve fitness',photo:'',created_at:user.created_at}};
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,aud:'authenticated',exp:expires,session_id:requestId})}.fixture-signature`,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fixture-refresh',user};
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:url.pathname,method:req.method,query:url.searchParams,body});
    res.setHeader('Content-Type','application/json');const send=value=>res.end(JSON.stringify(value));
    if(url.pathname==='/auth/v1/token')return send(session);
    if(url.pathname==='/auth/v1/user')return send(user);
    if(url.pathname==='/rest/v1/ff_profiles')return send([state.profile]);
    if(url.pathname==='/rest/v1/ff_settings')return send({payments:{}});
    if(url.pathname==='/rest/v1/ff_member_goals')return send(state.goals);
    if(url.pathname==='/rest/v1/ff_member_weights')return send(state.weights);
    if(url.pathname==='/rest/v1/ff_member_health')return send(state.health?[state.health]:[]);
    if(url.pathname==='/rest/v1/rpc/ff_member_progress') {
      if(state.rpcError){res.statusCode=403;return send(state.rpcError);}
      if(body.body.action==='save_goal')state.goals=[{id:requestId,period_id:requestId,goal_type:'gain',status:'active',start_date:'2026-10-01',starting_weight_kg:'60',measurement_date:'2026-10-01',target_weight_kg:'65',recorded_at:'2026-10-17T07:00:00Z',ended_at:null}];
      return send({ok:true});
    }
    if(url.pathname.startsWith('/rest/v1/'))return send([]);
    res.statusCode=404;return send({});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  let origin='';const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:`http://127.0.0.1:${mock.address().port}`,SUPABASE_PUBLISHABLE_KEY:'publishable-fixture',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${api.address().port}`;
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:'fixture-only'})});assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  return {state,get:(path='/member-progress',signedOut=false)=>fetch(origin+'/api'+path,{headers:signedOut?{}:{Cookie:cookie}}),
    post:(body,options={})=>fetch(origin+'/api/member-progress'+(options.query||''),{method:'POST',headers:{Origin:options.origin||origin,'Content-Type':'application/json',...(options.signedOut?{}:{Cookie:cookie})},body:JSON.stringify(body)}),
    close:()=>Promise.all([new Promise(resolve=>api.close(resolve)),new Promise(resolve=>mock.close(resolve))])};
}
const progressRequests=state=>state.requests.filter(row=>/ff_member_(goals|weights)$|ff_member_progress$/.test(row.path));

test('private progress endpoint verifies enabled owner and returns scoped minimal confirmed views',async()=>{
  const f=await fixture();try {
    f.state.weights=[{id:requestId,measured_on:'2026-10-01',weight_kg:'60.1',recorded_at:'created',updated_at:'updated'}];
    const response=await f.get();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    const {memberProgress:p}=await response.json();assert.equal(p.currentGoal,null);assert.equal(p.goals.length,0);assert.equal(p.measurements[0].weightKg,60.1);
    assert.deepEqual(p.healthWeight,{weightKg:64,recordedAt:'2026-10-02T01:00:00Z'});assert.match(p.today,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(progressRequests(f.state)[0].body,{body:{action:'read'}},'database actor validates still-current session before reads');
    for(const request of f.state.requests.filter(row=>/ff_member_(goals|weights|health)$/.test(row.path))) {
      assert.equal(request.query.get(request.path.endsWith('health')?'id':'member_id'),'eq.'+id);assert.equal(request.query.get('workspace'),'eq.production');
      assert.doesNotMatch(request.query.get('select'),/\*|conditions|height_cm|request_hash/);
    }
  } finally {await f.close();}
});
test('successful saves forward validated action only and return actual saved state',async()=>{
  const f=await fixture();try {
    const response=await f.post(goal);assert.equal(response.status,200);const {memberProgress:p}=await response.json();
    assert.equal(p.currentGoal.startingWeightKg,60);assert.equal(p.currentGoal.targetWeightKg,65);assert.equal(p.currentGoal.goalType,'gain');
    const saves=progressRequests(f.state).filter(row=>row.body?.body?.action==='save_goal');assert.deepEqual(saves.map(row=>row.body),[{body:goal}]);
    assert.equal(f.state.requests.some(row=>/ff_save_member_health|ff_save_member_survey|ff_command$/.test(row.path)),false);
  } finally {await f.close();}
});
test('invalid/identity override submissions and query fields fail before private RPC/data reads',async()=>{
  const f=await fixture();try {
    for(const body of [{...goal,memberId:'PRIVATE-ID'},{...goal,workspace:'demo'},{...goal,startingWeightKg:60.11},{...goal,targetWeightKg:59},
      {action:'add_weight',date:'9999-12-31',weightKg:60},{action:'add_weight',date:'2026-10-01',weightKg:'PRIVATE-WEIGHT'},
      {action:'delete_weight',id:requestId,memberId:id},{action:'pause_goal',goalId:requestId}]) {
      const response=await f.post(body);assert.equal(response.status,400);assert.doesNotMatch((await response.json()).error,/PRIVATE-|60\.11/);
    }
    assert.equal((await f.get('/member-progress?memberId='+id)).status,400);
    assert.equal((await f.get('/member-progress?workspace=production')).status,400);
    assert.equal((await f.post(goal,{query:'?memberId='+id})).status,400);
    assert.equal((await f.post(goal,{origin:'https://other.invalid'})).status,403);
    assert.equal(progressRequests(f.state).length,0);
  } finally {await f.close();}
});
test('staff/admin previews, disabled and foreign-workspace profiles never query private progress',async()=>{
  for(const kind of ['staff','admin','disabled','foreign']) {
    const f=await fixture(kind==='staff'||kind==='admin'?kind:'member');try {
      if(kind==='disabled')f.state.profile.enabled=false;
      if(kind==='foreign')f.state.profile.workspace='demo';
      assert.equal((await f.get()).status,kind==='foreign'?401:403);
      assert.equal((await f.post(goal)).status,kind==='foreign'?401:403);
      assert.equal(progressRequests(f.state).length,0);
      const response=await f.get('/state');
      if(kind!=='foreign'){const state=await response.json();assert.equal(Object.hasOwn(state,'memberProgress'),false);}
      assert.equal(progressRequests(f.state).length,0,'state/preview never loads private goals or weights');
    }finally{await f.close();}
  }
});
test('signed-out/revoked session denial and safe conflict messages preserve unsuccessful draft inputs',async()=>{
  const f=await fixture();try {
    assert.equal((await f.get('/member-progress',true)).status,401);assert.equal((await f.post(goal,{signedOut:true})).status,401);
    f.state.rpcError={code:'42501',message:'PRIVATE-REVOKED-DETAIL'};
    const response=await f.get();assert.equal(response.status,403);assert.doesNotMatch((await response.json()).error,/PRIVATE-/);
    assert.equal(f.state.requests.some(row=>/ff_member_(goals|weights)$/.test(row.path)),false);
    f.state.rpcError={code:'P0001',message:'A weight already exists on that date. Use Edit to replace it explicitly.'};
    const conflict=await f.post({action:'add_weight',date:'2026-10-01',weightKg:61});assert.equal(conflict.status,409);assert.match((await conflict.json()).error,/Use Edit/);
    f.state.rpcError={code:'P0001',message:'This request already saved different goal settings. Reload progress before saving again.'};
    assert.equal((await f.post(goal)).status,409);assert.equal(f.state.goals.length,0);
  }finally{await f.close();}
});
test('view projection never returns identities, request hashes, conditions or internal columns',()=>{
  const goal=goalView({id:'goal',period_id:'period',goal_type:'maintain',status:'paused',start_date:'2026-10-01',starting_weight_kg:'60.1',measurement_date:'2026-10-01',target_weight_kg:null,recorded_at:'created',ended_at:null,request_hash:'secret',workspace:'production',member_id:'private'});
  assert.deepEqual(goal,{id:'goal',periodId:'period',goalType:'maintain',status:'paused',startDate:'2026-10-01',startingWeightKg:60.1,measurementDate:'2026-10-01',targetWeightKg:null,recordedAt:'created',endedAt:null});
  assert.deepEqual(weightView({id:'weight',measured_on:'2026-10-01',weight_kg:'61.2',recorded_at:'created',updated_at:'updated',member_id:'private',conditions:['asthma']}),{id:'weight',date:'2026-10-01',weightKg:61.2,recordedAt:'created',updatedAt:'updated'});
});
