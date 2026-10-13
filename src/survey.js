import { fail } from './validation.js';
// Task 11: the member fitness survey. Ported from a classmate's survey work (fitness-survey-update.zip); the
// desk survey at the end is new. The four answers carry no medical data.

export const SURVEY_GOALS = ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'];
export const SURVEY_EXPERIENCE = ['beginner', 'returning', 'regular'];
export const SURVEY_EXERCISES = ['strength', 'cardio', 'mobility', 'group_classes'];
export const SURVEY_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Keep this allowlist aligned with ff_private.survey_answers and the browser forms.
export function validateSurvey(body) {
  const keys = ['goal', 'experience', 'exercises', 'availableDays'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !keys.includes(key))) fail('Send only your survey answers.');
  if (!SURVEY_GOALS.includes(body.goal)) fail('Choose your main fitness goal.');
  if (!SURVEY_EXPERIENCE.includes(body.experience)) fail('Choose your training experience.');
  const choices = (value, allowed, message) => {
    if (!Array.isArray(value) || !value.length || value.length > allowed.length ||
        new Set(value).size !== value.length || value.some(item => !allowed.includes(item))) fail(message);
    return allowed.filter(item => value.includes(item));
  };
  return {
    goal: body.goal,
    experience: body.experience,
    exercises: choices(body.exercises, SURVEY_EXERCISES, 'Choose at least one exercise preference.'),
    availableDays: choices(body.availableDays, SURVEY_DAYS, 'Choose at least one day you are usually available.')
  };
}

export const surveyView = row => row ? ({
  experience: row.experience,
  exercises: row.exercises,
  availableDays: row.available_days,
  updatedAt: row.updated_at
}) : null;

// Filled in by staff at the desk during Add member: the account's goal plus the other three answers. It is
// saved with the account (register_auth_user), so it is checked here before the account is made.
export function deskSurvey(goal, survey) {
  if (survey === undefined) return null;
  if (!survey || typeof survey !== 'object' || Array.isArray(survey) || 'goal' in survey) fail('Send only the survey answers.');
  const { goal: checked, ...answers } = validateSurvey({ goal, ...survey });
  return answers;
}
