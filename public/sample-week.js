// Optional, self-guided examples, not a coach-created program or a record of completed workouts.
// Exercise patterns follow the NHS's gentle strength examples; the conservative caps and gradual
// return follow CDC activity guidance. Doses below are product templates, not individual prescriptions.
// https://www.nhs.uk/live-well/exercise/strength-exercises/
// https://www.nhs.uk/Livewell/fitness/Pages/how-to-warm-up.aspx
// https://www.nhs.uk/live-well/exercise/how-to-stretch-after-exercising/
// https://www.cdc.gov/physical-activity-basics/adding-adults/index.html
// https://www.cdc.gov/physical-activity-basics/guidelines/adults.html
import {recommendationInputs} from './plan-recommender.js';
import {exerciseGuidance} from './health-inputs.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LEVELS = {
  beginner: {sets: 1, reps: '6–8', movementMinutes: 2, cardioMinutes: 8, cap: 2,
    why: 'You are new to training, so this starts with one easy set, short sessions and time between workouts.'},
  returning: {sets: 1, reps: '8–10', movementMinutes: 2, cardioMinutes: 10, cap: 2,
    why: 'You are returning to training, so this rebuilds gently with light, familiar movements and recovery time.'},
  regular: {sets: 2, reps: '8–12', movementMinutes: 4, cardioMinutes: 15, cap: 3,
    why: 'You train regularly, so this uses two controlled sets and a little more steady activity, with recovery time.'}
};
const PREFERENCE_LABELS = {strength: 'strength training', cardio: 'cardio', mobility: 'stretching and mobility', group_classes: 'group classes'};
const WARM_UP = [
  'Warm up for about 6 minutes: start with easy walking or marching, then gentle shoulder circles and comfortable practice movements.',
  'Use a stable chair or wall where needed. Choose a comfortable range and stop any movement that hurts.'
];
const COOL_DOWN = [
  'Cool down for about 5 minutes: slow your walking or marching, then stretch gently without bouncing or forcing a position.',
  'Keep the effort comfortable. Rest longer or do fewer repetitions if needed; ask gym staff to show unfamiliar movements.'
];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// A cycle invoice carries its frozen purchased terms in the existing authorized member response.
// Do not fall back to catalog/member terms or labels: they can be mutable or legacy defaults.
// Exactly one valid current cycle is required; an overlapping cycle is ambiguous even if only one is paid.
export function sampleWeekEligibility(member, invoices, today) {
  const excluded = reason => ({eligible:false,reason});
  if (member?.enabled !== true) return excluded('disabled');
  if (!member.id || !Array.isArray(invoices) || !validDate(today)) return excluded('unavailable');
  const own = invoices.filter(invoice => invoice?.memberId === member.id);
  const valid = own.filter(invoice => validDate(invoice.start) && validDate(invoice.end) && invoice.start <= invoice.end);
  const current = valid.filter(invoice => invoice.start <= today && today <= invoice.end);
  if (current.length > 1) return excluded('overlapping-cycles');
  if (!current.length) {
    if (own.length !== valid.length) return excluded('invalid-cycle');
    if (valid.some(invoice => invoice.start > today)) return excluded('upcoming');
    if (valid.some(invoice => invoice.end < today)) return excluded('expired');
    return excluded('no-current-cycle');
  }
  const invoice = current[0], terms = invoice.terms;
  if (!Number.isSafeInteger(invoice.amountCents) || invoice.amountCents <= 0
    || !Number.isSafeInteger(invoice.paidCents) || invoice.paidCents < 0) return excluded('invalid-payment');
  if (invoice.paidCents < invoice.amountCents) return excluded('unpaid');
  if (terms && !Array.isArray(terms) && terms.coaching === 'group') return excluded('group-coaching');
  if (terms && !Array.isArray(terms) && terms.coaching === 'personal') return excluded('personal-coaching');
  if (!terms || Array.isArray(terms) || terms.coaching !== 'none' || terms.coachSessions !== 0) return excluded('unclear-coaching');
  return {eligible:true,reason:'eligible'};
}

export function eligibleForSampleWeek(member, invoices, today) {
  return sampleWeekEligibility(member,invoices,today).eligible;
}

// Seven days make exhaustive selection small. Prefer the most workouts allowed, then even spacing,
// then the earlier weekdays. Circular gaps also prevent a Sunday/Monday pair in a repeated sample.
function trainingDays(available, cap) {
  let best = [], bestSpread = Infinity;
  for (let mask = 1; mask < 128; mask++) {
    const chosen = DAYS.map((_, index) => index).filter(index => mask & (1 << index));
    if (chosen.length > cap || chosen.some(index => !available.includes(DAYS[index]))) continue;
    const gaps = chosen.map((index, slot) => (chosen[(slot + 1) % chosen.length] - index + 7) % 7 || 7);
    if (chosen.length > 1 && gaps.some(gap => gap < 2)) continue;
    const spread = gaps.reduce((sum, gap) => sum + gap * gap, 0);
    if (chosen.length > best.length || (chosen.length === best.length && spread < bestSpread)) {
      best = chosen;
      bestSpread = spread;
    }
  }
  return best;
}

