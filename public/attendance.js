'use strict';
// Task 13: attendance. Staff and administrators get an Attendance tab under Members (filters, totals, the
// visit list and a CSV export) and a "Visits today" card on the dashboard; members get "My visits". The
// server decides what each person may read (gymStaff and RLS); this file only renders.
const attendance={from:'',to:'',plan:'all',data:null,loading:false,error:''};
function attendanceDefaults(){if(!attendance.to){attendance.to=DEMO_DATE;attendance.from=addDays(DEMO_DATE,-6);}}
async function loadAttendance(){
 attendanceDefaults();attendance.loading=true;attendance.error='';
 try{attendance.data=await api(`/reports/attendance?from=${encodeURIComponent(attendance.from)}&to=${encodeURIComponent(attendance.to)}&plan=${encodeURIComponent(attendance.plan)}`);}
 catch(e){attendance.data=null;attendance.error=e.message;}
 finally{attendance.loading=false;if(section==='members'&&memberTab==='attendance')render();}
}
function attendancePanel(){
 attendanceDefaults();
 const d=attendance.data,t=d?.totals;
 const planOptions=['<option value="all">All plans</option>',...plans.map(p=>`<option value="${esc(p.id)}" ${attendance.plan===p.id?'selected':''}>${esc(p.name)}</option>`)].join('');
 const filters=`<form id="attendance-form" class="attendance-filters"><div class="field"><label for="attendance-from">From</label><input id="attendance-from" type="date" value="${esc(attendance.from)}" max="${DEMO_DATE}" required></div><div class="field"><label for="attendance-to">To</label><input id="attendance-to" type="date" value="${esc(attendance.to)}" max="${DEMO_DATE}" required></div><div class="field"><label for="attendance-plan">Plan</label><select id="attendance-plan">${planOptions}</select></div><button class="button primary" type="submit">Apply</button>${d?.visits.length?btn('Export CSV','attendance-export','','','download'):''}</form>`;
 // Filters, totals and messages sit inside the panel's padding; the table and the empty state run edge to edge.
 let top='',list='';
 if(attendance.loading)top='<p class="auth-help">Loading attendance…</p>';
 else if(attendance.error)top=`<div class="form-error" role="alert">${esc(attendance.error)}</div>`;
 else if(d){top=`<section class="stats-grid three" aria-label="Attendance totals">${stat('Visits',t.visits,`<span>${t.days} day${t.days===1?'':'s'} · ${date(d.from,true)} to ${date(d.to,true)}</span>`,'calendar',true)}${stat('Unique members',t.uniqueMembers,'<span>Different people who visited</span>','users')}${stat('Daily average',t.dailyAverage.toFixed(1),'<span>Visits per day in the range</span>','trend')}</section>`
  +(d.truncated?'<div class="notice">Showing the first 10,000 visits, and the totals cover those. Narrow the dates to see the rest.</div>':'');
  list=d.visits.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Time</th><th>Member</th><th>Plan</th><th>Confirmed by</th></tr></thead><tbody>${d.visits.map(v=>`<tr><td>${date(v.date)}</td><td>${esc(v.time)}</td><td><strong>${esc(v.name)}</strong></td><td>${esc(v.plan)}</td><td>${esc(v.confirmedBy)}</td></tr>`).join('')}</tbody></table></div>`
   :'<div class="empty"><h3>No visits in this range</h3><p>Try a longer range or another plan.</p></div>';}
 return `<section class="panel attendance-panel"><div class="panel-header"><div><h2>Attendance</h2><p>Staff-confirmed visits, newest first. Times are Manila time.</p></div></div><div class="attendance-body">${filters}${top}</div>${list}</section>`;
}
const attendanceBaseMembers=members;
members=function(){
 const html=attendanceBaseMembers();
 if(!can('roster')){if(memberTab==='attendance')memberTab='roster';return html;}
 const start=html.indexOf('aria-label="Membership sections"'),end=html.indexOf('</div>',start);
 if(start<0||end<0)return html;
 const tab=`<button class="tab ${memberTab==='attendance'?'active':''}" role="tab" aria-selected="${memberTab==='attendance'}" data-action="member-tab" data-tab="attendance">Attendance</button>`;
 if(memberTab==='attendance'&&!attendance.data&&!attendance.loading&&!attendance.error)queueMicrotask(loadAttendance);
 // On a phone the tab bar scrolls; after each render, bring the open tab into view (the bar only, never the page).
 queueMicrotask(()=>{const bar=document.querySelector('[aria-label="Membership sections"]'),open=bar?.querySelector('.tab.active');if(!open)return;const b=bar.getBoundingClientRect(),t=open.getBoundingClientRect();if(t.right>b.right)bar.scrollLeft+=t.right-b.right;else if(t.left<b.left)bar.scrollLeft-=b.left-t.left;});
 return html.slice(0,end)+tab+'</div>'+(memberTab==='attendance'?attendancePanel():html.slice(end+'</div>'.length));
};
document.addEventListener('submit',event=>{
 if(event.target.id!=='attendance-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 const from=document.getElementById('attendance-from').value,to=document.getElementById('attendance-to').value;
 if(!from||!to)return;
 Object.assign(attendance,{from,to,plan:document.getElementById('attendance-plan').value,data:null,error:''});
 loadAttendance();render();
},true);
document.addEventListener('click',event=>{
 if(!event.target.closest('[data-action="attendance-export"]'))return;
 event.preventDefault();event.stopImmediatePropagation();
 const d=attendance.data;if(!d)return;
 download(`RepReady-attendance-${d.from}-to-${d.to}.csv`,csv(['Date','Time (Manila)','Member ID','Member','Plan','Confirmed by'],d.visits.map(v=>[v.date,v.time,v.memberId,v.name,v.plan,v.confirmedBy])),'text/csv;charset=utf-8');
},true);

// The dashboard: today's visits, an exact count from the server.
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

// The member's own visits: the last 30 and this month's count.
const attendanceBaseMemberOverview=memberOverview;
memberOverview=function(){
 const html=attendanceBaseMemberOverview(),v=state.visits;
 if(currentUser?.role!=='member'||!v)return html;
 return html+`<section class="panel my-visits" aria-label="My visits"><div class="panel-header"><div><h2>My visits</h2><p>This month: ${v.thisMonth} visit${v.thisMonth===1?'':'s'}</p></div></div>${v.recent.length
  ?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Time (Manila)</th></tr></thead><tbody>${v.recent.map(x=>`<tr><td>${date(x.date)}</td><td>${esc(x.time)}</td></tr>`).join('')}</tbody></table></div>`
  :'<div class="empty"><h3>No visits yet</h3><p>Show your member QR at the front desk to check in.</p></div>'}</section>`;
};
