import {validateHealth} from '../public/health-inputs.js';
import {fail} from './validation.js';
import {result} from './supabase.js';

// Health stays outside the roster/survey/payment views. Only these optional fields return to its owner.
export const healthView = row => row ? ({
  heightCm: row.height_cm === null ? null : Number(row.height_cm),
  weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
  ageBand: row.age_band,
  conditions: [...row.conditions],
  updatedAt: row.updated_at
}) : null;

export async function memberHealthFor(client, profile) {
  if (profile.role !== 'member' || profile.enabled !== true) return undefined;
  return healthView(result(await client.from('ff_member_health')
    .select('height_cm,weight_kg,age_band,conditions,updated_at').eq('id', profile.id).maybeSingle()));
}

export async function saveMemberHealth(client, profile, body) {
  if (profile.role !== 'member' || profile.enabled !== true) fail('Only members can save their own optional health information.',403);
  let answers;
  try { answers = validateHealth(body); }
  catch (error) { fail(error.message); }
  return healthView(result(await client.rpc('ff_save_member_health',{body:answers})));
}