function trainingSession(inputs, slot) {
  const level = LEVELS[inputs.experience], dose = `${level.sets} ${level.sets === 1 ? 'set' : 'sets'} of ${level.reps} repetitions`;
  const exercises = [
    {name: 'Sit-to-stand', dose, instruction: 'From a stable chair, feet flat, lean forward slightly and stand slowly; sit back with control. Use your hands for support if needed.'},
    {name: 'Wall press-up', dose, instruction: 'Place hands on a wall at chest height, step back comfortably, bend your elbows toward the wall and press away slowly.'}
  ];
  const strength = inputs.exercises.includes('strength') || inputs.goal === 'Build strength';
  if (strength && slot % 2 === 0) {
    exercises.push({name: 'Seated light bottle curl', dose, instruction: 'Sit upright with elbows by your sides. Curl small water bottles slowly, then lower with control; use empty hands if easier.'});
  } else if (strength || !inputs.exercises.includes('mobility')) {
    exercises.push({name: 'Supported calf raise', dose, instruction: 'Hold a stable chair or wall, rise onto your toes slowly, then lower both heels with control.'});
  }
  if (inputs.exercises.includes('mobility')) {
    exercises.push({name: 'Gentle seated mobility', dose: '3 minutes', instruction: 'Sit tall and alternate slow ankle circles, heel-toe raises and shoulder circles. Keep each movement within a comfortable range.'});
  }
  const cardioMinutes = level.cardioMinutes + (inputs.goal === 'Manage weight' ? 2 : 0);
  if (inputs.exercises.includes('group_classes')) {
    exercises.push({name: 'Self-guided march and step-touch', dose: `${cardioMinutes} minutes`, instruction: 'Alternate easy marching with side-to-side step-touches at your own pace, with both feet staying close to the floor. This is a solo fallback, not a coached class or class booking.'});
  } else {
    exercises.push({name: inputs.exercises.includes('cardio') ? 'Easy walk or stationary cycle' : 'Easy walk', dose: `${cardioMinutes} minutes`,
      instruction: inputs.exercises.includes('cardio')
        ? 'Walk at a comfortable talking pace, or use an easy-resistance stationary cycle if familiar. Walking is the equipment-free fallback.'
        : 'Walk at a comfortable pace where you can talk. Slow down or take a break whenever needed.'});
  }
  const strengthCount = exercises.filter(exercise => exercise.dose.includes('repetitions')).length;
  const minutes = 6 + 5 + strengthCount * level.movementMinutes + (inputs.exercises.includes('mobility') ? 3 : 0) + cardioMinutes;
  return {title: inputs.goal === 'Build strength' ? 'Controlled strength and easy movement'
    : inputs.goal === 'Manage weight' ? 'Easy movement and steady cardio'
      : inputs.goal === 'Stay consistent' ? 'Repeatable full-body session' : 'Full-body movement basics',
  minutes, exercises, warmUp: [...WARM_UP], coolDown: [...COOL_DOWN]};
}

// Call with the saved survey plus the profile's goal, as for membership recommendations.
// No clock, network, storage or input mutation: the same known answers always produce the same sample.
export function createSampleWeek(answers, health = null) {
  const inputs = recommendationInputs(answers);
  if (inputs.missing.length) return {status: 'incomplete', missing: inputs.missing};
  if (exerciseGuidance(health) === 'professional') return {status: 'professional-guidance'};
  const selected = trainingDays(inputs.availableDays, LEVELS[inputs.experience].cap);
  let workout = 0, recovery = 0;
  const days = DAYS.map((id, index) => {
    const available = inputs.availableDays.includes(id), base = {id, label: LABELS[index], available};
    if (selected.includes(index)) return {...base, type: 'training', ...trainingSession(inputs, workout++)};
    if (available && recovery++ < 2) return {...base, type: 'recovery', title: 'Optional light recovery', minutes: 12,
      exercises: [{name: 'Easy walk and gentle mobility', dose: '10–15 minutes total', instruction: 'If comfortable, take a short easy walk and move your ankles and shoulders gently. Rest instead whenever you prefer.'}],
      warmUp: ['Begin slowly and keep the whole recovery session easy.'], coolDown: ['Slow down for the final minute; do not force stretches.']};
    return {...base, type: 'rest', title: available ? 'Rest — no workout scheduled' : 'Rest — not an available training day', minutes: 0,
      exercises: [], warmUp: [], coolDown: []};
  });
  const goalReason = {
    'Improve fitness': 'Your fitness goal is supported by a mix of simple strength movements and comfortable activity.',
    'Build strength': 'Your strength goal prioritizes controlled strength movements within the same weekly workout limit.',
    'Stay consistent': 'Your consistency goal uses a repeatable session and set days rather than adding extra workouts.',
    'Manage weight': 'Your weight-management goal adds a little steady activity within a short session.'
  }[inputs.goal];
  const preferenceReason = `Your interest in ${inputs.exercises.map(value => PREFERENCE_LABELS[value]).join(', ')} shapes the movements and easy-activity options.`;
  const why = [LEVELS[inputs.experience].why, goalReason, preferenceReason,
    `${selected.length} ${selected.length === 1 ? 'workout is' : 'workouts are'} placed only on your available weekdays. Other days are light recovery or rest; unavailable days are not missed workouts.`];
  if (inputs.exercises.includes('group_classes')) why.push('For your group-class preference, a simple solo circuit provides a self-guided alternative; no coached-class access is included or assumed.');
  return {status: 'ready', days, why, experience: inputs.experience, goal: inputs.goal};
}
