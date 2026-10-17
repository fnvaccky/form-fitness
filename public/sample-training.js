// Optional, self-guided sample training from saved answers and explicit frozen purchased terms.
// No generated schedule is saved, and neither catalog edits nor this renderer change a purchase.
import {sampleWeekEligibility, createSampleWeek} from './sample-week.js';
import {exerciseGuidance} from './health-inputs.js';

const SAMPLE_NOTE = 'An optional sample week based on your survey answers. Adjust it to your comfort and ask gym staff for help with unfamiliar exercises.';
const TYPE_LABELS = {training:'Training',recovery:'Light recovery',rest:'Rest'};
const ELIGIBILITY_MESSAGES = {
  disabled:'Sample training is unavailable while this membership is disabled. Please ask reception if this is unexpected.',
  unavailable:'Your current purchased membership details could not be confirmed. Please ask reception to check them.',
  'invalid-cycle':'Your membership dates could not be confirmed. Please ask reception to check your existing membership record.',
  'overlapping-cycles':'More than one membership cycle covers today, so the current purchased terms are unclear. Please ask reception to check the overlapping dates.',
  upcoming:'Your upcoming membership has not started yet. Sample training requires a current, fully paid membership with purchased No coach benefits.',
  expired:'Your previous membership cycle has ended and no membership is current today. Sample training requires a current, fully paid No coach membership.',
  'no-current-cycle':'There is no current membership cycle to use for sample training. A current, fully paid No coach membership is required.',
  'invalid-payment':'The current invoice payment details could not be confirmed. Please ask reception to check the existing invoice.',
  unpaid:'The current membership invoice is not fully paid. Sample training is available after payment is recorded, if the purchased benefits include No coach.',
  'group-coaching':'Your current purchased membership includes group coaching. This self-guided sample week is limited to No coach memberships.',
  'personal-coaching':'Your current purchased membership includes personal coaching. This self-guided sample week is limited to No coach memberships.',
  'unclear-coaching':'Your current purchased coaching benefits are missing or unclear. Please ask reception to check the existing purchased terms.'
};

function sampleDay(day) {
  const preparation = (label, lines) => lines.length ? `<p class="sample-preparation"><strong>${label}:</strong> ${lines.map(esc).join(' ')}</p>` : '';
  return `<article class="sample-week-day ${day.type}" data-day="${esc(day.id)}"><div class="sample-day-heading"><h3>${esc(day.label)}</h3><span class="sample-day-type">${TYPE_LABELS[day.type]}</span></div>`
    +`<p class="sample-day-title">${esc(day.title)}</p>`
    +(day.minutes ? `<p class="sample-day-time">About ${day.minutes} min${day.type==='training'?', including warm-up and cool-down':''}.</p>` : '')
    +preparation('Warm-up',day.warmUp)
    +(day.exercises.length ? `<ol class="sample-exercises">${day.exercises.map(exercise => `<li><strong>${esc(exercise.name)}</strong><span class="sample-exercise-dose">${esc(exercise.dose)}</span><p>${esc(exercise.instruction)}</p></li>`).join('')}</ol>` : '')
    +preparation('Cool-down',day.coolDown)+'</article>';
}

// Called beside the saved survey on each My membership render, including after a successful save.
// Survey edit/cancel replaces only its own panel, so it cannot duplicate the adjacent sample section.
window.sampleTrainingPanel = member => {
  if (currentUser?.role !== 'member' || currentUser.memberId !== member?.id) return '';
  const eligibility = sampleWeekEligibility(member,state.invoices,DEMO_DATE);
  const healthSavePending = window.fitnessProfileSaveState?.memberId === member.id && window.fitnessProfileSaveState.healthFailed;
  const sample = eligibility.eligible && !healthSavePending ? createSampleWeek(recommendationAnswers(member),state.memberHealth) : null;
  const healthNote = exerciseGuidance(state.memberHealth) === 'unknown'
    ? '<p class="survey-note">Health information is unknown or declined. This general sample does not assess medical suitability or confirm that exercise is safe for you.</p>'
    : '<p class="survey-note">None reported is self-reported information, not medical clearance. This sample does not assess medical suitability.</p>';
  const content = !eligibility.eligible
    ? `<p class="survey-note" data-sample-exclusion="${esc(eligibility.reason)}">${esc(ELIGIBILITY_MESSAGES[eligibility.reason])}</p>`
    : healthSavePending
    ? '<div class="notice" role="note"><strong>Optional health details need to be saved</strong><p>Review the health save error and retry Save fitness profile. Exercise cards are paused until the save succeeds or you cancel your unsaved changes.</p></div>'
    : sample.status === 'professional-guidance'
    ? '<div class="notice" role="note"><strong>Professional guidance recommended</strong><p>Before using a sample routine, ask a qualified healthcare professional which activities and intensity are suitable for you. A qualified coach can then help you follow that advice. This app does not tailor exercise for health conditions.</p><p>This affects automated exercise suggestions only. Your membership access and renewal controls stay available.</p></div>'
    : sample.status === 'incomplete'
    ? '<p class="survey-note">Complete your fitness profile to see an optional sample week.</p><button class="button small" data-action="survey-open">Complete fitness profile</button>'
    : healthNote+`<ul class="sample-training-fit">${sample.why.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><div class="sample-week-grid">${sample.days.map(sampleDay).join('')}</div>`;
  return '<section id="sample-training" class="panel sample-training" aria-labelledby="sample-training-title">'
    +'<div class="panel-header"><div><h2 id="sample-training-title">Suggested training — sample week</h2><p>Based on your current purchased benefits and saved fitness profile.</p></div></div>'
    +`<div class="sample-training-body"><p class="sample-training-note">${SAMPLE_NOTE}</p>`
    +'<p class="sample-training-boundary">General self-guided guidance. Coach-created personalized workouts are a separate purchased benefit.</p>'
    +content+'</div></section>';
};
