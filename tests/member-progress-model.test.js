import test from 'node:test';
import assert from 'node:assert/strict';
import {GOAL_TYPES,validWeight,validateProgressMutation,goalSuggestion,progressSummary,businessDate} from '../public/member-progress-model.js';
const today='2026-10-17',requestId='11111111-1111-4111-8111-111111111111';
const goal={action:'save_goal',requestId,goalId:null,goalType:'gain',startDate:'2026-10-10',startingWeightKg:60,measurementDate:'2026-10-09',targetWeightKg:65};

test('survey suggestions need confirmation and never infer a weight direction from BMI',()=>{
  assert.deepEqual(GOAL_TYPES.map(([key])=>key),['lose','gain','maintain','attendance']);
  assert.equal(goalSuggestion('Manage weight').suggested,null);
  assert.deepEqual(goalSuggestion('Manage weight').choices,['lose','gain','maintain']);
  assert.equal(goalSuggestion('Stay consistent').suggested,'attendance');
  for(const value of ['Build strength','Improve fitness',null])assert.match(goalSuggestion(value).message,/does not measure strength or fitness|Confirm/);
  assert.equal(Object.hasOwn(goalSuggestion('Manage weight'),'goal'),false);
});
test('all four goals accept only their own required confirmed fields',()=>{
  assert.deepEqual(validateProgressMutation(goal,today),goal);
  assert.doesNotThrow(()=>validateProgressMutation({...goal,goalType:'lose',targetWeightKg:55},today));
  assert.doesNotThrow(()=>validateProgressMutation({...goal,goalType:'gain',targetWeightKg:null},today));
  assert.doesNotThrow(()=>validateProgressMutation({...goal,goalType:'maintain',targetWeightKg:null},today));
  assert.doesNotThrow(()=>validateProgressMutation({...goal,goalType:'attendance',startingWeightKg:null,measurementDate:null,targetWeightKg:null},today));
  for(const change of [{goalType:'lose',targetWeightKg:60},{goalType:'lose',targetWeightKg:65},{goalType:'gain',targetWeightKg:60},{goalType:'gain',targetWeightKg:55},{goalType:'maintain',targetWeightKg:65},{goalType:'attendance'},{startingWeightKg:null},{measurementDate:null},{measurementDate:'2026-10-11'},{startDate:'2026-10-18'},{measurementDate:'2026-02-30'}])assert.throws(()=>validateProgressMutation({...goal,...change},today));
});
test('health-aligned measurement precision and bounds reject strings, nonfinite and out-of-range values',()=>{
  for(const value of [10,60.1,500])assert.equal(validWeight(value),true);
  for(const value of [9.9,500.1,60.11,NaN,Infinity,-Infinity,'60',null,undefined]) {
    assert.equal(validWeight(value),false);assert.throws(()=>validateProgressMutation({action:'add_weight',date:today,weightKg:value},today));
  }
});
test('dated mutations require real nonfuture Manila dates and explicit update/delete identity',()=>{
  assert.equal(businessDate('2026-10-16T16:01:00Z'),today);
  assert.equal(businessDate('2026-10-16T15:59:00Z'),'2026-10-16');
  assert.doesNotThrow(()=>validateProgressMutation({action:'add_weight',date:today,weightKg:61},today));
  assert.doesNotThrow(()=>validateProgressMutation({action:'update_weight',id:requestId,date:today,weightKg:61.1},today));
  assert.doesNotThrow(()=>validateProgressMutation({action:'delete_weight',id:requestId},today));
  for(const date of ['2026-10-18','2026-02-29','today','2026-1-01','0000-01-01'])assert.throws(()=>validateProgressMutation({action:'add_weight',date,weightKg:61},today));
  for(const body of [{action:'update_weight',date:today,weightKg:61},{action:'delete_weight',id:'other'},{action:'add_weight',date:today,weightKg:61,replace:true}])assert.throws(()=>validateProgressMutation(body,today));
});
test('private identity/workspace overrides and incomplete requests are refused',()=>{
  for(const key of ['memberId','workspace','id','heightCm','conditions','bmi'])assert.throws(()=>validateProgressMutation({...goal,[key]:'private'},today));
  for(const body of [null,[],{}, {...goal,requestId:null},{...goal,goalId:'member'}, {...goal,goalType:'auto'}])assert.throws(()=>validateProgressMutation(body,today));
});
test('pause/resume and new-goal requests carry retry keys and expected current goal',()=>{
  for(const action of ['pause_goal','resume_goal'])assert.deepEqual(validateProgressMutation({action,goalId:requestId,requestId},today),{action,goalId:requestId,requestId});
  assert.equal(validateProgressMutation({...goal,action:'new_goal',goalId:requestId},today).action,'new_goal');
  assert.throws(()=>validateProgressMutation({action:'pause_goal',goalId:requestId},today));
});
test('empty and baseline-only states do not invent chart history or percentage',()=>{
  const empty=progressSummary(goal,[]);assert.equal(empty.latestWeightKg,null);assert.equal(empty.percentage,null);assert.equal(empty.hasChart,false);
  const baseline=progressSummary(goal,[{date:goal.measurementDate,weightKg:60}]);
  assert.equal(baseline.latestWeightKg,60);assert.equal(baseline.changeKg,0);assert.equal(baseline.percentage,null);assert.equal(baseline.hasChart,false);
});
test('gain/loss progress uses confirmed reference, dates and accurately clamped visual percentage',()=>{
  for(const [kind,target,weight,change,percentage] of [['gain',65,61,1,20],['gain',65,59,-1,0],['gain',65,67,7,100],['lose',55,59,-1,20],['lose',55,61,1,0],['lose',55,53,-7,100]]) {
    const actual=progressSummary({...goal,goalType:kind,targetWeightKg:target},[{date:today,weightKg:weight}]);
    assert.equal(actual.changeKg,change);assert.equal(actual.percentage,percentage);assert.equal(actual.latestWeightKg,weight);
  }
});
test('chart sorts actual records, excludes earlier goals and keeps reference snapshot independent',()=>{
  const result=progressSummary(goal,[{date:today,weightKg:61},{date:'2026-10-08',weightKg:80},{date:'2026-10-09',weightKg:60.2},{date:'bad',weightKg:62}]);
  assert.deepEqual(result.chart,[{date:'2026-10-09',weightKg:60.2},{date:today,weightKg:61}]);
  assert.equal(result.startingWeightKg,60);assert.equal(result.changeKg,1);assert.equal(result.hasChart,true);
  assert.equal(progressSummary({...goal,goalType:'maintain',targetWeightKg:null},[{date:today,weightKg:61}]).percentage,null);
  assert.equal(progressSummary({...goal,targetWeightKg:null},[{date:today,weightKg:61}]).percentage,null);
});
