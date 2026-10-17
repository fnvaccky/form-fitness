'use strict';
// Task 12B: show the plan recommendation, a "Recommended for you" badge and the reasons, wherever a plan is chosen:
// - the member's plan cards: straight after the first-login survey (plan selection) and under My membership;
// - the staff's Walk-in renewal plan picker, for the member being renewed;
// - Add member, once the desk survey is complete (until then, a note asks for it).
// It is only a suggestion from the rules in plan-recommender.js: nothing is preselected, bought, invoiced or repriced,
// and every available plan stays selectable. It always uses the catalog as it is now and the latest answers. The
// database records what it recommended when a cycle is created; this file only renders.
const RECOMMENDED_TAG = '<span class="tag recommended">Recommended for you</span>';
function recommendationBlock(suggestion, footnote) {
  const plan = plans.find(p => p.id === suggestion?.recommended);
  if (!plan) return '';
  return `<div class="plan-recommendation" role="note" aria-label="Recommended plan"><div class="plan-recommendation-head">${RECOMMENDED_TAG}<strong>${esc(plan.name)}</strong><span>${money(plan.price)} / ${plan.days||30} days · ${esc(plan.coachingLabel||'No coach')}</span></div>`
    +`<ul class="plan-recommendation-reasons">${suggestion.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><p class="plan-recommendation-note">${esc(footnote)}</p></div>`;
}
const firstName = member => esc(member.name.split(' ')[0]);

// Plan cards on the member's side: the badge on the suggested plan's card, and the reasons above the cards.
{
  const recommendationBaseCards = planCards;
  planCards = function() {
    const html = recommendationBaseCards(), member = mode === 'member' ? memberById(selectedMember) : null;
    if (!member || !html.includes('<section class="plans-grid"')) return html;
    const suggestion = recommendPlans(recommendationAnswers(member), plans), own = currentUser?.role === 'member';
    if (suggestion?.status === 'incomplete') {
      const ask = own ? '<p>Complete your fitness profile to see which plan suits you best.</p><button class="button small" data-action="survey-open">Complete fitness profile</button>'
        : '<p>No recommendation yet: this member’s fitness survey isn’t complete.</p>';
      return html.replace('<section class="plans-grid"', `<div class="plan-recommendation incomplete" role="note">${ask}</div><section class="plans-grid"`);
    }
    if (suggestion?.status !== 'recommended') return html;
    const marked = html.replace(/<article class="plan-card([^"]*)">([\s\S]*?)<\/article>/g, (card, cls, inner) =>
      inner.includes(`data-plan="${esc(suggestion.recommended)}"`) ? `<article class="plan-card${cls} recommended-plan">${inner.replace(/(<div class="plan-kicker">[\s\S]*?)<\/div>/, `$1${RECOMMENDED_TAG}</div>`)}</article>` : card);
    const footnote = own ? 'A suggestion from your fitness profile. Every plan below stays open to you; nothing is chosen until you pick one.'
      : `A suggestion from ${member.name.split(' ')[0]}’s fitness survey. Every plan stays open to them.`;
    return marked.replace('<section class="plans-grid"', recommendationBlock(suggestion, footnote) + '<section class="plans-grid"');
  };
}

// Walk-in renewal (staff): the suggestion for the member being renewed, under the plan picker. The picker keeps its
// own default (the member's current plan); the suggestion selects nothing.
{
  const recommendationBaseWalkin = walkinRenew;
  walkinRenew = function(id) {
    recommendationBaseWalkin(id);
    const memberSelect = document.getElementById('walkin-member'), planField = document.getElementById('walkin-plan')?.closest('.field');
    if (!memberSelect || !planField) return;
    planField.insertAdjacentHTML('afterend', '<div id="walkin-recommendation" class="recommendation-slot" aria-live="polite"></div>');
    const update = () => {
      const member = memberById(memberSelect.value), slot = document.getElementById('walkin-recommendation');
      if (!member || !slot) return;
      const suggestion = recommendPlans(recommendationAnswers(member), plans);
      slot.innerHTML = suggestion?.status === 'recommended' ? recommendationBlock(suggestion, `A suggestion from ${member.name.split(' ')[0]}’s fitness survey. Any plan can be chosen.`)
        : suggestion?.status === 'incomplete' ? `<p class="recommendation-hint">No recommendation yet: ${firstName(member)} hasn’t completed the fitness survey.</p>` : '';
    };
    memberSelect.addEventListener('change', update); update();
  };
}

// Add member: once staff have filled in the whole desk survey, the suggestion appears under the plan field. The plan
// stays at "No plan yet" unless staff choose one.
function deskAnswersSoFar() {
  const section = document.getElementById('desk-survey');
  if (!section) return null;
  const value = id => document.getElementById(id)?.value || '', checked = name => [...section.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
  return {goal: value('desk-goal'), experience: value('desk-experience'), exercises: checked('exercises'), availableDays: checked('availableDays')};
}
{
  const recommendationBaseRegister = register;
  register = function(...args) {
    recommendationBaseRegister(...args);
    const form = document.getElementById('member-create-form'), planField = document.getElementById('member-plan')?.closest('.field');
    if (!form || !planField) return;
    planField.insertAdjacentHTML('afterend', '<div id="desk-recommendation" class="field full recommendation-slot" aria-live="polite"></div>');
    const update = () => {
      const slot = document.getElementById('desk-recommendation'), suggestion = recommendPlans(deskAnswersSoFar(), plans);
      if (!slot) return;
      slot.innerHTML = suggestion?.status === 'recommended' ? recommendationBlock(suggestion, 'A suggestion from the fitness survey above. Any plan can be chosen, or none yet.')
        : suggestion?.status === 'incomplete' ? '<p class="recommendation-hint">Fill in the whole fitness survey below to see a recommended plan.</p>' : '';
    };
    form.addEventListener('input', update); form.addEventListener('change', update); update();
  };
}
