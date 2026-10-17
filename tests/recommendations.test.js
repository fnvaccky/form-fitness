import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendPlans,recommendationInputs,RULE_VERSION} from '../public/plan-recommender.js';
// Task 12B: the plan recommendation rules, one by one and together. The database runs the same rules
// (ff_private.score_plans); tests/recommendations.js checks the two agree.
const catalog=[
 {id:'basic',name:'Essential',priceCents:89900,days:30,coaching:'none',coachSessions:0,focusTags:['strength','cardio'],available:true},
 {id:'plus',name:'Momentum',priceCents:149900,days:30,coaching:'group',coachSessions:0,focusTags:['cardio','mobility','group_classes'],available:true},
 {id:'elite',name:'Performance',priceCents:249900,days:30,coaching:'personal',coachSessions:4,focusTags:['strength','mobility'],available:true}];
const answers=(changes={})=>({goal:'Improve fitness',experience:'regular',exercises:['mobility'],availableDays:['mon','wed','fri'],...changes});
const rulesOf=(result,id)=>result.ranking.find(entry=>entry.id===id).rules.map(({rule,points})=>`${rule}:${points}`);
const points=(result,id)=>result.ranking.find(entry=>entry.id===id).score;

test('new to training or getting back into it: +2 for group coaching, +3 for a personal coach',()=>{
 for(const experience of ['beginner','returning']){
  const r=recommendPlans(answers({experience,exercises:['strength'],availableDays:['mon','tue','wed']}),catalog);
  assert.deepEqual(rulesOf(r,'plus'),['experience-coaching:2'],experience);
  assert.deepEqual(rulesOf(r,'elite'),['experience-coaching:3','preference-match:1'],experience);
  assert.deepEqual(rulesOf(r,'basic'),['preference-match:1'],experience);
 }
 assert.equal(recommendPlans(answers({experience:'beginner'}),catalog).reasons[0],'You’re new to training, and this plan includes a personal coach.');
 assert.equal(recommendPlans(answers({experience:'returning'}),catalog).reasons[0],'You’re getting back into training, and this plan includes a personal coach.');
});

test('trains regularly: +1 for a plan without a coach',()=>{
 const r=recommendPlans(answers({experience:'regular',exercises:['group_classes'],availableDays:['mon','tue','wed']}),catalog);
 assert.deepEqual(rulesOf(r,'basic'),['regular-no-coach:1']);
 assert.deepEqual(rulesOf(r,'elite'),[]);
});

test('goal Build strength: +2 for a strength focus and +1 more with a personal coach',()=>{
 const r=recommendPlans(answers({goal:'Build strength',exercises:['group_classes'],availableDays:['mon','tue','wed']}),catalog);
 assert.deepEqual(rulesOf(r,'basic'),['regular-no-coach:1','goal-strength-focus:2']);
 assert.deepEqual(rulesOf(r,'elite'),['goal-strength-focus:2','goal-strength-personal:1']);
 assert.deepEqual(rulesOf(r,'plus'),['preference-match:1']);
});

test('goal Manage weight: +2 for a cardio focus',()=>{
 const r=recommendPlans(answers({goal:'Manage weight',experience:'beginner',exercises:['mobility'],availableDays:['mon','tue','wed']}),catalog);
 assert.deepEqual(rulesOf(r,'basic'),['goal-weight-cardio:2']);
 assert.deepEqual(rulesOf(r,'plus'),['experience-coaching:2','goal-weight-cardio:2','preference-match:1']);
 assert.deepEqual(rulesOf(r,'elite'),['experience-coaching:3','preference-match:1']);
});

