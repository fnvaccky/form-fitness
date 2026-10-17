'use strict';
// Attendance has its own navigation destination. Existing pass verification and server permissions are unchanged.
const attendance={from:'',to:'',plan:'all',search:'',data:null,loading:false,error:'',owner:'',request:0,active:false,snapshot:null,refreshQueued:false};
function attendanceDefaults(){if(!attendance.to){attendance.to=DEMO_DATE;attendance.from=addDays(DEMO_DATE,-6);}}
const attendanceOwner=()=>currentUser&&can('roster')?`${currentUser.id}:${currentUser.role}:${currentUser.workspace||''}`:'';
const attendanceIsOpen=()=>!!attendanceOwner()&&mode==='admin'&&section==='attendance';
function syncAttendanceOwner(){
 const owner=attendanceOwner();
 if(attendance.owner===owner)return;
 Object.assign(attendance,{from:'',to:'',plan:'all',search:'',data:null,loading:false,error:'',owner,request:attendance.request+1,active:false,snapshot:null,refreshQueued:false});
}
async function loadAttendance(){
 syncAttendanceOwner();
 if(!attendanceIsOpen())return;
 if(attendance.loading){attendance.refreshQueued=true;return;}
 attendanceDefaults();attendance.loading=true;attendance.error='';
 const owner=attendance.owner,request=++attendance.request;
 const query=new URLSearchParams({from:attendance.from,to:attendance.to,plan:attendance.plan});
 render();
 try{
  // Check the requesting account before acting on an HTTP error as well as successful data.
  // The shared API helper clears authentication on 401, which a previous account's reply must not do.
  const response=await fetch(`/api/reports/attendance?${query}`,{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();
  if(owner!==attendanceOwner()||request!==attendance.request)return;
  if(!response.ok)throw Error(data.error||'Attendance could not be loaded. Please try again.');
  attendance.data=data;
 }catch(error){
  if(owner!==attendanceOwner()||request!==attendance.request)return;
  attendance.data=null;attendance.error=error.message;
 }finally{
  if(owner===attendanceOwner()&&request===attendance.request){
   attendance.loading=false;
   if(attendance.refreshQueued&&attendanceIsOpen()){
    attendance.refreshQueued=false;loadAttendance();
   }else if(attendanceIsOpen())render();
  }
 }
}
function attendanceRows(){
 const query=attendance.search.trim().toLowerCase();
 return (attendance.data?.visits||[]).filter(visit=>!query||`${visit.name} ${visit.memberId}`.toLowerCase().includes(query));
}
function attendanceList(){
 const rows=attendanceRows();
 return rows.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Time</th><th>Member</th><th>Plan</th><th>Confirmed by</th></tr></thead><tbody>${rows.map(visit=>`<tr><td>${date(visit.date)}</td><td>${esc(visit.time)}</td><td><strong>${esc(visit.name)}</strong><small>${esc(visit.memberId)}</small></td><td>${esc(visit.plan)}</td><td>${esc(visit.confirmedBy)}</td></tr>`).join('')}</tbody></table></div>`
  :`<div class="empty"><h3>${attendance.search.trim()?'No matching visits':'No visits in this range'}</h3><p>${attendance.search.trim()?'Try another name or member ID.':'Try a longer range or another plan.'}</p></div>`;
}
function attendancePanel(){
 attendanceDefaults();
 const data=attendance.data,totals=data?.totals;
 const planOptions=['<option value="all">All plans</option>',...plans.map(plan=>`<option value="${esc(plan.id)}" ${attendance.plan===plan.id?'selected':''}>${esc(plan.name)}</option>`)].join('');
 const filters=`<form id="attendance-form" class="attendance-filters"><div class="field"><label for="attendance-from">From</label><input id="attendance-from" type="date" value="${esc(attendance.from)}" max="${DEMO_DATE}" required></div><div class="field"><label for="attendance-to">To</label><input id="attendance-to" type="date" value="${esc(attendance.to)}" max="${DEMO_DATE}" required></div><div class="field"><label for="attendance-plan">Plan</label><select id="attendance-plan">${planOptions}</select></div><button class="button primary" type="submit"${attendance.loading?' disabled':''}>Apply</button>${data?.visits.length?btn('Export CSV','attendance-export','','','download'):''}</form>`;
 let top='',list='';
 if(attendance.loading)top='<p class="auth-help" role="status">Loading attendance…</p>';
 else if(attendance.error)top=`<div class="form-error" role="alert">${esc(attendance.error)} ${btn('Retry','attendance-retry','small')}</div>`;
 else if(data){
  top=`<section class="stats-grid three" aria-label="Attendance totals">${stat('Visits',totals.visits,`<span>${totals.days} day${totals.days===1?'':'s'} · ${date(data.from,true)} to ${date(data.to,true)}</span>`,'calendar',true)}${stat('Unique members',totals.uniqueMembers,'<span>Different people who visited</span>','users')}${stat('Daily average',totals.dailyAverage.toFixed(1),'<span>Visits per day in the range</span>','trend')}</section>`
   +(data.truncated?'<div class="notice">Showing the first 10,000 visits, and the totals cover those. Narrow the dates to see the rest.</div>':'')
   +`<label class="searchbox attendance-search">${icon('search')}<input id="attendance-search" type="search" value="${esc(attendance.search)}" placeholder="Search name or member ID" aria-label="Search attendance"></label><p id="attendance-result-count" class="auth-help">${attendanceRows().length} of ${data.visits.length} visits shown. Totals cover the selected dates and plan.</p>`;
  list=attendanceList();
 }
 return `<section class="panel attendance-panel"><div class="panel-header"><div><h2>Attendance history</h2><p>Staff-confirmed visits, newest first. Times are Manila time.</p></div></div><div class="attendance-body">${filters}${top}</div><div id="attendance-results">${list}</div></section>`;
}
function memberAttendancePage(){
 if(currentUser?.role!=='member')return '<section class="panel"><div class="empty"><h2>Member attendance</h2><p>The private tracker is available in the member’s own signed-in account. Return to the staff workspace for authorized attendance reports.</p></div></section>';
 const visits=state.visits;
 if(!visits)return '<section class="panel"><div class="empty"><h2>Attendance is unavailable</h2><p>Reload your account to try again.</p></div></section>';
 return `<section class="panel my-visits" aria-label="My visits"><div class="panel-header"><div><h2>My visits</h2><p>This month: ${visits.thisMonth} visit${visits.thisMonth===1?'':'s'}${visits.last?` · Last visit: ${date(visits.last.date)}, ${esc(visits.last.time)}`:''}</p></div></div>${visits.recent.length
  ?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Time (Manila)</th></tr></thead><tbody>${visits.recent.map(visit=>`<tr><td>${date(visit.date)}</td><td>${esc(visit.time)}</td></tr>`).join('')}</tbody></table></div>`
  :'<div class="empty"><h3>No visits yet</h3><p>Show your member QR at the front desk to check in.</p></div>'}</section>`;
}
function attendancePage(){
 syncAttendanceOwner();
 const operational=mode==='admin'&&can('roster');
 const activeMember=currentUser?.role==='member'&&memberStatus(memberById(currentUser.memberId))==='Active';
 const actions=operational&&can('scan')?btn('Scan member','scanner','primary','','card'):activeMember?btn('Show my member QR','member-qr','primary','','card'):'';
 const accessNote=currentUser?.role==='member'&&!activeMember?'<div class="notice">An enabled account and active, fully paid current membership are required for a check-in pass. This tracker does not grant check-in access.</div>':'';
 return `<div class="attendance-page">${heading('Attendance',operational?'Verify member passes and review recorded gym visits.':'Your recorded gym visits and usual training days.',actions,'GYM VISITS')}${accessNote}${operational?attendancePanel():(window.memberAttendanceTracker?.()||memberAttendancePage())}</div>`;
}

// Re-entering the section and a fresh state after check-in both refresh the staff report.
// Owner/request checks prevent a previous account's delayed response entering another account's screen.
const attendanceBaseRender=render;
render=function(){
 syncAttendanceOwner();
 const active=attendanceIsOpen(),refresh=active&&(!attendance.active||attendance.snapshot!==state);
 attendance.active=active;attendance.snapshot=state;
 attendanceBaseRender();
 if(refresh)queueMicrotask(()=>{if(attendanceIsOpen())loadAttendance();});
};

document.addEventListener('submit',event=>{
 if(event.target.id!=='attendance-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 if(!attendanceIsOpen())return;
 const from=document.getElementById('attendance-from').value,to=document.getElementById('attendance-to').value;
 if(!from||!to)return;
 Object.assign(attendance,{from,to,plan:document.getElementById('attendance-plan').value,data:null,error:''});
 loadAttendance();
},true);
document.addEventListener('input',event=>{
 if(event.target.id!=='attendance-search'||!attendanceIsOpen())return;
 attendance.search=event.target.value;
 document.getElementById('attendance-results').innerHTML=attendanceList();
 document.getElementById('attendance-result-count').textContent=`${attendanceRows().length} of ${attendance.data.visits.length} visits shown. Totals cover the selected dates and plan.`;
});
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-action]');
 if(!button)return;
 if(button.dataset.action==='member-tab'&&button.dataset.tab==='attendance'){
  event.preventDefault();event.stopImmediatePropagation();
  if(can('roster'))navigate('attendance');
  return;
 }
 if(!['attendance-export','attendance-retry'].includes(button.dataset.action))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(!attendanceIsOpen())return;
 if(button.dataset.action==='attendance-retry'){loadAttendance();return;}
 const data=attendance.data;if(!data)return;
 download(`RepReady-attendance-${data.from}-to-${data.to}.csv`,csv(['Date','Time (Manila)','Member ID','Member','Plan','Confirmed by'],attendanceRows().map(visit=>[visit.date,visit.time,visit.memberId,visit.name,visit.plan,visit.confirmedBy])),'text/csv;charset=utf-8');
},true);

// Keep the dashboard's exact today's-visits summary, with detailed history on Attendance.
const attendanceBaseOverview=overview;
overview=function(){
 const html=attendanceBaseOverview();
 if(typeof state.stats?.visitsToday!=='number')return html;
 const marker='class="stats-grid" aria-label="Gym statistics">',at=html.indexOf(marker);
 if(at<0)return html;
 const close=html.indexOf('</section>',at);
 return html.slice(0,at)+'class="stats-grid with-visits" aria-label="Gym statistics">'+html.slice(at+marker.length,close)
  +stat('Visits today',state.stats.visitsToday,'<span>Staff-confirmed check-ins today</span>','clock')+html.slice(close);
};
const attendanceBaseMemberOverview=memberOverview;
memberOverview=function(){
 const html=attendanceBaseMemberOverview(),visits=state.visits;
 if(currentUser?.role!=='member'||!visits)return html;
 return html+`<section class="panel member-attendance-link"><div><h2>Your attendance</h2><p>This month: ${visits.thisMonth} visit${visits.thisMonth===1?'':'s'}${visits.last?` · Last visit: ${date(visits.last.date)}, ${esc(visits.last.time)}`:''}</p></div><a class="button" href="#/${mode}/attendance">View attendance</a></section>`;
};
