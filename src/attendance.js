import {fail} from './validation.js';
import {result} from './supabase.js';
// Task 13: the attendance report for gym staff. It reads check-ins through the caller's own session, so RLS
// keeps it to their workspace. The gymStaff() gate is in api.js.
const DATE=/^\d{4}-\d{2}-\d{2}$/,PAGE=1000,CAP=10000;
const dayNumber=value=>Date.UTC(+value.slice(0,4),+value.slice(5,7)-1,+value.slice(8,10))/86400000;
export const manilaTime=iso=>new Date(iso).toLocaleTimeString('en-GB',{timeZone:'Asia/Manila',hour:'2-digit',minute:'2-digit'});
function realDate(value,label){
 if(typeof value!=='string'||!DATE.test(value))fail(`${label} must be a date (YYYY-MM-DD).`);
 const day=dayNumber(value);
 if(new Date(day*86400000).toISOString().slice(0,10)!==value)fail(`${label} is not a real date.`);
 return day;
}
// Real dates, From on or before To, at most 366 days, To no later than today (Manila), and a plan id or "all".
export function attendanceRange(query,today){
 const from=realDate(query.from,'From'),to=realDate(query.to,'To');
 if(from>to)fail('From must be on or before To.');
 if(to>dayNumber(today))fail('To can’t be later than today.');
 const days=to-from+1;
 if(days>366)fail('Choose a range of at most 366 days.');
 const plan=String(query.plan??'all');
 if(plan!=='all'&&!/^[A-Za-z0-9_-]{1,40}$/.test(plan))fail('Choose a plan from the list.');
 return {from:query.from,to:query.to,days,plan};
}
export function attendanceTotals(visits,days){
 return {visits:visits.length,uniqueMembers:new Set(visits.map(v=>v.memberId)).size,days,dailyAverage:Math.round(visits.length/days*10)/10};
}
export async function attendanceReport(client,query,today){
 const range=attendanceRange(query,today);
 const plans=Object.fromEntries(result(await client.from('ff_plans').select('id,name')).map(p=>[p.id,p.name]));
 if(range.plan!=='all'&&!Object.hasOwn(plans,range.plan))fail('Choose a plan from the list.');
 const membership=range.plan==='all'?'membership:ff_memberships(plan_id)':'membership:ff_memberships!inner(plan_id)';
 const page=offset=>{
  let q=client.from('ff_checkins').select(`id,member_id,checkin_date,created_at,member:ff_profiles!ff_checkins_workspace_member_id_fkey(name),staff:ff_profiles!ff_checkins_confirmed_by_fkey(name),${membership}`)
   .gte('checkin_date',range.from).lte('checkin_date',range.to).order('created_at',{ascending:false}).order('id',{ascending:false});
  if(range.plan!=='all')q=q.eq('membership.plan_id',range.plan);
  return q.range(offset,offset+PAGE-1).then(result);
 };
 const rows=[];
 for(let offset=0;offset<CAP;offset+=PAGE){const next=await page(offset);rows.push(...next);if(next.length<PAGE)break;}
 // Stop at 10,000 rows; one more row means there was more to show.
 const truncated=rows.length>=CAP&&(await page(CAP)).length>0;
 const visits=rows.slice(0,CAP).map(r=>({id:r.id,date:r.checkin_date,time:manilaTime(r.created_at),memberId:r.member_id,name:r.member?.name||'',
  plan:plans[r.membership?.plan_id]||r.membership?.plan_id||'',confirmedBy:r.staff?.name||''}));
 return {from:range.from,to:range.to,plan:range.plan,visits,totals:attendanceTotals(visits,range.days),truncated};
}
