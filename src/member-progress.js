import {validateProgressMutation} from '../public/member-progress-model.js';
import {fail} from './validation.js';
import {result} from './supabase.js';

const member = profile => {if(profile.role!=='member'||profile.enabled!==true)fail('Sign in to your enabled member account to view your progress.',403);};
export const goalView = row => ({id:row.id,periodId:row.period_id,goalType:row.goal_type,status:row.status,startDate:row.start_date,
  startingWeightKg:row.starting_weight_kg===null?null:Number(row.starting_weight_kg),measurementDate:row.measurement_date,
  targetWeightKg:row.target_weight_kg===null?null:Number(row.target_weight_kg),recordedAt:row.recorded_at,endedAt:row.ended_at});
export const weightView = row => ({id:row.id,date:row.measured_on,weightKg:Number(row.weight_kg),recordedAt:row.recorded_at,updatedAt:row.updated_at});
async function rows(client,table,columns,profile) {
  const all=[];
  for(let offset=0;;offset+=1000) {
    const page=result(await client.from(table).select(columns).eq('member_id',profile.id).eq('workspace',profile.workspace).order('id').range(offset,offset+999));
    all.push(...page);if(page.length<1000)return all;
  }
}
export async function memberProgress(client,profile,query,today) {
  member(profile);
  if(Object.keys(query).length)fail('Progress reads do not accept member, workspace or other query fields.');
  result(await client.rpc('ff_member_progress',{body:{action:'read'}}));
  // Dedicated owner-only endpoint: no private data is added to shared state, rosters or exports.
  const [goalRows,weightRows,health]=await Promise.all([
    rows(client,'ff_member_goals','id,period_id,goal_type,status,start_date,starting_weight_kg,measurement_date,target_weight_kg,recorded_at,ended_at',profile),
    rows(client,'ff_member_weights','id,measured_on,weight_kg,recorded_at,updated_at',profile),
    client.from('ff_member_health').select('weight_kg,updated_at').eq('id',profile.id).eq('workspace',profile.workspace).maybeSingle()
  ]);
  const savedHealth=result(health),goals=goalRows.map(goalView).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
  return {today,goals,currentGoal:goals.find(goal=>goal.endedAt===null)||null,
    measurements:weightRows.map(weightView).sort((a,b)=>a.date.localeCompare(b.date)),
    healthWeight:savedHealth?.weight_kg!==null&&savedHealth?.weight_kg!==undefined?{weightKg:Number(savedHealth.weight_kg),recordedAt:savedHealth.updated_at}:null};
}
export async function saveMemberProgress(client,profile,body,today) {
  member(profile);let request;
  try{request=validateProgressMutation(body,today);}catch(error){fail(error.message);}
  result(await client.rpc('ff_member_progress',{body:request}));
  return memberProgress(client,profile,{},today);
}