test('goal Stay consistent: +2 for group coaching; Improve fitness adds nothing',()=>{
 const consistent=recommendPlans(answers({goal:'Stay consistent',exercises:['strength'],availableDays:['mon','tue','wed']}),catalog);
 assert.deepEqual(rulesOf(consistent,'plus'),['goal-consistency-group:2']);
 const plain=recommendPlans(answers({goal:'Improve fitness',exercises:['strength'],availableDays:['mon','tue','wed']}),catalog);
 assert.equal(plain.ranking.flatMap(entry=>entry.rules).some(entry=>entry.rule.startsWith('goal-')),false);
});

test('each exercise preference a plan focuses on: +1, and a repeated preference counts once',()=>{
 const r=recommendPlans(answers({exercises:['strength','cardio','strength','yoga'],availableDays:['mon','tue','wed']}),catalog);
 const basic=r.ranking.find(entry=>entry.id==='basic').rules.find(entry=>entry.rule==='preference-match');
 assert.deepEqual(basic,{rule:'preference-match',points:2,matches:['strength','cardio']});
 assert.deepEqual(r.inputs.exercises,['strength','cardio'],'known answers only, each once, in their usual order');
 assert.equal(r.reasons.at(-1),'It matches your interest in strength training and cardio.');
 const three=recommendPlans(answers({experience:'beginner',exercises:['group_classes','cardio','mobility'],availableDays:['mon','tue','wed']}),catalog);
 assert.equal(three.reasons.at(-1),'It matches your interest in cardio, stretching and mobility and group classes.');
});

test('usually free 1–2 days: +1 for every plan at the lowest price; 5 or more days: +1 for group classes',()=>{
 const few=recommendPlans(answers({exercises:['group_classes'],availableDays:['sat','sun']}),catalog);
 assert.deepEqual(rulesOf(few,'basic'),['regular-no-coach:1','few-days-lowest-price:1']);
 const tied=[...catalog,{id:'lite',name:'Lite',priceCents:89900,coaching:'group',coachSessions:0,focusTags:[],available:true}];
 assert.deepEqual(rulesOf(recommendPlans(answers({exercises:['group_classes'],availableDays:['sat']}),tied),'lite'),['few-days-lowest-price:1'],'a tie at the lowest price scores both');
 const many=recommendPlans(answers({exercises:['strength'],availableDays:['mon','tue','wed','thu','fri']}),catalog);
 assert.deepEqual(rulesOf(many,'plus'),['many-days-group-classes:1']);
 const middle=recommendPlans(answers({exercises:['strength'],availableDays:['mon','tue','wed','thu']}),catalog);
 assert.equal(middle.ranking.flatMap(entry=>entry.rules).some(entry=>/days/.test(entry.rule)),false,'3 or 4 days: neither rule');
 assert.equal(recommendPlans(answers({availableDays:['mon','mon','tue']}),catalog).inputs.daysPerWeek,2,'a repeated day counts once');
});

test('rules add up; the reasons come only from the rules the suggested plan met',()=>{
 const r=recommendPlans({goal:'Build strength',experience:'beginner',exercises:['strength'],availableDays:['mon','thu']},catalog);
 assert.deepEqual(r.ranking.map(entry=>[entry.id,entry.score]),[['elite',7],['basic',4],['plus',2]]);
 assert.equal(r.recommended,'elite');assert.equal(r.status,'recommended');assert.equal(r.ruleVersion,RULE_VERSION);
 assert.deepEqual(r.reasons,['You’re new to training, and this plan includes a personal coach.','You want to build strength, and this plan focuses on strength.',
  'Its personal coach can help you build strength.','It matches your interest in strength training.']);
});

test('the goal comes from the profile and changes the suggestion',()=>{
 const survey={experience:'regular',exercises:['cardio'],availableDays:['mon','tue','wed']};
 assert.equal(recommendPlans({...survey,goal:'Build strength'},catalog).recommended,'basic');
 assert.equal(recommendPlans({...survey,goal:'Stay consistent'},catalog).recommended,'plus');
 assert.equal(recommendPlans(survey,catalog).status,'incomplete','without the profile goal there is no recommendation');
});

