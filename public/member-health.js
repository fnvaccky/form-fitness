// Optional owner-only health fields share the fitness editor, but keep a separate private payload.
import {CONDITION_OPTIONS, validateHealth, bmiFor} from './health-inputs.js';

const emptyHealth = () => ({heightCm:null,weightKg:null,ageBand:null,conditions:[]});
const healthOwner = member => currentUser?.role === 'member' && currentUser.memberId === member?.id;

function bmiMarkup(health) {
  const bmi = bmiFor(health);
  if (!bmi) return '<p>Add an optional height and weight to see a BMI number.</p><p class="health-note">BMI is general information, not a diagnosis or medical clearance.</p>';
  const category = health.ageBand === '20plus' && bmi.category ? `<span class="health-bmi-category">Adult reference category: ${esc(bmi.category)}</span>` : '';
  const ageNote = health.ageBand === '20plus' ? '' : health.ageBand === 'under20'
    ? '<p class="health-note">BMI number only. Adult categories are not shown for members under 20.</p>'
    : '<p class="health-note">BMI number only. An adult category is shown only when you choose age 20 or over.</p>';
  return `<p><strong>BMI ${esc(bmi.value.toFixed(1))}</strong>${category}</p>${ageNote}<p class="health-note">BMI is general information, not a diagnosis or medical clearance. This rounded estimate does not measure fitness or describe your overall health.</p>`;
}

window.healthProfileValues = form => {
  const data = new FormData(form), optionalNumber = name => data.get(name) === '' ? null : Number(data.get(name));
  return {heightCm:optionalNumber('heightCm'),weightKg:optionalNumber('weightKg'),ageBand:data.get('ageBand') || null,conditions:data.getAll('conditions')};
};
window.healthProfileValidate = form => {
  const inputs = [...form.querySelectorAll('#member-health input, #member-health select')];
  if (inputs.some(input => !input.checkValidity())) throw Error('Check the optional measurements: height 50–250 cm and weight 10–500 kg, with up to one decimal place, or leave them blank.');
  return validateHealth(window.healthProfileValues(form));
};
window.healthProfileSaved = () => {
  const health = state.memberHealth || emptyHealth();
  return validateHealth({heightCm:health.heightCm,weightKg:health.weightKg,ageBand:health.ageBand,conditions:health.conditions});
};

window.memberHealthPanel = (member, editing = false, draftHealth = null) => {
  if (!healthOwner(member)) return '';
  const health = draftHealth || state.memberHealth || emptyHealth();
  const conditions = CONDITION_OPTIONS.map(([value,label]) => `<label class="survey-choice" for="health-${esc(value)}"><input id="health-${esc(value)}" name="conditions" type="checkbox" value="${esc(value)}" ${health.conditions.includes(value)?'checked':''}><span>${esc(label)}</span></label>`).join('');
  const fields = '<div id="member-health-error" class="survey-errors" role="alert" tabindex="-1" hidden></div><div class="form-grid">'
    +`<div class="field"><label for="health-height">Height (cm, optional)</label><input id="health-height" name="heightCm" type="number" inputmode="decimal" min="50" max="250" step="0.1" value="${esc(health.heightCm ?? '')}" aria-describedby="health-measurement-hint"></div>`
    +`<div class="field"><label for="health-weight">Weight (kg, optional)</label><input id="health-weight" name="weightKg" type="number" inputmode="decimal" min="10" max="500" step="0.1" value="${esc(health.weightKg ?? '')}" aria-describedby="health-measurement-hint"></div>`
    +`<div class="field"><label for="health-age-band">Age range (optional)</label><select id="health-age-band" name="ageBand"><option value="">Not provided</option>${[['under20','Under 20'],['20plus','20 or over'],['prefer_not','Prefer not to say']].map(([value,label])=>`<option value="${value}"${health.ageBand===value?' selected':''}>${label}</option>`).join('')}</select></div></div>`
    +'<p id="health-measurement-hint" class="health-note">Use centimetres and kilograms, with up to one decimal place. A BMI number needs both measurements. No date of birth is collected.</p>'
    +'<fieldset class="survey-question health-conditions"><legend>Anything that may affect exercise? (optional)</legend><p class="survey-hint">Choose any that apply. “None reported” and “Prefer not to answer” are each separate choices.</p>'
    +`<div class="survey-choices">${conditions}</div></fieldset>`
    +'<p class="health-note">A disclosed condition or limitation means the general sample week is replaced with a suggestion to ask a qualified professional for guidance. Leaving this unanswered or declining does not mean you are in good health.</p>'
    +'<div class="health-actions"><button type="button" class="button" data-health-clear>Clear health details</button></div><p class="health-note">Optional changes are applied with Save fitness profile. Clear health details changes this draft only.</p>';
  const summary = health.conditions.length ? health.conditions.map(value => CONDITION_OPTIONS.find(([key]) => key === value)?.[1]).filter(Boolean).join(', ') : 'Unknown or not provided';
  return '<section id="member-health" class="health-panel" aria-labelledby="member-health-title">'
    +'<div class="health-heading"><h3 id="member-health-title">Optional health details</h3><p>You can leave these blank, update them or clear them at any time.</p></div>'
    +'<p class="health-privacy">Private account details, used for optional BMI information and to decide whether the general sample week is appropriate. These details are not shown on gym staff screens. They do not provide medical clearance.</p>'
    +`<div id="member-health-bmi" class="health-bmi" aria-live="polite">${bmiMarkup(health)}</div>`
    +(editing ? `<div id="member-health-details" class="health-details">${fields}</div>` : `<p class="health-note">Reported exercise considerations: ${esc(summary)}. Use Edit answers to update your fitness profile and optional details together.</p>`)
    +'</section>';
};

function updateBmi(form) {
  const output = form.querySelector('#member-health-bmi');
  if (!output) return;
  try {
    output.innerHTML = bmiMarkup(window.healthProfileValidate(form));
  } catch {
    output.innerHTML = '<p>Enter a height from 50 to 250 cm and a weight from 10 to 500 kg, using up to one decimal place, or leave them blank.</p><p class="health-note">BMI is general information, not a diagnosis or medical clearance.</p>';
  }
}

document.addEventListener('change', event => {
  const input = event.target, form = input.closest('#member-survey-form');
  if (!form || !input.closest('#member-health')) return;
  if (input.name === 'conditions' && input.checked) {
    const exclusive = ['none','prefer_not'].includes(input.value);
    for (const checkbox of form.querySelectorAll('[name="conditions"]')) {
      if (checkbox !== input && (exclusive || ['none','prefer_not'].includes(checkbox.value))) checkbox.checked = false;
    }
  }
  updateBmi(form);
});

document.addEventListener('input', event => {
  const form = event.target.closest('#member-survey-form');
  if (form && event.target.closest('#member-health')) updateBmi(form);
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-health-clear]');
  if (!button) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const form = button.closest('#member-survey-form');
  if (!form || form.dataset.saving === 'true') return;
  for (const input of form.querySelectorAll('#member-health input, #member-health select')) {
    if (input.type === 'checkbox') input.checked = false;
    else input.value = '';
  }
  const error = form.querySelector('#member-health-error');
  error.hidden = true;
  updateBmi(form);
},true);
