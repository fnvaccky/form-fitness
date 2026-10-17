// Optional, self-guided sample training from saved answers and explicit frozen purchased terms.
// No generated schedule is saved, and neither catalog edits nor this renderer change a purchase.
import {eligibleForSampleWeek, createSampleWeek} from './sample-week.js';

const SAMPLE_NOTE = 'An optional sample week based on your survey answers. Adjust it to your comfort and ask gym staff for help with unfamiliar exercises.';
const TYPE_LABELS = {training:'Training',recovery:'Light recovery',rest:'Rest'};

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
  if (currentUser?.role !== 'member' || currentUser.memberId !== member?.id || !eligibleForSampleWeek(member,state.invoices,DEMO_DATE)) return '';
  const sample = createSampleWeek(recommendationAnswers(member));
  const content = sample.status === 'incomplete'
    ? '<p class="survey-note">Complete your fitness profile to see an optional sample week.</p><button class="button small" data-action="survey-open">Complete fitness profile</button>'
    : `<ul class="sample-training-fit">${sample.why.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><div class="sample-week-grid">${sample.days.map(sampleDay).join('')}</div>`;
  return '<section id="sample-training" class="panel sample-training" aria-labelledby="sample-training-title">'
    +'<div class="panel-header"><div><h2 id="sample-training-title">Suggested training — sample week</h2><p>Optional guidance for your self-guided membership.</p></div></div>'
    +`<div class="sample-training-body"><p class="sample-training-note">${SAMPLE_NOTE}</p>`
    +'<p class="sample-training-boundary">General self-guided guidance. Coach-created personalized workouts are a separate purchased benefit.</p>'
    +content+'</div></section>';
};
