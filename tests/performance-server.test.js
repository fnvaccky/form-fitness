import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createClient} from '@supabase/supabase-js';
import {memberFor,stateFor} from '../src/state.js';
import {memberProgress,saveMemberProgress} from '../src/member-progress.js';
import {handle} from '../src/api.js';

const memberId='11111111-2222-4333-8444-555555555555';
const actor={id:'66666666-7777-4888-9999-000000000000',role:'staff',workspace:'production',enabled:true};
const member={id:memberId,workspace:'production',role:'member',enabled:true,name:'LOCAL TEST Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',photo:'',created_at:'2026-10-01T01:00:00Z'};
const terms={name:'Frozen purchase',priceCents:89900,days:30,description:'As bought',features:['Frozen benefit'],coaching:'none',coachSessions:0};
async function fixture() {
  const state={requests:[],cycles:[{id:'cycle',member_id:memberId,workspace:'production',plan_id:'renamed',start_date:'2000-01-01',end_date:'2099-12-31',terms}],member,survey:{id:memberId,workspace:'production',experience:'beginner',exercises:['strength'],available_days:['mon','wed'],updated_at:'saved'},rpcError:null};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://localhost'),body=raw?JSON.parse(raw):null;
    state.requests.push({table:url.pathname.split('/').at(-1),query:url.searchParams,body});
    res.setHeader('Content-Type','application/json');const send=data=>res.end(JSON.stringify(data));
    const user={id:actor.id,aud:'authenticated',role:'authenticated',email:'staff@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-10-01T01:00:00Z'};
    if(url.pathname==='/auth/v1/token'){
      const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),expires=Math.floor(Date.now()/1000)+3600;
      return send({access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:actor.id,aud:'authenticated',exp:expires,session_id:actor.id})}.fixture`,token_type:'bearer',expires_in:3600,expires_at:expires,refresh_token:'fixture-only',user});
    }
    if(url.pathname==='/auth/v1/user')return send(user);
    if(url.pathname.endsWith('/ff_command'))return send({member:{id:memberId},expires:12345,alreadyCheckedInAt:null});
    if(url.pathname.endsWith('/ff_member_progress')){if(state.rpcError){res.statusCode=403;return send(state.rpcError);}return send({ok:true});}
    if(url.pathname.endsWith('/ff_profiles'))return send(url.searchParams.get('id')==='eq.'+actor.id?[{...actor,name:'LOCAL TEST Staff',email:user.email}]:state.member?[state.member]:[]);
    if(url.pathname.endsWith('/ff_memberships'))return send(state.cycles.slice(Number(url.searchParams.get('offset')||0),Number(url.searchParams.get('offset')||0)+Number(url.searchParams.get('limit')||1000)));
    if(url.pathname.endsWith('/ff_member_surveys'))return send(state.survey?[state.survey]:[]);
    if(url.pathname.endsWith('/ff_settings'))return send({payments:{}});
    if(url.pathname.endsWith('/ff_member_health'))return send([{weight_kg:63,updated_at:'saved'}]);
    return send([]);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=createClient(`http://127.0.0.1:${server.address().port}`,'isolated-publishable',{auth:{persistSession:false,autoRefreshToken:false}});
  return {client,state,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('targeted operational member projection matches full state without unrelated data reads',async()=>{
  const f=await fixture();try {
    f.state.cycles.push({...f.state.cycles[0],id:'future',start_date:'2100-01-01',end_date:'2100-12-31',terms:{...terms,name:'Upcoming'}});
    const full=await stateFor(f.client,actor,{});f.state.requests=[];
    const projected=await memberFor(f.client,actor,memberId);
    assert.deepEqual(projected,full.members[0]);assert.equal(projected.terms.name,'Frozen purchase');
    assert.deepEqual(f.state.requests.map(row=>row.table).sort(),['ff_member_surveys','ff_memberships','ff_profiles']);
    for(const row of f.state.requests){assert.equal(row.query.get('workspace'),'eq.production');assert.equal(row.query.get(row.table==='ff_memberships'?'member_id':'id'),'eq.'+memberId);}
    assert.equal(f.state.requests.find(row=>row.table==='ff_profiles').query.get('role'),'eq.member');
    assert.equal('memberHealth' in projected,false);
  }finally{await f.close();}
});

test('targeted member read preserves future/expired fallback and null/missing survey behavior',async()=>{
  const f=await fixture();try {
    for(const [start,end] of [['2100-01-01','2100-01-31'],['2000-01-01','2000-01-31']]) {
      f.state.cycles=[{...f.state.cycles[0],start_date:start,end_date:end}];f.state.survey=null;
      const expected=(await stateFor(f.client,actor,{})).members[0];
      assert.deepEqual(await memberFor(f.client,actor,memberId),expected);
    }
    f.state.cycles=[];assert.equal((await memberFor(f.client,actor,memberId)).terms,null);
    f.state.member=null;assert.equal(await memberFor(f.client,actor,memberId),null);
  }finally{await f.close();}
});

test('targeted cycle paging and account scope never cache or truncate another response',async()=>{
  const f=await fixture();try {
    const cycle=f.state.cycles[0];f.state.cycles=Array.from({length:1001},(_,i)=>({...cycle,id:String(i),start_date:'2100-01-01',end_date:'2100-01-31'}));
    f.state.cycles.at(-1).start_date='2000-01-01';f.state.cycles.at(-1).end_date='2099-12-31';f.state.cycles.at(-1).terms={...terms,name:'Last page current cycle'};
    assert.equal((await memberFor(f.client,actor,memberId)).terms.name,'Last page current cycle');
    assert.equal(f.state.requests.filter(row=>row.table==='ff_memberships').length,2);
    f.state.requests=[];f.state.member={...member,workspace:'demo'};
    await memberFor(f.client,{...actor,workspace:'demo'},memberId);
    assert.ok(f.state.requests.every(row=>row.query.get('workspace')==='eq.demo'));
  }finally{await f.close();}
});

test('progress GET still validates the database actor; confirmed mutation omits only duplicate read RPC',async()=>{
  const f=await fixture();const profile={...member};try {
    const before=await memberProgress(f.client,profile,{},'2026-10-17');
    assert.deepEqual(f.state.requests[0].body,{body:{action:'read'}});
    f.state.requests=[];
    const after=await saveMemberProgress(f.client,profile,{action:'add_weight',date:'2026-10-17',weightKg:62},'2026-10-17');
    assert.deepEqual(after,before);
    assert.deepEqual(f.state.requests.filter(row=>row.table==='ff_member_progress').map(row=>row.body),[{body:{action:'add_weight',date:'2026-10-17',weightKg:62}}]);
    assert.equal(f.state.requests.length,4);
    for(const row of f.state.requests.filter(row=>row.table!=='ff_member_progress')){
      assert.equal(row.query.get(row.table==='ff_member_health'?'id':'member_id'),'eq.'+memberId);assert.equal(row.query.get('workspace'),'eq.production');
    }
  }finally{await f.close();}
});

test('progress mutation failure or non-member never returns a confirmed snapshot',async()=>{
  const f=await fixture();try {
    const request={action:'add_weight',date:'2026-10-17',weightKg:62};
    for(const role of ['staff','admin'])await assert.rejects(saveMemberProgress(f.client,{...member,role},request,'2026-10-17'),{status:403});
    assert.equal(f.state.requests.length,0);
    f.state.rpcError={code:'42501',message:'PRIVATE SESSION DETAIL'};
    await assert.rejects(saveMemberProgress(f.client,member,request,'2026-10-17'),error=>error.status===403&&!error.message.includes('PRIVATE'));
    assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].table,'ff_member_progress');
    f.state.requests=[];
    await assert.rejects(memberProgress(f.client,member,{},'2026-10-17'),{status:403});
    assert.equal(f.state.requests.length,1);
  }finally{await f.close();}
});

