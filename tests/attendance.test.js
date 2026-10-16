import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceRange,attendanceTotals,manilaTime,manilaClock,checkinStatus} from '../src/attendance.js';
// Task 13: the attendance report's date rules and totals.
const today='2026-10-12';

test('attendance accepts real dates, From on or before To, at most 366 days, To no later than today, and a plan id or "all"',()=>{
 assert.deepEqual(attendanceRange({from:'2026-10-06',to:'2026-10-12'},today),{from:'2026-10-06',to:'2026-10-12',days:7,plan:'all'});
 assert.equal(attendanceRange({from:'2026-10-12',to:'2026-10-12',plan:'basic'},today).days,1,'one day, today');
 assert.equal(attendanceRange({from:'2025-10-12',to:'2026-10-12'},today).days,366,'366 days is the limit');
 assert.equal(attendanceRange({from:'2024-02-28',to:'2024-03-01'},today).days,3,'leap day counted');
 const refused=(query,pattern,label)=>assert.throws(()=>attendanceRange(query,today),error=>error.status===400&&pattern.test(error.message),label);
 for(const value of [undefined,'','2026-1-1','12/10/2026','2026-10-12T00:00','x'])refused({from:value,to:'2026-10-12'},/From must be a date/,`From ${value}`);
 for(const value of ['2026-02-30','2026-13-01','2026-00-10','2025-02-29'])refused({from:value,to:'2026-10-12'},/not a real date/,value);
 refused({from:'2026-10-12',to:'2026-10-11'},/From must be on or before To/,'reversed');
 refused({from:'2026-10-12',to:'2026-10-13'},/later than today/,'tomorrow');
 refused({from:'2025-10-11',to:'2026-10-12'},/at most 366 days/,'367 days');
 for(const plan of ['','<script>','basic plan','x'.repeat(41)])refused({from:'2026-10-06',to:'2026-10-12',plan},/Choose a plan/,`plan ${JSON.stringify(plan)}`);
});

test('attendance totals: visits, unique members, days and the daily average to one decimal',()=>{
 const visits=['a','b','a','c','a','b','d'].map(memberId=>({memberId}));
 assert.deepEqual(attendanceTotals(visits,3),{visits:7,uniqueMembers:4,days:3,dailyAverage:2.3});
 assert.deepEqual(attendanceTotals(visits.slice(0,5),2),{visits:5,uniqueMembers:3,days:2,dailyAverage:2.5});
 assert.deepEqual(attendanceTotals([],7),{visits:0,uniqueMembers:0,days:7,dailyAverage:0});
 assert.equal(attendanceTotals([{memberId:'a'}],3).dailyAverage,0.3);
});

test('visit times are shown in Manila time',()=>{
 assert.equal(manilaTime('2026-10-12T16:30:00Z'),'00:30');
 assert.equal(manilaTime('2026-10-12T01:05:00.123+00:00'),'09:05');
});

// Task 13A: what members see uses the 12-hour clock ("10:15 AM"), with a plain space before AM/PM.
test('member-facing visit times use the 12-hour clock in Manila time',()=>{
 assert.equal(manilaClock('2026-10-13T02:15:00Z'),'10:15 AM');
 assert.equal(manilaClock('2026-10-12T16:05:19.367+00:00'),'12:05 AM');
 assert.equal(manilaClock('2026-10-13T06:30:00Z'),'2:30 PM');
});

test('check-in status reads only the caller\'s own check-in for today',async()=>{
 const reads=[];
 const fake=row=>({from(table){const q={table,filters:[],select(columns){this.columns=columns;return this;},eq(k,v){this.filters.push([k,v]);return this;},
  maybeSingle(){reads.push(this);return Promise.resolve({data:row,error:null});}};return q;}});
 const visited=await checkinStatus(fake({checkin_date:'2026-10-13',created_at:'2026-10-13T02:15:00Z',membership:{plan_id:'plus',terms:{name:'Momentum (as bought)'}}}),{id:'member-1'},'2026-10-13');
 assert.deepEqual(visited,{checkedIn:true,date:'2026-10-13',time:'10:15 AM',at:'2026-10-13T02:15:00Z',plan:'plus',planName:'Momentum (as bought)'},'Task 12A: the plan name the cycle was bought as');
 assert.match(reads[0].columns,/membership:ff_memberships\(plan_id,terms\)/);
 assert.equal(reads[0].table,'ff_checkins');
 assert.deepEqual(reads[0].filters,[['member_id','member-1'],['checkin_date','2026-10-13']],'the caller\'s own row, today only');
 assert.deepEqual(await checkinStatus(fake(null),{id:'member-1'},'2026-10-13'),{checkedIn:false,date:'2026-10-13'});
});

