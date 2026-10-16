import {fail,cents} from './validation.js';
// Task 12A: plan management and purchased terms.
// The plan form, as ff_private.plan_admin expects it. The database checks every field again and has the final say;
// this only turns the form's price into centavos, whole-number strings into numbers, and keeps other fields out.
const FIELDS=['id','name','days','description','features','available','coaching','coachSessions','focusTags'];
export function planRequest(body){
 if(!['create','update'].includes(body.action))fail('This page is out of date. Reload it and try again.',409);
 const plan=Object.fromEntries(FIELDS.filter(key=>key in body).map(key=>[key,body[key]]));
 for(const key of ['days','coachSessions'])if(typeof plan[key]==='string'&&/^\d{1,3}$/.test(plan[key]))plan[key]=Number(plan[key]);
 plan.priceCents=cents(body.price);
 return {action:body.action,body:plan};
}
// What a plan's coaching is called on cards, terms and emails: "No coach", "Group coaching" or "Personal coach · 4 sessions".
// Zero sessions are never shown as a number of sessions.
export function coachingLabel(coaching,sessions){
 const n=Number(sessions)||0,count=`${n} session${n===1?'':'s'}`;
 if(coaching==='personal')return n?`Personal coach · ${count}`:'Personal coach · no sessions included';
 if(coaching==='group')return n?`Group coaching · ${count}`:'Group coaching';
 return 'No coach';
}
// A cycle's purchased terms, shaped like a catalog plan so the screens show both the same way. Only the catalog is used
// to choose a new cycle; anything about a cycle already bought reads these.
export const termsView=(terms,planId)=>terms?{id:planId,name:terms.name,price:terms.priceCents/100,priceCents:terms.priceCents,days:terms.days,
 desc:terms.description,features:terms.features,included:terms.included||[],coaching:terms.coaching,coachSessions:terms.coachSessions,
 coachingLabel:coachingLabel(terms.coaching,terms.coachSessions)}:null;
// Plan privileges as text lines, with each "Everything in <plan>" line followed by what it meant when bought.
export function termsLines(terms){
 const included=new Map((terms.included||[]).map(entry=>[entry.line,entry]));
 return (terms.features||[]).map(feature=>included.has(feature)?`${feature}: ${included.get(feature).features.join(', ')}`:feature);
}
