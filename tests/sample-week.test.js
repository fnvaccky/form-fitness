import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleForSampleWeek, createSampleWeek} from '../public/sample-week.js';

const TODAY = '2026-10-17';
const member = {id: 'existing-member', enabled: true, plan: 'basic', terms: {coaching: 'none', coachSessions: 0}};
const invoice = (changes = {}) => ({id: 'current', memberId: member.id, start: '2026-10-01', end: '2026-10-30',
  amountCents: 89900, paidCents: 89900, terms: {planName: 'Essential', coaching: 'none', coachSessions: 0}, ...changes});
const answers = (changes = {}) => ({goal: 'Improve fitness', experience: 'beginner', exercises: ['strength'], availableDays: ['mon', 'wed', 'fri', 'sat'], ...changes});
const workouts = result => result.days.filter(day => day.type === 'training');
const names = result => workouts(result).flatMap(day => day.exercises.map(exercise => exercise.name));

test('eligibility uses only the paid current invoice frozen terms after a catalog rename/coaching edit', () => {
  const cycle = invoice(), changedCatalogMember = {...member, plan: 'new-name', terms: {name: 'Premium', coaching: 'personal', coachSessions: 9}};
  assert.equal(eligibleForSampleWeek(changedCatalogMember, [cycle], TODAY), true);
  assert.equal(eligibleForSampleWeek({...changedCatalogMember, terms: {coaching: 'none', coachSessions: 0}}, [invoice({terms: {coaching: 'group', coachSessions: 0}})], TODAY), false);
  assert.equal(eligibleForSampleWeek(member, [invoice({terms: {coaching: 'personal', coachSessions: 4}})], TODAY), false);
  assert.equal(eligibleForSampleWeek(member, [invoice({terms: {coaching: 'none', coachSessions: 1}})], TODAY), false);
});

test('current terms win over upcoming terms in either direction; upcoming-only never grants access', () => {
  const upcoming = invoice({id: 'next', start: '2026-10-31', end: '2026-11-29', terms: {coaching: 'personal', coachSessions: 4}});
  assert.equal(eligibleForSampleWeek(member, [upcoming, invoice()], TODAY), true);
  assert.equal(eligibleForSampleWeek(member, [invoice({terms: {coaching: 'group', coachSessions: 0}}), {...upcoming, terms: {coaching: 'none', coachSessions: 0}}], TODAY), false);
  assert.equal(eligibleForSampleWeek(member, [{...upcoming, terms: {coaching: 'none', coachSessions: 0}}], TODAY), false);
  assert.equal(eligibleForSampleWeek(member, [invoice()], '2026-10-01'), true);
  assert.equal(eligibleForSampleWeek(member, [invoice()], '2026-10-30'), true);
});

test('missing, legacy-label, unknown and inconsistent coaching terms never assume No coach', () => {
  for (const terms of [null, undefined, {}, {coachingLabel: 'No coach'}, {coaching: 'none'}, {coachSessions: 0}, {coaching: 'No coach', coachSessions: 0}, {coaching: 'unknown', coachSessions: 0}, {coaching: 'none', coachSessions: '0'}, []]) {
    assert.equal(eligibleForSampleWeek(member, [invoice({terms})], TODAY), false, JSON.stringify(terms));
  }
});

test('disabled, unpaid, expired, malformed and overlapping current cycles stay excluded', () => {
  assert.equal(eligibleForSampleWeek({...member, enabled: false}, [invoice()], TODAY), false);
  assert.equal(eligibleForSampleWeek({...member, enabled: 'true'}, [invoice()], TODAY), false);
  assert.equal(eligibleForSampleWeek({}, [invoice()], TODAY), false);
  for (const change of [{paidCents: 89899}, {paidCents: '89900'}, {amountCents: '89900'}, {amountCents: 0}, {amountCents: -1}, {amountCents: 89900.5}, {paidCents: Infinity}, {memberId: 'other'}, {end: '2026-10-16'}, {start: '2026-10-18'}, {start: '2026-02-30'}, {end: null}]) {
    assert.equal(eligibleForSampleWeek(member, [invoice(change)], TODAY), false, JSON.stringify(change));
  }
  assert.equal(eligibleForSampleWeek(member, [invoice(), invoice({id: 'overlap', paidCents: 0})], TODAY), false);
  assert.equal(eligibleForSampleWeek(member, [invoice()], '2026-02-30'), false);
  assert.equal(eligibleForSampleWeek(member, null, TODAY), false);
});

test('incomplete or malformed saved answers ask for the missing answers without fabricating a week', () => {
  assert.deepEqual(createSampleWeek(null), {status: 'incomplete', missing: ['goal', 'experience', 'exercises', 'availableDays']});
  for (const [field, value] of [['goal', 'unknown'], ['experience', 'expert'], ['exercises', ['unknown']], ['availableDays', ['monday']], ['exercises', 'strength'], ['availableDays', []]]) {
    assert.deepEqual(createSampleWeek(answers({[field]: value})), {status: 'incomplete', missing: [field]});
  }
  assert.equal(createSampleWeek(answers({goal: undefined})).status, 'incomplete', 'the profile goal must be merged explicitly');
});