test('ties go to the lower price in centavos, then the plan ID',()=>{
 const twins=[{id:'beta',name:'Beta',priceCents:150000,coaching:'group',coachSessions:0,focusTags:[],available:true},
  {id:'alpha',name:'Alpha',priceCents:150000,coaching:'group',coachSessions:0,focusTags:[],available:true},
  {id:'gamma',name:'Gamma',priceCents:149950,coaching:'group',coachSessions:0,focusTags:[],available:true}];
 const r=recommendPlans(answers({experience:'beginner',exercises:['strength'],availableDays:['mon','tue','wed']}),twins);
 assert.deepEqual(r.ranking.map(entry=>[entry.id,entry.score,entry.priceCents]),[['gamma',2,149950],['alpha',2,150000],['beta',2,150000]]);
 assert.equal(r.recommended,'gamma','₱1,499.50 beats ₱1,500.00 on equal points');
});

test('no points anywhere: the lowest price wins, with an honest generic reason',()=>{
 const coached=catalog.map(plan=>({...plan,coaching:plan.coaching==='none'?'group':plan.coaching,focusTags:[]}));
 const r=recommendPlans(answers({experience:'regular',exercises:['strength'],availableDays:['mon','tue','wed']}),coached);
 assert.deepEqual(r.ranking.map(entry=>entry.score),[0,0,0]);
 assert.equal(r.recommended,'basic');
 assert.deepEqual(r.reasons,['None of your answers points to one plan in particular, so we suggest the plan with the lowest price.']);
});

test('an incomplete survey gets no recommendation and says what is missing; nothing is guessed',()=>{
 assert.deepEqual(recommendPlans(null,catalog),{status:'incomplete',ruleVersion:RULE_VERSION,missing:['goal','experience','exercises','availableDays'],recommended:null,ranking:[],reasons:[]});
 assert.deepEqual(recommendPlans(answers({experience:''}),catalog).missing,['experience']);
 assert.deepEqual(recommendPlans(answers({exercises:['yoga']}),catalog).missing,['exercises'],'unknown answers don\'t count');
 assert.deepEqual(recommendPlans(answers({availableDays:[]}),catalog).missing,['availableDays']);
 assert.deepEqual(recommendationInputs({goal:'Lose it all'}).missing,['goal','experience','exercises','availableDays']);
});

test('retired plans are never recommended; with none available there is no recommendation',()=>{
 const retired=catalog.map(plan=>plan.id==='elite'?{...plan,available:false}:plan);
 const r=recommendPlans({goal:'Build strength',experience:'beginner',exercises:['strength'],availableDays:['mon','thu']},retired);
 assert.equal(r.ranking.some(entry=>entry.id==='elite'),false);assert.equal(r.recommended,'basic');
 assert.deepEqual(recommendPlans(answers(),catalog.map(plan=>({...plan,available:false}))),
  {status:'no_plans',ruleVersion:RULE_VERSION,inputs:recommendPlans(answers(),catalog).inputs,recommended:null,ranking:[],reasons:[]});
 assert.equal(recommendPlans(answers(),[]).status,'no_plans');
});

test('a survey or catalog change changes the suggestion (nothing is cached)',()=>{
 const base={goal:'Improve fitness',experience:'regular',exercises:['cardio'],availableDays:['mon','tue','wed']};
 assert.equal(recommendPlans(base,catalog).recommended,'basic');
 // A beginner who likes cardio: Momentum 3 (group coaching, cardio) ties Performance 3 (personal coach); the cheaper wins.
 assert.equal(recommendPlans({...base,experience:'beginner'},catalog).recommended,'plus','the survey changed');
 const edited=catalog.map(plan=>plan.id==='elite'?{...plan,focusTags:['strength','cardio','mobility']}:plan);
 assert.equal(recommendPlans({...base,experience:'beginner'},edited).recommended,'elite','the catalog changed: Performance now focuses on cardio too');
});
