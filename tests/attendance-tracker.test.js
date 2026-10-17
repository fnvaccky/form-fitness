import test from 'node:test';
import assert from 'node:assert/strict';
import {businessDate,trackerPeriod,createAttendanceTracker,shiftDay,weekday} from '../public/attendance-tracker.js';
const today='2026-10-17';
const base=()=>({today,date:today,period:'week',schedules:[{effectiveFrom:'2026-10-01',days:['mon','wed']}],coverage:[{start:'2026-10-01',end:'2026-10-31'}],events:[]});
const event=(date,id=date)=>({id,at:date+'T02:00:00Z'});

test('Manila business dates cross UTC midnight independently of browser or server zone',()=>{
 assert.equal(businessDate('2026-10-11T15:59:59Z'),'2026-10-11');
 assert.equal(businessDate('2026-10-11T16:00:00Z'),'2026-10-12');
 assert.equal(businessDate('2026-10-12T01:00:00+09:00'),'2026-10-12');
 assert.equal(businessDate('bad'),null);
});
test('weeks run Monday through Sunday and months use real calendar boundaries including leap years',()=>{
 assert.deepEqual(trackerPeriod('week','2026-10-18','2026-10-18'),{period:'week',from:'2026-10-12',to:'2026-10-18'});
 assert.deepEqual(trackerPeriod('week','2026-01-01',today),{period:'week',from:'2025-12-29',to:'2026-01-04'});
 assert.deepEqual(trackerPeriod('month','2024-02-29',today),{period:'month',from:'2024-02-01',to:'2024-02-29'});
 for(const [period,date] of [['year',today],['week','2026-02-30'],['month','2026-1-1'],['month','0000-01-01'],['month','2026-10-18']])assert.throws(()=>trackerPeriod(period,date,today));
});
test('two of two completed usual dates is Consistent regardless of low frequency; extra events deduplicate by business day',()=>{
 const input=base();input.events=[event('2026-10-12','a'),{id:'b',at:'2026-10-11T22:00:00Z'},event('2026-10-14','c')];
 const result=createAttendanceTracker(input);
 assert.deepEqual(result.summary,{attendedDays:2,events:3,completedPlanned:2,completedAttended:2,percentage:100,label:'Consistent'});
 assert.equal(result.days[0].eventCount,2);assert.equal(result.history.length,3);
});
test('extra visits count toward frequency and never erase another usual date without a check-in',()=>{
 const input=base();input.events=[event('2026-10-12'),event('2026-10-13'),event('2026-10-15')];
 const result=createAttendanceTracker(input);
 assert.equal(result.summary.attendedDays,3);assert.equal(result.summary.completedAttended,1);assert.equal(result.summary.completedPlanned,2);
 assert.equal(result.summary.percentage,50);assert.equal(result.summary.label,'Building consistency');
 assert.equal(result.days.find(day=>day.date==='2026-10-14').status,'usual-without-checkin');
 assert.equal(result.days.find(day=>day.date==='2026-10-13').usual,false);
});
test('today and future dates are never missed and unselected days remain rest days',()=>{
 const input=base();input.schedules[0].days=['fri','sat','sun'];
 const result=createAttendanceTracker(input);
 assert.equal(result.summary.completedPlanned,1);
 assert.equal(result.days.find(day=>day.date===today).status,'today');
 assert.equal(result.days.at(-1).status,'future');
 assert.equal(result.days[0].status,'rest');
});
test('without known effective schedule history no past dates are invented or scored',()=>{
 const input=base();input.schedules=[];input.events=[event('2026-10-12')];
 const result=createAttendanceTracker(input);
 assert.equal(result.trackingStart,null);assert.equal(result.summary.attendedDays,1);
 assert.equal(result.summary.percentage,null);assert.equal(result.summary.label,'Not enough history yet');
 assert.equal(result.days[1].status,'before-tracking');
});
test('tracking start and changed weekdays apply only from their effective dates',()=>{
 const input=base();input.schedules=[{effectiveFrom:'2026-10-14',days:['mon','wed']},{effectiveFrom:'2026-10-16',days:['tue','fri']},{effectiveFrom:'2026-10-18',days:['sun']}];
 input.events=[event('2026-10-14'),event('2026-10-16')];
 const result=createAttendanceTracker(input);
 assert.equal(result.days[0].status,'before-tracking');
 assert.equal(result.summary.completedPlanned,2);assert.equal(result.summary.percentage,100);
 assert.deepEqual(result.usualDays,['tue','fri']);assert.deepEqual(result.pendingSchedule,input.schedules[2]);
 assert.equal(result.days.at(-1).usual,true);assert.equal(result.days.at(-1).completedPlanned,false);
});
test('uncovered gaps and dates before paid activation do not become missed usual dates',()=>{
 const input=base();input.schedules[0].days=['mon','tue','wed','thu','fri'];
 input.coverage=[{start:'2026-10-13',end:'2026-10-13'},{start:'2026-10-16',end:'2026-10-31'}];
 const result=createAttendanceTracker(input);
 assert.equal(result.summary.completedPlanned,2);
 assert.equal(result.days[0].status,'outside-coverage');assert.equal(result.days[2].status,'outside-coverage');
});
test('frequent schedules use the actual eligible denominator and month totals include extra visits',()=>{
 const input=base();input.period='month';input.schedules=[{effectiveFrom:'2026-10-12',days:['mon','tue','wed','thu','fri','sat','sun']}];
 input.events=['12','13','14','15','16'].map(day=>event('2026-10-'+day));
 const result=createAttendanceTracker(input);
 assert.equal(result.days.length,31);assert.equal(result.summary.completedPlanned,5);assert.equal(result.summary.percentage,100);
 assert.equal(result.days.find(day=>day.date===today).completedPlanned,false);
});
test('calendar calculations are deterministic and leave all source records unchanged',()=>{
 const input=base();input.events=[event('2026-10-12')];const copy=JSON.stringify(input);
 assert.deepEqual(createAttendanceTracker(input),createAttendanceTracker(input));assert.equal(JSON.stringify(input),copy);
 assert.equal(shiftDay('2026-12-31',1),'2027-01-01');assert.equal(weekday('2026-10-12'),'mon');
});
