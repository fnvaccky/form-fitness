// Private goal/measurement rules. These are tracking inputs, never medical advice or BMI inference.
import {realDay,businessDate} from './attendance-tracker.js';
export {businessDate};
export const GOAL_TYPES = [['lose','Lose weight'],['gain','Gain weight'],['maintain','Maintain weight'],['attendance','Attendance consistency']];
const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// Same documented input bounds/precision as optional member health, not clinical thresholds.
export const validWeight = value => typeof value==='number' && Number.isFinite(value) && value>=10 && value<=500 && Math.abs(value*10-Math.round(value*10))<1e-7;
const keysOnly = (body,keys) => Object.keys(body).length===keys.length && keys.every(key=>Object.hasOwn(body,key));
const validDate = (value,today) => realDay(value) && value<=today;
export function validateProgressMutation(body,today=businessDate(new Date().toISOString())) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw Error('Send only the fields for this progress action.');
  if (['save_goal','new_goal'].includes(body.action)) {
    if (!keysOnly(body,['action','requestId','goalId','goalType','startDate','startingWeightKg','measurementDate','targetWeightKg'])) throw Error('Send only the goal fields.');
    if (!uuid(body.requestId) || (body.goalId!==null && !uuid(body.goalId))) throw Error('Use a valid goal request and current goal.');
    if (!GOAL_TYPES.some(([type])=>type===body.goalType)) throw Error('Choose one of the four goals.');
    if (!validDate(body.startDate,today)) throw Error('Choose a real goal start date no later than today.');
    if (body.goalType==='attendance') {
      if (body.startingWeightKg!==null || body.measurementDate!==null || body.targetWeightKg!==null) throw Error('Attendance goals do not need weight fields.');
    } else {
      if (!validWeight(body.startingWeightKg)) throw Error('Enter a starting weight from 10 to 500 kg, with at most one decimal place.');
      if (!validDate(body.measurementDate,today) || body.measurementDate>body.startDate) throw Error('Confirm a real measurement date on or before the goal start date.');
      if (body.targetWeightKg!==null && !validWeight(body.targetWeightKg)) throw Error('Enter a target from 10 to 500 kg, with at most one decimal place, or leave it blank.');
      if (body.goalType==='maintain' && body.targetWeightKg!==null) throw Error('A maintain goal uses its reference weight, without an invented target range.');
      if (body.targetWeightKg!==null && ((body.goalType==='lose' && body.targetWeightKg>=body.startingWeightKg) || (body.goalType==='gain' && body.targetWeightKg<=body.startingWeightKg))) throw Error('A loss target must be below the starting weight; a gain target must be above it.');
    }
  } else if (['pause_goal','resume_goal'].includes(body.action)) {
    if (!keysOnly(body,['action','requestId','goalId']) || !uuid(body.requestId) || !uuid(body.goalId)) throw Error('Use a valid goal request and current goal.');
  } else if (['add_weight','update_weight'].includes(body.action)) {
    if (!keysOnly(body,body.action==='add_weight'?['action','date','weightKg']:['action','id','date','weightKg']) || (body.action==='update_weight' && !uuid(body.id))) throw Error('Send only the dated measurement fields.');
    if (!validDate(body.date,today)) throw Error('Choose a real measurement date no later than today.');
    if (!validWeight(body.weightKg)) throw Error('Enter a weight from 10 to 500 kg, with at most one decimal place.');
  } else if (body.action==='delete_weight') {
    if (!keysOnly(body,['action','id']) || !uuid(body.id)) throw Error('Choose the measurement to delete.');
  } else throw Error('Choose a supported progress action.');
  return {...body};
}
export function goalSuggestion(profileGoal) {
  if (profileGoal==='Manage weight') return {choices:['lose','gain','maintain'],suggested:null,message:'Your survey says Manage weight. Choose lose, gain or maintain; we do not infer which you need.'};
  if (profileGoal==='Stay consistent') return {choices:['attendance','lose','gain','maintain'],suggested:'attendance',message:'Your survey suggests attendance consistency. Confirm your own choice before tracking begins.'};
  return {choices:['attendance','lose','gain','maintain'],suggested:'attendance',message:'Attendance consistency is one option, alongside optional weight goals. Attendance does not measure strength or fitness.'};
}
export function progressSummary(goal,measurements=[]) {
  const start=goal?.measurementDate||goal?.startDate;
  const chart=measurements.filter(row=>realDay(row.date)&&validWeight(row.weightKg)&&(!start||row.date>=start)).map(row=>({date:row.date,weightKg:row.weightKg})).sort((a,b)=>a.date.localeCompare(b.date));
  const latest=chart.at(-1),starting=goal?.startingWeightKg??null,target=goal?.targetWeightKg??null;
  const change=latest&&starting!==null?Math.round((latest.weightKg-starting)*10)/10:null;
  const direction=goal?.goalType==='lose'?-1:goal?.goalType==='gain'?1:0;
  const percentage=latest&&latest.date>goal?.measurementDate&&starting!==null&&target!==null&&direction&&direction*(target-starting)>0
    ?Math.max(0,Math.min(100,Math.round((latest.weightKg-starting)/(target-starting)*1000)/10)):null;
  return {startingWeightKg:starting,latestWeightKg:latest?.weightKg??null,latestDate:latest?.date??null,changeKg:change,targetWeightKg:target,percentage,chart,hasChart:chart.length>=2};
}
