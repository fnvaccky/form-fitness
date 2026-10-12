import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CONFIRM,parseArgs,sqlParts,deleteSql,closeCheckouts,memberFiles} from '../scripts/reset-test-data.js';
// RESET-001: the pieces of `npm run reset:test-data` that decide what happens. PayMongo is mocked here;
// tests/reset-test-data.js runs the SQL itself against the local stack.
const KEY='sk_test_'+'x'.repeat(24);
const ID='11111111-2222-4333-8444-555555555555',ID2='66666666-7777-4888-8999-aaaaaaaaaaaa';

test('the reset runs only with --confirm "DELETE ALL MEMBERS" typed exactly, or as a dry run',()=>{
 assert.equal(CONFIRM,'DELETE ALL MEMBERS');
 for(const argv of [[],['--confirm'],['--confirm','delete all members'],['--confirm','DELETE ALL MEMBERS '],['--confirm','DELETE  ALL MEMBERS'],['--local']])
  assert.throws(()=>parseArgs(argv),/add --confirm "DELETE ALL MEMBERS" exactly/,JSON.stringify(argv));
 assert.deepEqual(parseArgs(['--confirm','DELETE ALL MEMBERS']),{dryRun:false,local:false,confirm:CONFIRM});
 assert.deepEqual(parseArgs(['--confirm=DELETE ALL MEMBERS','--local']),{dryRun:false,local:true,confirm:CONFIRM});
 assert.equal(parseArgs(['--dry-run']).dryRun,true,'a dry run deletes nothing, so it needs no confirmation');
 assert.throws(()=>parseArgs(['--confirm','DELETE ALL MEMBERS','--force']),/Unknown option --force/);
});

test('the script runs the SQL Editor file: PART 1 as the preview, PART 2 with the confirmation and the closed checkouts filled in',async()=>{
 const text=await readFile('scripts/reset-test-data.sql','utf8');
 const {preview,remove}=sqlParts(text);
 assert.match(preview,/^with ws as \(select 'production'::text as name\)/);assert(!preview.endsWith(';'),'wrapped as a subquery');
 assert.doesNotMatch(preview,/\b(delete\s+from|update\s+[\w.]+\s+set|insert\s+into|truncate|drop|alter|create)\b/i,'PART 1 only reads');
 assert.match(remove,/^do \$\$/);
 const sql=deleteSql(remove,[ID,ID2]);
 assert(sql.includes("confirm constant text := 'DELETE ALL MEMBERS';"));
 assert(sql.includes(`closed constant jsonb := '["${ID}","${ID2}"]';`));
 assert(!sql.includes('type DELETE ALL MEMBERS here'),'the placeholder is gone');
 assert.equal(deleteSql(remove,[]).includes("closed constant jsonb := '[]';"),true);
 assert.throws(()=>deleteSql(remove,["x'); drop table ff_plans; --"]),/Unexpected checkout id/);
 assert.throws(()=>deleteSql(remove.replace('type DELETE ALL MEMBERS here','changed'),[]),/no longer contains/);
 assert.throws(()=>sqlParts('select 1;'),/missing its PART 1 \/ PART 2 markers/);
 // The guards PART 2 must keep.
 for(const guard of ["if confirm is distinct from 'DELETE ALL MEMBERS'","if ws is distinct from 'production'","not (closed ? id::text)","a member account appears in the staff audit log"])
  assert(remove.includes(guard),guard);
});

function paymongo(sessions,{expireStatus=200,payDuringExpire=false}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,method:options.method});
  assert.equal(options.headers.Authorization,'Basic '+Buffer.from(KEY+':').toString('base64'));
  const parts=new URL(url).pathname.split('/'),expire=parts.at(-1)==='expire',id=expire?parts.at(-2):parts.at(-1),s=sessions[id];
  if(!s)return Response.json({errors:[{code:'resource_not_found_error'}]},{status:404});
  if(expire){
   if(payDuringExpire){s.attributes.payments=[{attributes:{status:'paid',amount:149900,source:{type:'gcash'},paid_at:1791700000}}];return Response.json({errors:[{code:'parameter_invalid'}]},{status:400});}
   if(expireStatus===200&&s.attributes.status==='active')s.attributes.status='expired';
   return Response.json(expireStatus===200?{data:s}:{errors:[{code:'internal'}]},{status:expireStatus});
  }
  return Response.json({data:s});
 };
 return {calls,fetchImpl};
}
const session=(id,checkout,extra={})=>({id,attributes:{status:'active',livemode:false,reference_number:checkout,payments:[],...extra}});

