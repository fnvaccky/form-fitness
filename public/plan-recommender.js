// Task 12B: the membership-plan recommendation. Transparent, additive rules (no AI, no outside service): every
// available plan gets points from the member's answers, and the best total is suggested. It is only a suggestion:
// nothing is chosen, bought or priced by it. The same rules run in the database (ff_private.score_plans), which
// records what was recommended when a cycle is created; tests run both on the same answers and require identical
// results. Change the rules in both places together, and raise RULE_VERSION.
//
// Inputs: the profile's main goal (it lives on the profile, not in the survey) and the survey's experience,
// exercise preferences and usual days; and the plans as the catalog has them now (price in centavos, coaching,
// focus tags). Retired plans are never recommended.
//
// The rules, per plan:
//   new to training, or getting back into it   +2 group coaching, +3 personal coach
//   trains regularly                            +1 no coach
//   goal "Build strength"                       +2 strength focus, and +1 more with a personal coach
//   goal "Manage weight"                        +2 cardio focus
//   goal "Stay consistent"                      +2 group coaching
//   each exercise preference the plan focuses on   +1 (each preference counts once)
//   usually free 1–2 days a week                +1 for the plan(s) with the lowest price
//   usually free 5 or more days a week          +1 group classes focus
// "Improve fitness" adds nothing. Ranking: most points, then lowest price (centavos), then plan ID.
export const RULE_VERSION = '12B.1';
const GOALS = ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'];
const EXPERIENCE = ['beginner', 'returning', 'regular'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// Survey exercise answers and the plan focus tags they match (the stored values are the same words).
const PREFERENCE_FOCUS = {strength: 'strength', cardio: 'cardio', mobility: 'mobility', group_classes: 'group_classes'};
const PREFERENCE_LABEL = {strength: 'strength training', cardio: 'cardio', mobility: 'stretching and mobility', group_classes: 'group classes'};
const list = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const has = (values, value) => Array.isArray(values) && values.includes(value);

// The answers as the rules use them: known values only, each once, in their usual order; and what is missing.
export function recommendationInputs(answers) {
  const goal = GOALS.includes(answers?.goal) ? answers.goal : null;
  const experience = EXPERIENCE.includes(answers?.experience) ? answers.experience : null;
  const exercises = Object.keys(PREFERENCE_FOCUS).filter(value => has(answers?.exercises, value));
  const availableDays = DAYS.filter(day => has(answers?.availableDays, day));
  const missing = [!goal && 'goal', !experience && 'experience', !exercises.length && 'exercises', !availableDays.length && 'availableDays'].filter(Boolean);
  return {goal, experience, exercises, availableDays, daysPerWeek: availableDays.length, missing};
}

// The rules one plan meets, in a fixed order, each with its points.
function planRules(plan, inputs, lowestPrice) {
  const focus = plan.focusTags || [], rules = [];
  const add = (rule, points, extra = {}) => rules.push({rule, points, ...extra});
  if ((inputs.experience === 'beginner' || inputs.experience === 'returning') && plan.coaching === 'group') add('experience-coaching', 2);
  if ((inputs.experience === 'beginner' || inputs.experience === 'returning') && plan.coaching === 'personal') add('experience-coaching', 3);
  if (inputs.experience === 'regular' && plan.coaching === 'none') add('regular-no-coach', 1);
  if (inputs.goal === 'Build strength' && has(focus, 'strength')) add('goal-strength-focus', 2);
  if (inputs.goal === 'Build strength' && plan.coaching === 'personal') add('goal-strength-personal', 1);
  if (inputs.goal === 'Manage weight' && has(focus, 'cardio')) add('goal-weight-cardio', 2);
  if (inputs.goal === 'Stay consistent' && plan.coaching === 'group') add('goal-consistency-group', 2);
  const matches = inputs.exercises.filter(value => has(focus, PREFERENCE_FOCUS[value]));
  if (matches.length) add('preference-match', matches.length, {matches});
  if (inputs.daysPerWeek >= 1 && inputs.daysPerWeek <= 2 && plan.priceCents === lowestPrice) add('few-days-lowest-price', 1);
  if (inputs.daysPerWeek >= 5 && has(focus, 'group_classes')) add('many-days-group-classes', 1);
  return rules;
}

// Why the suggested plan fits, in plain words, from the rules it actually met.
function reasonFor(entry, inputs) {
  switch (entry.rule) {
    case 'experience-coaching': return `${inputs.experience === 'beginner' ? 'You’re new to training' : 'You’re getting back into training'}, and this plan includes ${entry.points === 3 ? 'a personal coach' : 'group coaching'}.`;
    case 'regular-no-coach': return 'You train regularly, so a plan without a coach can suit you.';
    case 'goal-strength-focus': return 'You want to build strength, and this plan focuses on strength.';
    case 'goal-strength-personal': return 'Its personal coach can help you build strength.';
    case 'goal-weight-cardio': return 'You want to manage your weight, and this plan focuses on cardio.';
    case 'goal-consistency-group': return 'You want to stay consistent, and group coaching helps with that.';
    case 'preference-match': return `It matches your interest in ${list(entry.matches.map(value => PREFERENCE_LABEL[value]))}.`;
    case 'few-days-lowest-price': return 'You’re usually free 1–2 days a week, and this plan has the lowest price.';
    case 'many-days-group-classes': return 'You’re usually free 5 or more days a week, and this plan includes group classes.';
  }
  return '';
}

// answers: {goal, experience, exercises, availableDays} (goal from the profile). plans: the catalog as the app has it.
// Returns {status, ruleVersion, inputs, recommended (plan ID or null), ranking: [{id, name, priceCents, coaching,
// coachSessions, focusTags, score, rules}], reasons, missing}. status is 'recommended', 'incomplete' (an answer is
// missing: ask for the survey, guess nothing) or 'no_plans' (no plan is available).
export function recommendPlans(answers, plans) {
  const inputs = recommendationInputs(answers), {missing, ...used} = inputs;
  if (missing.length) return {status: 'incomplete', ruleVersion: RULE_VERSION, missing, recommended: null, ranking: [], reasons: []};
  const open = (plans || []).filter(plan => plan && plan.available !== false);
  if (!open.length) return {status: 'no_plans', ruleVersion: RULE_VERSION, inputs: used, recommended: null, ranking: [], reasons: []};
  const lowestPrice = Math.min(...open.map(plan => plan.priceCents));
  const ranking = open.map(plan => {
    const rules = planRules(plan, inputs, lowestPrice);
    return {id: plan.id, name: plan.name, priceCents: plan.priceCents, coaching: plan.coaching, coachSessions: plan.coachSessions, focusTags: plan.focusTags || [],
      score: rules.reduce((total, entry) => total + entry.points, 0), rules};
  }).sort((a, b) => b.score - a.score || a.priceCents - b.priceCents || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const top = ranking[0];
  const reasons = top.score > 0 ? top.rules.map(entry => reasonFor(entry, inputs))
    : ['None of your answers points to one plan in particular, so we suggest the plan with the lowest price.'];
  return {status: 'recommended', ruleVersion: RULE_VERSION, inputs: used, recommended: top.id, ranking, reasons};
}

// In the browser, the app's recommendPlans hook (member-survey.js) uses this.
if (typeof window !== 'undefined') window.planRecommender = {recommendPlans, recommendationInputs, RULE_VERSION};