// A stand-in for the Supabase query builder: pages come from an in-memory list, and every range() is recorded.
function fakeClient(rows,plans=[{id:'basic',name:'Essential'},{id:'plus',name:'Momentum'}]){
 const calls=[];
 return {calls,from(table){
  if(table==='ff_plans')return {select:()=>Promise.resolve({data:plans,error:null})};
  const q={state:{},select(s){this.state.select=s;return this;},gte(k,v){this.state.gte=[k,v];return this;},lte(k,v){this.state.lte=[k,v];return this;},
   order(){return this;},eq(k,v){this.state.eq=[k,v];return this;},
   range(a,b){calls.push({a,b,...this.state});return Promise.resolve({data:rows.slice(a,b+1),error:null});}};
  return q;
 }};
}
const row=i=>({id:`c${i}`,member_id:`m${i%7}`,checkin_date:'2026-10-11',created_at:'2026-10-11T04:00:00Z',member:{name:`Member ${i%7}`},staff:{name:'Front Desk'},membership:{plan_id:i%2?'plus':'basic'}});
test('the attendance report reads 1,000 rows at a time, stops at 10,000 and says when it truncated',async()=>{
 const {attendanceReport}=await import('../src/attendance.js');
 const query={from:'2026-10-05',to:'2026-10-11'};
 const big=fakeClient(Array.from({length:10001},(_,i)=>row(i)));
 const report=await attendanceReport(big,query,today);
 assert.equal(report.visits.length,10000);assert.equal(report.truncated,true);
 assert.deepEqual(big.calls.map(c=>c.a),[0,1000,2000,3000,4000,5000,6000,7000,8000,9000,10000],'ten pages, then one probe past the cap');
 assert.deepEqual(big.calls[0].gte,['checkin_date','2026-10-05']);assert.deepEqual(big.calls[0].lte,['checkin_date','2026-10-11']);
 const exact=fakeClient(Array.from({length:10000},(_,i)=>row(i)));
 assert.equal((await attendanceReport(exact,query,today)).truncated,false,'exactly 10,000 rows is not truncated');
 const small=fakeClient(Array.from({length:2500},(_,i)=>row(i)));
 const smallReport=await attendanceReport(small,query,today);
 assert.equal(smallReport.visits.length,2500);assert.equal(smallReport.truncated,false);assert.deepEqual(small.calls.map(c=>c.a),[0,1000,2000]);
 assert.deepEqual(smallReport.visits[1],{id:'c1',date:'2026-10-11',time:'12:00',memberId:'m1',name:'Member 1',plan:'Momentum',confirmedBy:'Front Desk'});
 assert.deepEqual(smallReport.totals,{visits:2500,uniqueMembers:7,days:7,dailyAverage:357.1});
 // Task 12A: a visit shows the plan its cycle was bought as; the catalog name is only the fallback.
 const renamed=fakeClient([{...row(1),membership:{plan_id:'plus',terms:{name:'Momentum'}}}],[{id:'basic',name:'Essential'},{id:'plus',name:'Momentum Max'}]);
 assert.equal((await attendanceReport(renamed,query,today)).visits[0].plan,'Momentum','the purchased name, not the catalog name now');
 const filtered=fakeClient([row(1)]);
 await attendanceReport(filtered,{...query,plan:'plus'},today);
 assert.match(filtered.calls[0].select,/membership:ff_memberships!inner\(plan_id,terms\)/);assert.deepEqual(filtered.calls[0].eq,['membership.plan_id','plus']);
 const unknown=fakeClient([row(1)]);
 await assert.rejects(attendanceReport(unknown,{...query,plan:'gold'},today),error=>error.status===400&&/Choose a plan/.test(error.message));
 assert.equal(unknown.calls.length,0,'an unknown plan is refused before any check-in is read');
});