test('authorized scan API keeps its confirmed result and no-store headers with only scoped decoration reads',async()=>{
  const f=await fixture();let origin='';
  const api=http.createServer((req,res)=>handle(req,res,{SUPABASE_URL:f.url,SUPABASE_PUBLISHABLE_KEY:'isolated-publishable',APP_ORIGIN:origin,APP_WORKSPACE:'production'}));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${api.address().port}`;
  try {
    const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'staff@example.invalid',password:'fixture-only'})});assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');f.state.requests=[];
    const response=await fetch(origin+'/api/scan',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({token:'ISOLATED-PASS'})});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    const saved=await response.json();assert.equal(saved.expires,12345);assert.equal(saved.alreadyCheckedInAt,null);assert.equal(saved.member.id,memberId);assert.equal(saved.member.terms.name,'Frozen purchase');
    assert.deepEqual(f.state.requests.map(row=>row.table).sort(),['ff_command','ff_member_surveys','ff_memberships','ff_profiles','ff_profiles','user']);
    assert.deepEqual(f.state.requests.find(row=>row.table==='ff_command').body,{action:'scan',body:{token:'ISOLATED-PASS'}});
    assert.equal(f.state.requests.some(row=>/health|goals|weights|invoices|notifications|checkouts|settings/.test(row.table)),false);
  }finally{await new Promise(resolve=>api.close(resolve));await f.close();}
});
