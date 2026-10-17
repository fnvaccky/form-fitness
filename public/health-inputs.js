// Optional self-reported information. No diagnosis, clearance, risk score or intensity decision.
// Numeric bounds/precision are input sanity limits, not clinical thresholds.
export const CONDITION_OPTIONS = [
  ['asthma', 'Asthma'], ['heart_condition', 'Heart condition'],
  ['high_blood_pressure', 'High blood pressure'], ['diabetes', 'Diabetes'],
  ['injury_limitation', 'Injury or movement limitation'], ['other', 'Other'],
  ['none', 'None reported'], ['prefer_not', 'Prefer not to answer']
];
const AGE_BANDS = ['under20', '20plus', 'prefer_not'];
const KEYS = ['heightCm', 'weightKg', 'ageBand', 'conditions'];
const measurement = (value, min, max) => value === null || (typeof value === 'number'
  && Number.isFinite(value) && value >= min && value <= max
  && Math.abs(value * 10 - Math.round(value * 10)) < 1e-7);

// A replacement contains every optional field; explicit nulls/[] clear it. Required fitness answers
// live elsewhere and cannot be changed by this payload. Keep aligned with ff_save_member_health.
export function validateHealth(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(body,key))) {
    throw Error('Send only the four optional health fields.');
  }
  if (!measurement(body.heightCm,50,250)) throw Error('Enter a height from 50 to 250 cm, with at most one decimal place, or leave it blank.');
  if (!measurement(body.weightKg,10,500)) throw Error('Enter a weight from 10 to 500 kg, with at most one decimal place, or leave it blank.');
  if (body.ageBand !== null && !AGE_BANDS.includes(body.ageBand)) throw Error('Choose a BMI age group or leave it unanswered.');
  const conditions = body.conditions, allowed = CONDITION_OPTIONS.map(([key]) => key);
  if (!Array.isArray(conditions) || conditions.length > allowed.length
    || new Set(conditions).size !== conditions.length || conditions.some(key => !allowed.includes(key))
    || (conditions.length > 1 && conditions.some(key => key === 'none' || key === 'prefer_not'))) {
    throw Error('Choose conditions, None reported, Prefer not to answer, or leave them unanswered.');
  }
  return {heightCm:body.heightCm,weightKg:body.weightKg,ageBand:body.ageBand,
    conditions:allowed.filter(key => conditions.includes(key))};
}

// CDC adult categories apply from age 20. Under-20 interpretation needs age/sex percentiles,
// which this feature does not collect or implement. Categorize the displayed rounded estimate.
// https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html
// https://www.cdc.gov/bmi/child-teen-calculator/
export function bmiFor(health) {
  if (!health || health.heightCm === null || health.weightKg === null
    || !measurement(health.heightCm,50,250) || !measurement(health.weightKg,10,500)) return null;
  const value = Math.round(health.weightKg * 10000 / health.heightCm ** 2 * 10) / 10;
  const category = health.ageBand !== '20plus' ? null
    : value < 18.5 ? 'Underweight' : value < 25 ? 'Healthy weight' : value < 30 ? 'Overweight' : 'Obesity';
  return {value,category};
}

// Unknown/declined is never evidence of good health. A disclosed condition or limitation gets
// professional guidance rather than an unreviewed condition-specific exercise prescription.
export function exerciseGuidance(health) {
  const conditions = health?.conditions;
  if (Array.isArray(conditions) && CONDITION_OPTIONS.slice(0,6).some(([key]) => conditions.includes(key))) return 'professional';
  return Array.isArray(conditions) && conditions.length === 1 && conditions[0] === 'none' ? 'none_reported' : 'unknown';
}