test('PayMongo first: active sessions are expired and confirmed, a paid one is only listed, a dry run only reads',async()=>{
 const sessions={cs_Active1:session('cs_Active1',ID),cs_Paid1:session('cs_Paid1',ID2,{payments:[{attributes:{status:'paid',amount:149900,source:{type:'gcash'},paid_at:1791700000}}]})};
 const checkouts=[{id:ID,status:'needs_review',session_id:null,review_details:{sessionId:'cs_Active1'}},{id:ID2,status:'pending',session_id:'cs_Paid1'}];
 const dry=paymongo(structuredClone(sessions));
 const rehearsal=await closeCheckouts(checkouts,{key:KEY,dryRun:true,fetchImpl:dry.fetchImpl});
 assert.deepEqual(rehearsal.wouldExpire,[ID]);assert.equal(rehearsal.paid.length,1);
 assert(!dry.calls.some(c=>c.method==='POST'),'a dry run never expires anything');
 const live=paymongo(sessions);
 const result=await closeCheckouts(checkouts,{key:KEY,fetchImpl:live.fetchImpl});
 assert.deepEqual(result.expired,[ID]);assert.deepEqual(result.closed,[ID,ID2]);
 assert.deepEqual(result.paid,[{id:ID2,sessionId:'cs_Paid1',amount:1499,method:'gcash',paidAt:new Date(1791700000*1000).toISOString()}]);
 assert.deepEqual(live.calls.filter(c=>c.method==='POST').map(c=>c.url),['https://api.paymongo.com/v1/checkout_sessions/cs_Active1/expire'],'only the active session is expired');
 assert.equal(sessions.cs_Active1.attributes.status,'expired');
 const already=await closeCheckouts([{id:ID,session_id:'cs_Active1'}],{key:KEY,fetchImpl:paymongo(sessions).fetchImpl});
 assert.deepEqual(already.alreadyExpired,[ID]);
 const raced=await closeCheckouts([{id:ID,session_id:'cs_Race1'}],{key:KEY,fetchImpl:paymongo({cs_Race1:session('cs_Race1',ID)},{payDuringExpire:true}).fetchImpl});
 assert.equal(raced.paid.length,1,'a payment that lands while expiring is listed as paid');
});

test('PayMongo first stops the reset on anything uncertain, before anything is deleted',async()=>{
 const checkout={id:ID,session_id:'cs_One1'};
 const refuse=async(options,pattern,label)=>assert.rejects(closeCheckouts([checkout],{key:KEY,...options}),pattern,label);
 await refuse({key:'sk_live_abc'},/test key/,'never a live key');
 await refuse({key:''},/test key/,'a key is needed when checkouts are open');
 await refuse({fetchImpl:paymongo({cs_One1:session('cs_One1',ID,{livemode:true})}).fetchImpl},/not in test mode/,'never a live session');
 await refuse({fetchImpl:paymongo({cs_One1:session('cs_One1',ID2)}).fetchImpl},/belongs to another checkout/,'never another checkout\'s session');
 await refuse({fetchImpl:paymongo({}).fetchImpl},/HTTP 404/,'a session PayMongo does not know');
 await refuse({fetchImpl:paymongo({cs_One1:session('cs_One1',ID)},{expireStatus:500}).fetchImpl},/did not expire/,'an expiry PayMongo does not confirm');
 await assert.rejects(closeCheckouts([{id:ID,session_id:null}],{key:KEY}),/no PayMongo session/);
 assert.deepEqual((await closeCheckouts([],{key:''})).closed,[],'no open checkouts: no key needed');
});

test('only the members\' files are removed: never the payment QR images, another workspace or a kept account\'s photo',()=>{
 const files=memberFiles({paths:['production/m1/photo/a.png','production/m1/receipt/r.jpg','production/staff1/photo/member-photo.png','production/payments/gcash.png',
   'demo/m2/photo/b.png','production/staff1/photo/own.png','production/../x.png',null,'','production/m1/photo/a.png'],kept:['production/staff1/photo/own.png']});
 assert.deepEqual(files,['production/m1/photo/a.png','production/m1/receipt/r.jpg','production/staff1/photo/member-photo.png']);
});
