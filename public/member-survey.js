'use strict';
// Task 11: the member fitness survey, required at first login. Ported from a classmate's survey work
// (fitness-survey-update.zip): the four questions, the form with its checks, error summary and focus handling,
// editing and cancelling, and the staff's read-only view. New here:
// - a member without a survey and without a paid current or upcoming cycle (a new account) sees only the survey
//   after signing in (no skip; Sign out stays). A paid member isn't stopped: a card on the overview and My membership
//   asks for it, and the renew screen explains that choosing the next plan waits for it;
// - staff can fill it in at the desk during Add member;
// - members edit it under My membership → "Your fitness profile";
// - recommendPlans, the hook Task 12 fills in.
// The server and database decide (the API refuses plan selection and online checkout until the survey is
// saved); this file only renders.
const surveyOptions = {
  goals: ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'],
  experience: [['beginner', 'I’m new to training'], ['returning', 'I’m getting back into it'], ['regular', 'I train regularly']],
  exercises: [['strength', 'Strength training'], ['cardio', 'Cardio'], ['mobility', 'Stretching & mobility'], ['group_classes', 'Group classes']],
  days: [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']]
};
const surveyLabel = (options, value) => options.find(([key]) => key === value)?.[1] || 'Not provided';
// Shown once on plan selection, straight after the first save.
let surveyThanks = false;
let fitnessProfileSavingMember = null;
let fitnessProfilePendingDraft = null;
// A fully paid cycle that is current or still to come: such a member keeps using the app while the survey waits.
const hasPaidCycle = member => state.invoices.some(i => i.memberId === member.id && i.paidCents >= i.amountCents && i.end >= DEMO_DATE);
const surveyCard = () => '<section class="panel survey-card" aria-label="Fitness profile"><p><strong>Complete your fitness profile</strong> — it takes a minute and helps us recommend the right plan.</p><button class="button primary" data-action="survey-open">Complete fitness profile</button></section>';
// The card goes at the top of the page, before the first of these that the page has.
const withSurveyCard = (html, markers) => { const marker = markers.find(m => html.includes(m)); return marker ? html.replace(marker, surveyCard() + marker) : surveyCard() + html; };
const ownMemberWithoutSurvey = () => { const member = currentUser?.role === 'member' ? memberById(currentUser.memberId) : null; return member && !member.survey ? member : null; };

// Task 12B: the plan recommendation for these answers and plans (rules in public/plan-recommender.js): the suggested
// plan, the ranked rest, the reasons and the points behind them. null until the recommender has loaded.
function recommendPlans(survey, plans) {
  return window.planRecommender ? window.planRecommender.recommendPlans(survey, plans) : null;
}
// A member's answers for it: the survey, plus the main goal, which lives on the profile rather than in the survey.
const recommendationAnswers = member => member ? {...(member.survey || {}), goal: member.goal} : null;

function surveySummary(member) {
  const survey = member.survey;
  if (!survey) return '<p class="survey-note">No survey answers yet. The member is asked for them when they next sign in.</p>';
  const answers = [
    ['Main goal', member.goal],
    ['Training experience', surveyLabel(surveyOptions.experience, survey.experience)],
    ['Exercise preferences', survey.exercises.map(value => surveyLabel(surveyOptions.exercises, value)).join(', ')],
    ['Usually available', survey.availableDays.map(value => surveyLabel(surveyOptions.days, value)).join(', ')]
  ];
  return `<dl class="survey-summary">${answers.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p class="survey-note">Answers last saved ${date(survey.updatedAt.slice(0,10))}. The main goal stays in sync with the member profile.</p>`;
}

// The four questions. The desk copy (prefix "desk") is optional, so its fields are not required.
function surveyQuestions(member, prefix = 'survey') {
  const saved = member?.survey, required = prefix === 'desk' ? '' : 'required';
  const checks = (name, options, selected = []) => options.map(([value,label])=>`<label class="survey-choice" for="${prefix}-${value}"><input id="${prefix}-${value}" name="${name}" type="checkbox" value="${value}" ${selected.includes(value)?'checked':''}><span>${esc(label)}</span></label>`).join('');
  return `<div class="form-grid">
      <div class="field"><label for="${prefix}-goal">What is your main goal?</label><select id="${prefix}-goal" name="goal" ${required} aria-describedby="${prefix}-goal-error"><option value="">Choose a goal</option>${surveyOptions.goals.map(goal=>`<option ${member?.goal===goal?'selected':''}>${esc(goal)}</option>`).join('')}</select><p id="${prefix}-goal-error" class="survey-field-error" hidden></p></div>
      <div class="field"><label for="${prefix}-experience">How familiar are you with training?</label><select id="${prefix}-experience" name="experience" ${required} aria-describedby="${prefix}-experience-error"><option value="">Choose your experience</option>${surveyOptions.experience.map(([value,label])=>`<option value="${value}" ${saved?.experience===value?'selected':''}>${esc(label)}</option>`).join('')}</select><p id="${prefix}-experience-error" class="survey-field-error" hidden></p></div>
    </div>
    <fieldset class="survey-question" aria-describedby="${prefix}-exercises-hint ${prefix}-exercises-error"><legend>Which exercises interest you?</legend><p id="${prefix}-exercises-hint" class="survey-hint">Choose one or more. You can change these later.</p><div class="survey-choices">${checks('exercises',surveyOptions.exercises,saved?.exercises)}</div><p id="${prefix}-exercises-error" class="survey-field-error" hidden></p></fieldset>
    <fieldset class="survey-question" aria-describedby="${prefix}-days-hint ${prefix}-days-error"><legend>Which days usually work for you?</legend><p id="${prefix}-days-hint" class="survey-hint">Choose one or more. This shares your availability; it does not book a session.</p><div class="survey-choices survey-days">${checks('availableDays',surveyOptions.days,saved?.availableDays)}</div><p id="${prefix}-days-error" class="survey-field-error" hidden></p></fieldset>`;
}

function surveyForm(member, first = false) {
  const pending = fitnessProfileSavingMember === member.id ? fitnessProfilePendingDraft : null;
  const draftMember = pending ? {...member,goal:pending.answers.goal,survey:{...member.survey,...pending.answers}} : member;
  return `<form id="member-survey-form" data-first="${pending?pending.first:!member.survey}" data-saving="${!!pending}"${pending?' aria-busy="true"':''} novalidate><fieldset class="fitness-profile-fields"${pending?' disabled':''}>
    <div id="survey-errors" class="survey-errors" role="alert" tabindex="-1" hidden></div>
    ${surveyQuestions(draftMember)}
    ${window.memberHealthPanel?.(member,true,pending?.health)||''}
    <div class="survey-form-footer"><p class="survey-note">All four fitness answers are needed. Health details are optional.${first?' You can change your answers later under My membership.':''}</p><div class="survey-actions"><button type="button" class="button" data-action="survey-cancel">Cancel</button><button type="submit" class="button primary">${pending?'Saving…':'Save fitness profile'}</button></div></div>
  </fieldset></form>`;
}

function memberSurveyPanel(member, editing = false) {
  const own = currentUser?.role === 'member' && currentUser.memberId === member.id;
  const editor = own && (!member.survey || editing || fitnessProfileSavingMember === member.id);
  return `<section id="fitness-survey" class="panel survey-panel" aria-labelledby="survey-title"><div class="panel-header"><div><h2 id="survey-title" tabindex="-1">${own?'Your fitness profile':'Member fitness survey'}</h2><p>${own?'Your goal, experience, exercise preferences and usual days.':'Preferences shared by this member.'}</p></div>${own&&member.survey&&!editor?'<button class="button small" data-action="survey-edit">Edit answers</button>':''}</div><div class="survey-body"><p class="survey-privacy">${own?'Your goal and training preference answers are visible to your gym’s staff and administrators. They help guide a conversation about your training.':'Only the member can update these answers.'}</p>${editor?surveyForm(member):surveySummary(member)+(own?(window.memberHealthPanel?.(member)||''):'')}<p id="survey-status" class="survey-status" role="status" tabindex="-1"></p></div></section>`;
}

// First login: a member without a survey sees only this, with a short welcome. There is no skip; Sign out stays.
function firstSurveyScreen(member) {
  return `<main class="survey-first"><header class="survey-first-top"><span class="survey-first-brand"><span class="brandmark">R</span><strong>RepReady</strong></span><button class="button" data-action="logout">Sign out</button></header>
  <section id="fitness-survey" class="panel survey-panel" aria-labelledby="survey-title"><div class="panel-header"><div><h1 id="survey-title" tabindex="-1">Welcome, ${esc(member.name.split(' ')[0])}.</h1><p>Before you start, tell your gym how you like to train. It takes about a minute.</p></div></div><div class="survey-body"><p class="survey-privacy">Your goal and training preference answers are visible to your gym’s staff and administrators. They help guide a conversation about your training.</p>${surveyForm(member,true)}<p id="survey-status" class="survey-status" role="status" tabindex="-1"></p></div></section></main>`;
}

function replaceSurvey(editing = false) {
  const member = memberById(currentUser?.memberId);
  if (!member || currentUser.role !== 'member') return;
  if (document.querySelector('#member-survey-form[data-saving="true"]')) return;
  if (!editing) window.fitnessProfileSaveState = null;
  if (document.querySelector('.survey-first')) {
    if (member.survey) {
      // Required answers may already be confirmed after a partial optional save failure.
      surveyThanks = true; mode = 'member'; section = 'overview';
      if (location.hash !== '#/member/overview') history.replaceState({}, '', '#/member/overview');
      render();
    } else {
      // Cancel resets both drafts without skipping the required first-login survey.
      document.getElementById('app').innerHTML = firstSurveyScreen(member);
      document.getElementById('survey-goal').focus();
    }
    return;
  }
  if (!editing && member.survey && document.getElementById('member-survey-form')?.dataset.first === 'true') {
    // A paid member's required answers may have saved before an optional failure; remove its reminder too.
    render();
    document.getElementById('survey-title')?.focus();
    return;
  }
  document.getElementById('fitness-survey').outerHTML = memberSurveyPanel(member, editing);
  refreshFitnessDerived(member);
  document.getElementById(editing?'survey-goal':'survey-title').focus();
}

// Update computed content from confirmed saved state without replacing a partially saved draft.
function refreshFitnessDerived(member) {
  if (document.querySelector('.survey-first')) return;
  const sample = document.getElementById('sample-training'), sampleHtml = window.sampleTrainingPanel?.(member) || '';
  if (sample) sample.outerHTML = sampleHtml;
  else if (sampleHtml) document.getElementById('fitness-survey')?.insertAdjacentHTML('afterend',sampleHtml);
  if (section !== 'members') return;
  const template = document.createElement('template');
  template.innerHTML = memberMembership();
  for (const selector of ['.plan-recommendation','.plans-grid']) {
    const old = document.querySelector(selector), updated = template.content.querySelector(selector);
    if (old && updated) old.replaceWith(updated);
  }
}

// At the desk (Add member): the same questions, optional and collapsed. Filled in, it is saved with the account.
function deskSurveySection() {
  return `<details class="field full survey-desk" id="desk-survey"><summary>Fitness survey (optional — the member can do it at first login)</summary><div id="desk-survey-errors" class="survey-errors" role="alert" tabindex="-1" hidden></div>${surveyQuestions(null,'desk')}</details>`;
}
// Nothing answered: null (the member does it at first login). Partly answered: an error. Complete: the answers.
function deskSurveyAnswers() {
  const section = document.getElementById('desk-survey');
  if (!section) return null;
  const value = id => document.getElementById(id).value, checked = name => [...section.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
  const answers = {goal:value('desk-goal'),experience:value('desk-experience'),exercises:checked('exercises'),availableDays:checked('availableDays')};
  if (!answers.goal && !answers.experience && !answers.exercises.length && !answers.availableDays.length) return null;
  const missing = [!answers.goal&&'main goal',!answers.experience&&'training experience',!answers.exercises.length&&'exercise preferences',!answers.availableDays.length&&'usual days'].filter(Boolean);
  if (missing.length) { section.open = true; throw Error(`Finish the fitness survey (${missing.join(', ')}), or leave it empty for the member to do at first login.`); }
  return answers;
}

{
  const surveyBaseRender = render, surveyBaseMembership = memberMembership, surveyBaseOverview = memberOverview, surveyBaseProfile = profile, surveyBaseSelectPlan = selectPlan;
  render = function() {
    const member = authReady && currentUser?.role === 'member' ? memberById(currentUser.memberId) : null;
    if (member && !member.survey && !hasPaidCycle(member)) {
      // Keep answers already chosen if something asks for a fresh render while the member is filling it in.
      if (document.querySelector('.survey-first #member-survey-form')) return;
      document.title = 'RepReady · Welcome';
      document.getElementById('app').innerHTML = firstSurveyScreen(member);
      return;
    }
    if (section !== 'overview') surveyThanks = false;
    surveyBaseRender();
  };
  memberMembership = function() {
    const member = memberById(selectedMember), marker = '<div class="panel-header" style="padding-left:0">';
    let html = surveyBaseMembership();
    if (member) {
      const panels = memberSurveyPanel(member) + (window.sampleTrainingPanel?.(member) || '');
      html = html.includes(marker) ? html.replace(marker,panels+marker) : html+panels;
    }
    return ownMemberWithoutSurvey() ? withSurveyCard(html, ['<section class="member-hero">']) : html;
  };
  // Straight after the first save: thanks, and on to plan selection (Task 12 recommends plans here).
  memberOverview = function() {
    const html = surveyBaseOverview(), member = memberById(selectedMember);
    if (ownMemberWithoutSurvey()) return withSurveyCard(html, ['<div class="member-pass-bar">','<section class="member-hero">']);
    if (!surveyThanks || currentUser?.role !== 'member' || !member || member.start) return html;
    const suggestion = recommendPlans(recommendationAnswers(member), plans), recommended = plans.find(p => p.id === suggestion?.recommended);
    const note = `<div class="notice survey-thanks" role="status" tabindex="-1"><strong>Thanks! Choose your plan next.</strong>${recommended?` We recommend ${esc(recommended.name)} for you; see why below. Any plan can be chosen.`:''}</div>`;
    const at = html.indexOf('<div class="notice">');
    return at < 0 ? note + html : html.slice(0, at) + note + html.slice(at);
  };
  // The renew screen: until the survey is saved the next plan can't be chosen (the API refuses it too), so say why.
  selectPlan = function(id) {
    surveyBaseSelectPlan(id);
    const form = document.getElementById('renew-form');
    if (!form || !ownMemberWithoutSurvey()) return;
    form.insertAdjacentHTML('afterbegin', '<div class="notice survey-renew-note" role="alert">Choosing your next plan comes after your fitness profile. <a href="#/member/members" data-action="survey-open">Complete your fitness profile</a> first; it takes a minute.</div>');
    document.querySelectorAll('[form="renew-form"]').forEach(button => { button.disabled = true; });
  };
  profile = function(id) {
    surveyBaseProfile(id);
    if (can('roster')) document.querySelector('.modal-body').insertAdjacentHTML('beforeend', `<section class="survey-staff" aria-label="Member fitness survey"><h3>Fitness survey</h3>${surveySummary(memberById(id))}</section>`);
  };
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || !['survey-open','survey-edit','survey-cancel'].includes(button.dataset.action)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (currentUser?.role !== 'member') return;
  if (button.dataset.action === 'survey-open') {
    // From the card or the renew screen: My membership, at the survey form.
    if (document.querySelector('.modal-backdrop')) closeModal();
    if (section !== 'members') navigate('members');
    const title = document.getElementById('survey-title');
    title?.scrollIntoView({block:'start'}); title?.focus();
    return;
  }
  replaceSurvey(button.dataset.action === 'survey-edit');
}, true);

document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'member-survey-form') return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (form.dataset.saving === 'true' || currentUser?.role !== 'member') return;
  if (fitnessProfileSavingMember === currentUser.memberId) { toast('Your fitness profile is still saving.'); return; }
  const data = new FormData(form);
  const answers = {goal:data.get('goal'),experience:data.get('experience'),exercises:data.getAll('exercises'),availableDays:data.getAll('availableDays')};
  const problems = [];
  const check = (valid, id, errorId, message) => {
    const input = document.getElementById(id), error = document.getElementById(errorId);
    input.setAttribute('aria-invalid', String(!valid)); error.hidden = !!valid; error.textContent = valid ? '' : message;
    if (!valid) problems.push({id,message});
  };
  check(surveyOptions.goals.includes(answers.goal),'survey-goal','survey-goal-error','Choose your main fitness goal.');
  check(surveyOptions.experience.some(([value])=>value===answers.experience),'survey-experience','survey-experience-error','Choose your training experience.');
  check(answers.exercises.length>0,'survey-strength','survey-exercises-error','Choose at least one exercise preference.');
  check(answers.availableDays.length>0,'survey-mon','survey-days-error','Choose at least one day you are usually available.');
  let health;
  const healthError = document.getElementById('member-health-error');
  if (healthError) healthError.hidden = true;
  try {
    if (!window.healthProfileValidate) throw Error('Optional details are still loading. Try again.');
    health = window.healthProfileValidate(form);
  } catch (error) {
    if (healthError) { healthError.hidden = false; healthError.textContent = error.message; }
    problems.push({id:'health-height',message:error.message});
  }
  const summary = document.getElementById('survey-errors');
  summary.hidden = !problems.length;
  if (problems.length) { summary.innerHTML = `<strong>Check your answers</strong><ul>${problems.map(({id,message})=>`<li><a href="#${id}">${esc(message)}</a></li>`).join('')}</ul>`; summary.focus(); return; }
  const memberId = currentUser.memberId, submit = form.querySelector('[type="submit"]');
  let member = memberById(memberId);
  const first = form.dataset.first === 'true';
  const sameValues = (left = [], right = []) => left.length === right.length && left.every(value => right.includes(value));
  const sameSurvey = member.survey && member.goal === answers.goal && member.survey.experience === answers.experience
    && sameValues(member.survey.exercises,answers.exercises) && sameValues(member.survey.availableDays,answers.availableDays);
  const confirmedHealth = window.healthProfileSaved();
  const sameHealth = confirmedHealth.heightCm === health.heightCm && confirmedHealth.weightKg === health.weightKg
    && confirmedHealth.ageBand === health.ageBand && sameValues(confirmedHealth.conditions,health.conditions);
  form.dataset.saving = 'true'; form.setAttribute('aria-busy', 'true');
  fitnessProfileSavingMember = memberId;
  fitnessProfilePendingDraft = {answers,health,first};
  const controls = [...form.querySelectorAll('input,select,button')];
  controls.forEach(control => control.disabled = true); submit.textContent = 'Saving…';
  try {
    // Separate authorized endpoints preserve health privacy. Only changed, unconfirmed sections need saving.
    const jobs = [];
    if (!sameSurvey) jobs.push({section:'fitness',request:api('/member-survey',answers)});
    if (!sameHealth) jobs.push({section:'health',request:api('/member-health',health)});
    const results = await Promise.allSettled(jobs.map(job => job.request));
    // A member may navigate or sign out while the save is in flight.
    if (currentUser?.role !== 'member' || currentUser.memberId !== memberId) return;
    member = memberById(memberId);
    if (!member) return;
    const paid = hasPaidCycle(member);
    const failures = [], completed = [];
    results.forEach((result,index) => {
      const job = jobs[index], label = job.section === 'fitness' ? 'Fitness answers' : 'Health details';
      if (result.status === 'rejected') {
        failures.push({section:job.section,message:`${label} could not be saved: ${result.reason?.message || 'Please try again.'}`});
      } else if (job.section === 'fitness') {
        Object.assign(member, {goal:result.value.goal,survey:result.value.survey});
        completed.push(label);
      } else {
        state.memberHealth = result.value.memberHealth;
        completed.push(label);
      }
    });
    fitnessProfileSavingMember = null;
    fitnessProfilePendingDraft = null;
    if (failures.length) {
      window.fitnessProfileSaveState = {memberId,healthFailed:failures.some(item => item.section === 'health'),surveyFailed:failures.some(item => item.section === 'fitness')};
      refreshFitnessDerived(member);
      const currentSummary = document.querySelector('#member-survey-form #survey-errors');
      if (currentSummary) {
        currentSummary.hidden = false;
        currentSummary.textContent = `${completed.length?completed.join(' and ')+' saved. ':''}${failures.map(item => item.message).join(' ')} Your draft is kept. Select Save fitness profile to retry the unsaved section${failures.length>1?'s':''}.${first&&member.survey?' Your required fitness answers are saved; Cancel discards the optional draft and lets you continue using your saved profile.':''}`;
        currentSummary.focus();
      }
      return;
    }
    window.fitnessProfileSaveState = null;
    if (first && paid) {
      // A paid member answered from the card: stay here; the card goes.
      render();
      const status = document.getElementById('survey-status');
      if (status) { status.textContent = 'Your fitness profile is saved. You can update it anytime.'; status.focus(); }
      toast('Thanks! Your fitness profile is saved.');
      return;
    }
    if (first) {
      // The first save opens the app: thanks, and on to plan selection (or the overview if a plan exists).
      surveyThanks = true; mode = 'member'; section = 'overview';
      if (location.hash !== '#/member/overview') history.replaceState({}, '', '#/member/overview');
      render();
      document.querySelector('.survey-thanks, .page-heading h1, h1')?.focus?.();
      toast(member.start ? 'Thanks! Your fitness profile is saved.' : 'Thanks! Choose your plan next.');
      return;
    }
    if (form.isConnected || document.getElementById('member-survey-form')) {
      render();
      const status = document.getElementById('survey-status');
      if (status) { status.textContent = 'Your fitness profile is saved. You can update it anytime.'; status.focus(); }
    }
    toast('Fitness profile saved.');
  } catch (error) {
    if (form.isConnected) { summary.hidden = false; summary.textContent = error.message; summary.focus(); }
  } finally {
    if (fitnessProfileSavingMember === memberId) { fitnessProfileSavingMember = null; fitnessProfilePendingDraft = null; }
    if (form.isConnected) { form.dataset.saving = 'false'; form.removeAttribute('aria-busy'); controls.forEach(control => control.disabled = false); submit.textContent = 'Save fitness profile'; }
    const activeForm = document.getElementById('member-survey-form');
    if (activeForm && currentUser?.memberId === memberId) {
      activeForm.dataset.saving = 'false'; activeForm.removeAttribute('aria-busy');
      activeForm.querySelector('.fitness-profile-fields').disabled = false;
      activeForm.querySelector('[type="submit"]').textContent = 'Save fitness profile';
    }
  }
}, true);
// Error links focus the field without entering the app's hash router.
document.addEventListener('click', event => {
  const link = event.target.closest('#survey-errors a');
  if (link) { event.preventDefault(); event.stopImmediatePropagation(); document.getElementById(link.hash.slice(1))?.focus(); }
}, true);
