import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHealth,bmiFor,exerciseGuidance,CONDITION_OPTIONS} from '../public/health-inputs.js';
import {createSampleWeek} from '../public/sample-week.js';
import {recommendPlans} from '../public/plan-recommender.js';

const empty = {heightCm:null,weightKg:null,ageBand:null,conditions:[]};
const health = changes => ({heightCm:175,weightKg:70,ageBand:'20plus',conditions:[],...changes});
const answers = {goal:'Improve fitness',experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri','sat']};

test('BMI uses kg/metres squared and displays a one-decimal estimate with adult categories only for confirmed age20+', () => {
  assert.deepEqual(bmiFor(health()),{value:22.9,category:'Healthy weight'});
  assert.deepEqual(bmiFor(health({heightCm:160,weightKg:80})),{value:31.3,category:'Obesity'});
  for (const ageBand of [null,'under20','prefer_not',undefined,'adult']) {
    assert.deepEqual(bmiFor(health({ageBand})),{value:22.9,category:null});
  }
  for (const [weightKg,category] of [[18.4,'Underweight'],[18.5,'Healthy weight'],[24.9,'Healthy weight'],[25,'Overweight'],[29.9,'Overweight'],[30,'Obesity']]) {
    assert.equal(bmiFor(health({heightCm:100,weightKg})).category,category);
  }
  assert.equal(bmiFor(health({heightCm:200,weightKg:99.9})).category,'Overweight','category matches rounded25.0 estimate');
});

test('missing and invalid measurements do not produce BMI; both optional measures can be cleared independently', () => {
  for (const change of [{heightCm:null},{weightKg:null},{heightCm:undefined},{weightKg:undefined},{heightCm:0},{heightCm:Infinity},{weightKg:NaN},{heightCm:'175'},{weightKg:-70},{heightCm:175.55}]) {
    assert.equal(bmiFor(health(change)),null);
  }
  assert.equal(bmiFor(null),null);
  assert.deepEqual(validateHealth(empty),empty);
  assert.deepEqual(validateHealth(health({weightKg:null})),health({weightKg:null}));
  for (const body of [null,{},[],{...empty,goal:'Improve fitness'},health({heightCm:49.9}),health({heightCm:250.1}),health({weightKg:9.9}),health({weightKg:500.1}),health({heightCm:'175'}),health({weightKg:70.01}),health({ageBand:'19'})]) {
    assert.throws(() => validateHealth(body));
  }
  assert.doesNotThrow(() => validateHealth(health({heightCm:50,weightKg:10})));
  assert.doesNotThrow(() => validateHealth(health({heightCm:250,weightKg:500})));
});

test('condition choices preserve unknown, declined and none-reported states, with exclusive special choices', () => {
  assert.equal(exerciseGuidance(null),'unknown');
  assert.equal(exerciseGuidance(empty),'unknown');
  assert.equal(exerciseGuidance(health({conditions:['prefer_not']})),'unknown');
  assert.equal(exerciseGuidance(health({conditions:['none']})),'none_reported');
  assert.deepEqual(validateHealth(health({conditions:['diabetes','asthma']})).conditions,['asthma','diabetes']);
  for (const conditions of [['none','asthma'],['prefer_not','diabetes'],['none','prefer_not'],['asthma','asthma'],['unknown'],null,'none']) {
    assert.throws(() => validateHealth(health({conditions})));
  }
});

test('every disclosed condition or limitation replaces generated exercises with professional guidance, without medical rules', () => {
  for (const [condition] of CONDITION_OPTIONS.slice(0,6)) {
    const saved = health({conditions:[condition]});
    assert.equal(exerciseGuidance(saved),'professional');
    assert.deepEqual(createSampleWeek(answers,saved),{status:'professional-guidance'});
    assert.equal(createSampleWeek(null,saved).status,'incomplete');
  }
  assert.equal(exerciseGuidance(health({conditions:['none','asthma']})),'professional','a malformed contradictory record must not suppress a disclosure');
});

test('BMI and health unknown/declined/none do not choose intensity, plan recommendation or no-coach eligibility', () => {
  const original = createSampleWeek(answers);
  for (const saved of [empty,health({heightCm:50,weightKg:500}),health({heightCm:250,weightKg:10}),health({conditions:['none']}),health({conditions:['prefer_not']})]) {
    assert.deepEqual(createSampleWeek(answers,saved),original);
  }
  const plans = [{id:'basic',priceCents:89900,coaching:'none',focusTags:['strength']},{id:'elite',priceCents:249900,coaching:'personal',focusTags:['strength']}];
  assert.deepEqual(recommendPlans({...answers,memberHealth:health({conditions:['heart_condition']})},plans),recommendPlans(answers,plans));
  const input = health({conditions:['diabetes','asthma']}), before = structuredClone(input);
  validateHealth(input);bmiFor(input);exerciseGuidance(input);createSampleWeek(answers,input);
  assert.deepEqual(input,before);
});
