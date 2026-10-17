// Owner-only attendance presentation. The API calculates dates and consistency; no health fields are read.
import {ATTENDANCE_ZONE,WEEKDAYS,realDay} from './attendance-tracker.js';

const DAY_NAMES={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const tracker={owner:'',period:'week',date:'',today:'',data:null,error:'',loading:false,request:0,controller:null,timer:null,active:false,snapshot:null,refreshQueued:false};
const ownerKey=()=>currentUser?.role==='member'?`${currentUser.memberId}:${currentUser.workspace||''}`:'';
const ownPage=()=>!!ownerKey()&&mode==='member'&&section==='attendance'&&!!document.getElementById('member-attendance');
const namedDate=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
const dayNames=days=>days.map(day=>DAY_NAMES[day]).filter(Boolean).join(', ')||'Not recorded';
const businessToday=()=>tracker.today||DEMO_DATE;

function cancelRequest(){
 tracker.request++;
 tracker.controller?.abort();tracker.controller=null;tracker.loading=false;tracker.refreshQueued=false;
}
function stopTimer(){if(tracker.timer){clearInterval(tracker.timer);tracker.timer=null;}}
function syncOwner(){
 const owner=ownerKey();
 if(owner===tracker.owner)return;
 stopTimer();cancelRequest();
 Object.assign(tracker,{owner,period:'week',date:DEMO_DATE,today:DEMO_DATE,data:null,error:'',active:false,snapshot:null});
}
function statusLabel(day){
 if(day.status==='attended')return `Attended · ${day.eventCount} check-in${day.eventCount===1?'':'s'}`;
 return {'usual-without-checkin':'Usual training day without a check-in','before-tracking':'Before schedule tracking','outside-coverage':'Outside eligible membership coverage',rest:'Rest / unselected',today:'Today — still in progress',future:'Future — not completed'}[day.status]||'Not classified';
}
function calendarMarkup(data){
 const blanks=data.period==='month'?WEEKDAYS.indexOf(data.days[0]?.weekday):0;
 const cells=data.days.map(day=>{
  const tags=[day.today&&'Today',day.future&&'Future',day.usual&&'Usual training day',day.attended&&!day.usual&&'Extra visit'].filter(Boolean);
  const label=`${DAY_NAMES[day.weekday]}, ${namedDate(day.date)}: ${statusLabel(day)}${tags.length?'. '+tags.join(', '):''}`;
  return `<article class="attendance-calendar-day ${esc(day.status)}${day.today?' is-today':''}${day.future?' is-future':''}" role="listitem" data-date="${esc(day.date)}" data-status="${esc(day.status)}" aria-label="${esc(label)}" title="${esc(label)}"><span class="attendance-day-name">${esc(DAY_NAMES[day.weekday])}</span><time datetime="${esc(day.date)}">${Number(day.date.slice(-2))}</time><span class="attendance-calendar-status">${esc(statusLabel(day))}</span>${tags.length?`<small class="attendance-day-tags">${tags.map(esc).join(' · ')}</small>`:''}</article>`;
 }).join('');
 return `<div id="attendance-calendar" class="attendance-calendar-wrap"><div class="attendance-calendar-legend"><span class="attended">Attended</span><span class="usual-without-checkin">Usual training day without a check-in</span><span class="rest">Rest / unselected</span><span class="not-tracked">Outside coverage / before tracking</span><span class="today">Today</span><span class="future">Future</span></div><div class="attendance-weekday-head" aria-hidden="true">${WEEKDAYS.map(day=>`<span>${DAY_NAMES[day].slice(0,3)}</span>`).join('')}</div><div class="attendance-calendar ${esc(data.period)}" role="list" aria-label="${data.period==='week'?'Monday to Sunday attendance':'Calendar month attendance'}">${Array.from({length:Math.max(0,blanks)},()=>'<span class="attendance-calendar-blank" aria-hidden="true"></span>').join('')}${cells}</div></div>`;
}
function savedContent(data){
 const summary=data.summary;
 const consistency=summary.percentage===null?'Not enough history yet':`${summary.percentage}%`;
 const tracking=data.trackingStart?`Schedule tracking ${data.trackingStart>data.today?'starts':'began'} ${namedDate(data.trackingStart)}. Earlier dates have no recorded schedule and are excluded from consistency.`:'Schedule tracking has not begun. Save your usual training weekdays in your fitness profile to start. Earlier dates are not treated as usual training days without a check-in.';
 const pending=data.pendingSchedule?`<div class="notice attendance-tracker-notice"><strong>Weekday update scheduled</strong><p>${esc(dayNames(data.pendingSchedule.days))} take effect ${namedDate(data.pendingSchedule.effectiveFrom)}. Earlier dates keep the schedule recorded for them.</p></div>`:'';
 const uncertain=data.unconfirmedCoverage?'<div class="notice attendance-tracker-notice">Some paid membership dates lack confirmed full-payment timing. They are excluded from consistency; attendance records remain unchanged.</div>':'';
 const history=data.history.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Time (Manila)</th></tr></thead><tbody>${data.history.map(visit=>`<tr><td>${namedDate(visit.date)}</td><td>${esc(new Intl.DateTimeFormat('en-GB',{timeZone:ATTENDANCE_ZONE,hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(visit.at)))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><h3>No check-ins in this period</h3><p>Only staff-confirmed visits appear here.</p></div>';
 return `<p class="attendance-tracker-range">${namedDate(data.from)} – ${namedDate(data.to)} · ${esc(data.timeZone)} (gym time)</p><section id="attendance-tracker-summary" class="attendance-tracker-summary" aria-label="Attendance summary"><div><span>Distinct attended days</span><strong>${summary.attendedDays}</strong><p>Training frequency in this period</p></div><div><span>Total check-in events</span><strong>${summary.events}</strong><p>Several check-ins on one date count as one attended day</p></div><div class="attendance-consistency"><span>Consistency</span><strong>${esc(consistency)}</strong><p>${summary.completedAttended} / ${summary.completedPlanned} completed usual training dates attended</p>${summary.percentage===null?'':`<b>${esc(summary.label)}</b>`}</div></section><div class="attendance-tracker-notes"><p><strong>Usual training weekdays:</strong> ${esc(dayNames(data.usualDays))}. These describe availability, not booked sessions.</p><p>${esc(tracking)}</p><p>Consistency = completed usual training dates attended ÷ completed usual training dates × 100. Today, future dates, rest/unselected dates, dates before schedule tracking and dates outside eligible membership coverage are excluded. Coverage begins when the membership has started and full payment is recorded. Extra visits count toward attendance totals without replacing a different usual training date.</p></div>${pending}${uncertain}${calendarMarkup(data)}<section id="member-attendance-history" class="member-attendance-history" aria-label="Your check-in events"><h3>Your check-in events</h3>${history}</section>`;
}
function panelMarkup(){
 const form=`<form id="member-attendance-form" class="member-attendance-filters"><div class="field"><label for="member-attendance-period">View</label><select id="member-attendance-period"><option value="week"${tracker.period==='week'?' selected':''}>Week (Monday–Sunday)</option><option value="month"${tracker.period==='month'?' selected':''}>Calendar month</option></select></div><div class="field"><label for="member-attendance-date">Date within the period</label><input id="member-attendance-date" type="date" value="${esc(tracker.date||DEMO_DATE)}" max="${esc(businessToday())}" required></div><button class="button primary" type="submit"${tracker.loading?' disabled':''}>Apply</button><button class="button" type="button" data-action="attendance-tracker-refresh"${tracker.loading?' disabled':''}>Refresh</button></form>`;
 const loading=tracker.loading?'<p class="attendance-tracker-status" role="status">Updating attendance…</p>':'';
 const content=tracker.error?`<div class="form-error attendance-tracker-error" role="alert">${esc(tracker.error)} <button id="member-attendance-retry" class="button small" data-action="attendance-tracker-retry">Retry</button></div>`:tracker.data?savedContent(tracker.data):tracker.loading?'':'<p class="attendance-tracker-status" role="status">Loading your attendance…</p>';
 return `<section id="member-attendance" class="panel member-attendance" aria-labelledby="member-attendance-title"${tracker.loading?' aria-busy="true"':''}><div class="panel-header"><div><h2 id="member-attendance-title">Your attendance tracker</h2><p>Recorded gym visits and usual training days. This does not track exercise completion.</p></div></div><div class="member-attendance-body">${form}${loading}${content}</div></section>`;
}
window.memberAttendanceTracker=()=>{
 if(currentUser?.role!=='member')return '<section class="panel"><div class="empty"><h2>Member attendance</h2><p>The private tracker is available in the member’s own signed-in account. Return to the staff workspace for authorized attendance reports.</p></div></section>';
 syncOwner();return panelMarkup();
};
function repaint(){
 const old=document.getElementById('member-attendance');
 if(!old||!ownPage())return;
 const focused=old.contains(document.activeElement)?document.activeElement.id:null;
 const draftPeriod=old.querySelector('#member-attendance-period')?.value,draftDate=old.querySelector('#member-attendance-date')?.value;
 old.outerHTML=panelMarkup();
 if(['week','month'].includes(draftPeriod))document.getElementById('member-attendance-period').value=draftPeriod;
 if(realDay(draftDate))document.getElementById('member-attendance-date').value=draftDate;
 if(focused)document.getElementById(focused)?.focus({preventScroll:true});
}
async function refreshTracker(){
 syncOwner();
 if(!ownPage()||document.hidden||tracker.loading)return;
 const owner=tracker.owner,request=++tracker.request,controller=new AbortController();
 tracker.controller=controller;tracker.loading=true;tracker.error='';repaint();
 const current=()=>owner===ownerKey()&&owner===tracker.owner&&request===tracker.request&&ownPage();
 try{
  const query=new URLSearchParams({period:tracker.period,date:tracker.date||DEMO_DATE});
  const response=await fetch(`/api/member-attendance?${query}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!current())return;
  const data=await response.json();
  if(!current())return;
  if(!response.ok)throw Error(data.error||'Attendance could not be loaded. Please try again.');
  if(!Array.isArray(data.days)||!Array.isArray(data.history)||!data.summary)throw Error('Attendance could not be read. Please try again.');
  tracker.data=data;
  if(realDay(data.today))tracker.today=data.today;
 }catch(error){
  if(!current()||error.name==='AbortError')return;
  tracker.data=null;tracker.error=error.message||'Attendance could not be loaded. Please try again.';
 }finally{
  if(current()){
   tracker.controller=null;tracker.loading=false;
   if(tracker.refreshQueued&&!document.hidden){tracker.refreshQueued=false;refreshTracker();}
   else repaint();
  }
 }
}
function startTimer(){if(!tracker.timer&&!document.hidden)tracker.timer=setInterval(()=>{if(ownPage()&&!document.hidden)refreshTracker();},30000);}
function lifecycle(){
 syncOwner();
 const changed=tracker.snapshot!==state;tracker.snapshot=state;
 const active=ownPage();
 if(!active){if(tracker.active){stopTimer();cancelRequest();}tracker.active=false;return;}
 const entering=!tracker.active;tracker.active=true;
 if(document.hidden){stopTimer();return;}
 startTimer();
 if(entering||changed){if(tracker.loading)tracker.refreshQueued=true;else refreshTracker();}
}
const trackerBaseRender=render;
render=function(){trackerBaseRender();lifecycle();};
document.addEventListener('submit',event=>{
 if(event.target.id!=='member-attendance-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 if(!ownPage()||tracker.loading)return;
 const period=document.getElementById('member-attendance-period').value,date=document.getElementById('member-attendance-date').value;
 if(!['week','month'].includes(period)||!realDay(date)||date>businessToday()){tracker.error='Choose a real date no later than today.';tracker.data=null;repaint();return;}
 Object.assign(tracker,{period,date,data:null,error:''});refreshTracker();
},true);
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-action="attendance-tracker-retry"],[data-action="attendance-tracker-refresh"]');
 if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();refreshTracker();
},true);
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){stopTimer();cancelRequest();return;}
 lifecycle();if(ownPage())refreshTracker();
});
window.addEventListener('focus',()=>{if(ownPage()&&!document.hidden)refreshTracker();});
window.addEventListener('pagehide',()=>{stopTimer();cancelRequest();tracker.active=false;});
window.addEventListener('pageshow',lifecycle);