test('beginner, gradual-return and regular templates have appropriate distinct doses and caps', () => {
  const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const beginner = createSampleWeek(answers({availableDays: all})), returning = createSampleWeek(answers({experience: 'returning', availableDays: all}));
  const regular = createSampleWeek(answers({experience: 'regular', availableDays: all}));
  assert.equal(workouts(beginner).length, 2);
  assert.equal(workouts(returning).length, 2);
  assert.equal(workouts(regular).length, 3);
  assert.match(workouts(beginner)[0].exercises[0].dose, /^1 set of 6–8/);
  assert.match(workouts(returning)[0].exercises[0].dose, /^1 set of 8–10/);
  assert.match(workouts(regular)[0].exercises[0].dose, /^2 sets of 8–12/);
  assert.ok(workouts(beginner)[0].minutes < workouts(returning)[0].minutes);
  assert.ok(workouts(returning)[0].minutes < workouts(regular)[0].minutes);
  for (const result of [beginner, returning, regular]) {
    assert.ok(result.days.some(day => day.type === 'rest'));
    assert.ok(result.days.some(day => day.type === 'recovery'));
    for (const day of workouts(result)) {
      assert.ok(day.warmUp.length && day.coolDown.length);
      assert.ok(day.minutes >= 20 && day.minutes <= 45);
      assert.ok(day.exercises.every(exercise => exercise.name && exercise.dose && exercise.instruction));
    }
  }
});

test('every availability pattern keeps workouts on selected days and avoids adjacent training across Sunday/Monday', () => {
  const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const experience of ['beginner', 'returning', 'regular']) for (let mask = 1; mask < 128; mask++) {
    const availableDays = all.filter((_, index) => mask & (1 << index));
    const result = createSampleWeek(answers({experience, availableDays}));
    assert.deepEqual(result.days.map(day => day.id), all);
    assert.deepEqual(result.days.map(day => day.label), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    const active = workouts(result);
    assert.ok(active.length >= 1 && active.length <= (experience === 'regular' ? 3 : 2));
    for (let index = 0; index < 7; index++) {
      const day = result.days[index];
      assert.equal(day.available, availableDays.includes(day.id));
      if (!day.available) {
        assert.equal(day.type, 'rest'); assert.equal(day.minutes, 0); assert.deepEqual(day.exercises, []);
        assert.match(day.title, /not an available training day/);
      }
      if (day.type === 'training') assert.notEqual(result.days[(index + 1) % 7].type, 'training');
    }
  }
  const adjacent = createSampleWeek(answers({availableDays: ['sun', 'mon']}));
  assert.equal(workouts(adjacent).length, 1);
});

test('preferences, familiarity and profile goal meaningfully shape the sample with understandable fallbacks', () => {
  const strength = createSampleWeek(answers()), cardio = createSampleWeek(answers({exercises: ['cardio']}));
  const mobility = createSampleWeek(answers({exercises: ['mobility']})), group = createSampleWeek(answers({exercises: ['group_classes']}));
  assert.ok(names(strength).includes('Seated light bottle curl'));
  assert.ok(names(cardio).includes('Easy walk or stationary cycle'));
  assert.ok(names(mobility).includes('Gentle seated mobility'));
  assert.ok(names(group).includes('Self-guided march and step-touch'));
  assert.match(group.why.join(' '), /solo circuit.*no coached-class access/);
  assert.match(workouts(group)[0].exercises.at(-1).instruction, /not a coached class or class booking/);
  const build = createSampleWeek(answers({goal: 'Build strength', exercises: ['mobility']}));
  assert.ok(names(build).includes('Seated light bottle curl'));
  const oneDayStrength = createSampleWeek(answers({availableDays: ['mon']}));
  const oneDayMobility = createSampleWeek(answers({exercises: ['mobility'], availableDays: ['mon']}));
  const oneDayBuild = createSampleWeek(answers({goal: 'Build strength', exercises: ['mobility'], availableDays: ['mon']}));
  assert.ok(names(oneDayStrength).includes('Seated light bottle curl'), 'strength affects even a single available day');
  assert.equal(names(oneDayMobility).includes('Seated light bottle curl'), false);
  assert.ok(names(oneDayBuild).includes('Seated light bottle curl'), 'profile strength goal affects even a single available day');
  const weight = createSampleWeek(answers({goal: 'Manage weight', exercises: ['cardio']}));
  assert.equal(workouts(weight)[0].minutes, workouts(cardio)[0].minutes + 2);
  assert.match(weight.why.join(' '), /weight-management goal/);
  const consistent = createSampleWeek(answers({goal: 'Stay consistent'}));
  assert.match(workouts(consistent)[0].title, /Repeatable/);
  assert.notDeepEqual(strength, cardio);
});

test('the scheduling function is deterministic and leaves saved answers and frozen terms unchanged', () => {
  const input = answers({exercises: ['mobility', 'strength', 'strength'], availableDays: ['sat', 'mon', 'wed', 'mon']}), before = structuredClone(input);
  const a = createSampleWeek(input), b = createSampleWeek(input);
  assert.deepEqual(a, b); assert.deepEqual(input, before);
  assert.deepEqual(a, createSampleWeek(answers({exercises: ['strength', 'mobility'], availableDays: ['mon', 'wed', 'sat']})));
  const cycle = invoice(), prior = structuredClone(cycle);
  eligibleForSampleWeek(member, [cycle], TODAY);
  assert.deepEqual(cycle, prior);
});
