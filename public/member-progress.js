// Private, confirmed member-selected goals and measurements. Attendance calculations stay in their existing API.
import {validateProgressMutation,progressSummary,goalSuggestion} from './member-progress-model.js';

const LABELS={lose:'Lose weight',gain:'Gain weight',maintain:'Maintain weight',attendance:'Attendance consistency'};
const progress={owner:'',tab:'attendance',data:null,error:'',loading:false,saving:false,active:false,request:0,controller:null,mutationController:null,snapshot:null,goalDraft:null,weightDraft:null,deleteId:null,duplicateId:null,goalError:'',weightError:'',notice:'',statusRequest:null,attendance:null,attendanceError:'',attendanceLoading:false,attendanceController:null};
const ownerKey=()=>currentUser?.role==='member'&&currentUser.memberId?`${currentUser.id||''}:${currentUser.memberId}:${currentUser.workspace||''}`:'';
const isOpen=()=>!!ownerKey()&&mode==='member'&&section==='attendance'&&progress.tab==='progress'&&!!document.getElementById('member-progress');
const today=()=>progress.data?.today||DEMO_DATE;
const namedDate=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
const kg=value=>typeof value==='number'&&Number.isFinite(value)?`${value.toFixed(1)} kg`:'Not recorded';
const requestId=()=>crypto.randomUUID();
const button=(label,action,extra='',kind='')=>`<button type="button" class="button ${kind}" data-action="${action}" ${extra}${progress.saving?' disabled':''}>${label}</button>`;
const input=(label,name,value,type='number',extra='')=>`<div class="field"><label for="progress-${name}">${label}</label><input id="progress-${name}" name="${name}" type="${type}" value="${esc(value??'')}" ${extra}></div>`;

function abortReads(){progress.request++;progress.controller?.abort();progress.attendanceController?.abort();progress.controller=null;progress.attendanceController=null;progress.loading=false;progress.attendanceLoading=false;}
function syncOwner(){
 const owner=ownerKey();
 if(owner===progress.owner)return;
 abortReads();progress.mutationController?.abort();
 Object.assign(progress,{owner,tab:'attendance',data:null,error:'',saving:false,active:false,snapshot:null,goalDraft:null,weightDraft:null,deleteId:null,duplicateId:null,goalError:'',weightError:'',notice:'',statusRequest:null,attendance:null,attendanceError:'',mutationController:null});
}
function tabs(){return `<div class="tabs progress-tabs" role="tablist" aria-label="Attendance and progress"><button id="progress-tab-attendance" class="tab ${progress.tab==='attendance'?'active':''}" role="tab" aria-selected="${progress.tab==='attendance'}" aria-controls="member-attendance" data-action="progress-tab" data-tab="attendance">Attendance</button><button id="progress-tab-progress" class="tab ${progress.tab==='progress'?'active':''}" role="tab" aria-selected="${progress.tab==='progress'}" aria-controls="member-progress" data-action="progress-tab" data-tab="progress">My progress</button></div>`;}

// Reuse the existing tracker and its lifecycle without reading private progress for staff/admin previews.
const progressBaseAttendancePage=attendancePage;
attendancePage=function(){
 syncOwner();
 if(currentUser?.role!=='member'||mode!=='member')return progressBaseAttendancePage();
 if(progress.tab==='attendance'){
  return progressBaseAttendancePage().replace('<h1>Attendance</h1>','<h1>Attendance &amp; Progress</h1>')
   .replace('<section id="member-attendance"',`${tabs()}<section id="member-attendance"`);
 }
 return `<div class="attendance-page">${heading('Attendance &amp; Progress','Your recorded visits, chosen goals and dated measurements.','','YOUR FITNESS JOURNEY')}${tabs()}${panelMarkup()}</div>`;
};

function goalEditor(){
 const draft=progress.goalDraft;if(!draft)return '';
 const weightGoal=draft.goalType!=='attendance',health=progress.data?.healthWeight;
 const existing=progress.data?.currentGoal;
 const title=draft.action==='new_goal'?'Start a new goal':existing?'Edit goal settings':'Choose your goal';
 const options=[['','Choose a goal'],...Object.entries(LABELS)].map(([value,label])=>`<option value="${value}"${draft.goalType===value?' selected':''}>${label}</option>`).join('');
 const healthNote=health?.weightKg?`<p class="progress-note" id="progress-health-source">Saved health-profile weight: ${kg(health.weightKg)}. Profile recorded ${esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(health.recordedAt)))} (Manila time). This is a profile timestamp, not a confirmed measurement date. Confirm when you actually measured it.</p>`:'';
 return `<form id="progress-goal-form" class="progress-editor" novalidate aria-labelledby="progress-goal-editor-title"${progress.saving?' aria-busy="true"':''}><fieldset${progress.saving?' disabled':''}><legend id="progress-goal-editor-title">${title}</legend><p class="progress-note">${esc(goalSuggestion(memberById(currentUser.memberId)?.goal).message)}</p><div id="progress-goal-error" class="form-error" role="alert"${progress.goalError?'':' hidden'}>${esc(progress.goalError)}</div><div class="form-grid"><div class="field"><label for="progress-goalType">Goal</label><select id="progress-goalType" name="goalType" required>${options}</select></div>${input('Goal start date','startDate',draft.startDate,'date',`required max="${esc(today())}"`)}</div>${weightGoal?`<div class="form-grid">${input('Starting / reference weight (kg)','startingWeightKg',draft.startingWeightKg,'number','required min="10" max="500" step="0.1" inputmode="decimal"')}${input('Actual measurement date','measurementDate',draft.measurementDate,'date',`required max="${esc(draft.startDate||today())}"`)}${draft.goalType==='maintain'?'':input('Target weight (kg, optional)','targetWeightKg',draft.targetWeightKg,'number','min="10" max="500" step="0.1" inputmode="decimal"')}</div>${healthNote}<p class="progress-note">Use a measurement on or before the goal start date. Saving records this starting weigh-in if that date is new. An existing different value must be corrected explicitly first. A goal keeps its confirmed starting reference even if that weigh-in is later corrected or deleted. Targets are your own choice, not medical recommendations.</p>`:'<p class="progress-note">Attendance uses the usual weekdays and schedule history already saved in your fitness profile. No second schedule, weight or height is needed. Attendance does not measure strength or exercise completion.</p>'}<label class="checkline progress-confirm"><input id="progress-goal-confirm" name="confirmed" type="checkbox"${draft.confirmed?' checked':''} required><span>I confirm this goal${weightGoal?' and the actual starting measurement date':''}.</span></label><p class="progress-note">${draft.action==='new_goal'?'Your previous goal period and all weigh-ins stay in your history.':existing?'Saving keeps earlier goal settings in your history.':'Survey suggestions are optional. Nothing is created until you confirm and save.'}</p><div class="progress-actions">${button('Cancel','progress-cancel-goal')}<button class="button primary" type="submit">${progress.saving?'Saving…':'Save goal'}</button></div></fieldset></form>`;
}
function chartMarkup(summary){
 const records=summary.chart||[];
 if(records.length<2)return `<p class="progress-note" id="progress-chart-empty">${records.length?'One dated measurement recorded. Add another actual measurement to see a chart.':'No dated measurements for this goal yet. Add a measurement to begin.'}</p>`;
 const width=580,height=240,left=54,right=18,top=20,bottom=42;
 const values=records.map(record=>record.weightKg),low=Math.min(...values),high=Math.max(...values),pad=Math.max((high-low)*.1,.5),min=low-pad,max=high+pad;
 const first=Date.parse(records[0].date+'T12:00:00Z'),last=Date.parse(records.at(-1).date+'T12:00:00Z');
 const x=record=>left+(Date.parse(record.date+'T12:00:00Z')-first)/(last-first||1)*(width-left-right),y=record=>top+(max-record.weightKg)/(max-min)*(height-top-bottom);
 const points=records.map(record=>`${x(record)},${y(record)}`).join(' ');
 const description=records.map(record=>`${namedDate(record.date)}: ${kg(record.weightKg)}`).join('; ');
 return `<figure class="progress-chart"><svg id="progress-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="progress-chart-title progress-chart-description"><title id="progress-chart-title">Recorded weight over time</title><desc id="progress-chart-description">${esc(description)}</desc><line x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}" class="progress-chart-axis"/><line x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}" class="progress-chart-axis"/><text x="${left-8}" y="${top+8}" text-anchor="end">${max.toFixed(1)}</text><text x="${left-8}" y="${height-bottom}" text-anchor="end">${min.toFixed(1)}</text><text x="${left}" y="${height-14}">${esc(records[0].date)}</text><text x="${width-right}" y="${height-14}" text-anchor="end">${esc(records.at(-1).date)}</text><polyline points="${points}" class="progress-chart-line"/>${records.map(record=>`<circle cx="${x(record)}" cy="${y(record)}" r="4" class="progress-chart-point"><title>${esc(namedDate(record.date))}: ${kg(record.weightKg)}</title></circle>`).join('')}</svg><figcaption>Actual dated weigh-ins only, in kilograms. A connecting line does not infer unrecorded measurements or explain why weight changed.</figcaption></figure>`;
}
function goalSummary(){
 const goal=progress.data.currentGoal;
 if(!goal){
  const suggestion=goalSuggestion(memberById(currentUser.memberId)?.goal);
  return `<div class="progress-empty"><h3>No current goal</h3><p>${esc(suggestion.message)}</p><p>Your saved survey helps suggest choices. You choose and confirm a goal; survey or BMI changes never create one automatically.</p>${button('Choose a goal','progress-start-goal','','primary')}</div>`;
 }
 const summary=progressSummary(goal,progress.data.measurements),weightGoal=goal.goalType!=='attendance';
 const latest=summary.latestWeightKg===null?'No logged measurement for this goal':`${kg(summary.latestWeightKg)} · ${namedDate(summary.latestDate)}`;
 const changed=summary.changeKg===null?'No recorded change yet':`${summary.changeKg>0?'+':''}${summary.changeKg.toFixed(1)} kg from the confirmed reference`;
 const meter=summary.percentage===null?'':`<div class="progress-target"><label for="progress-target-meter">Toward your chosen target: ${summary.percentage.toFixed(1)}%</label><progress id="progress-target-meter" max="100" value="${Math.max(0,Math.min(100,summary.percentage))}"></progress><p>The visual is limited to 0–100%; actual measurements above remain unchanged. Moving beyond a target receives no extra credit.</p></div>`;
 return `<section id="progress-summary" aria-labelledby="progress-current-title"><div class="progress-goal-heading"><div><h3 id="progress-current-title">${LABELS[goal.goalType]}</h3><span class="badge">${goal.status==='paused'?'Paused':'Active'}</span><p>Started ${namedDate(goal.startDate)}</p></div><div class="progress-actions">${button('Edit goal','progress-edit-goal')}${button(goal.status==='paused'?'Resume':'Pause',goal.status==='paused'?'progress-resume-goal':'progress-pause-goal')}${button('Start a new goal','progress-new-goal')}</div></div>${!progress.goalDraft&&progress.goalError?`<p id="progress-goal-error" class="form-error" role="alert">${esc(progress.goalError)}</p>`:''}${weightGoal?`<dl class="progress-values"><div><dt>Starting / reference</dt><dd>${kg(goal.startingWeightKg)}</dd><small>Measured ${namedDate(goal.measurementDate)}</small></div><div><dt>Latest logged weight</dt><dd>${esc(latest)}</dd><small>Source: dated weigh-in for this goal period</small></div>${goal.targetWeightKg===null?'':`<div><dt>Your target</dt><dd>${kg(goal.targetWeightKg)}</dd><small>Member-selected, not prescribed</small></div>`}<div><dt>Recorded change</dt><dd>${esc(changed)}</dd></div></dl>${meter}${chartMarkup(summary)}`:'<p class="progress-note">Attendance consistency uses the existing usual-day schedule and its history. See the separate attendance summary below or the Attendance tab for full dates and check-in history.</p>'}${goal.status==='paused'?'<p class="progress-note">This goal is paused. Your settings and weigh-ins remain saved; you can still correct or add records.</p>':''}</section>`;
}
function weightEditor(){
 const draft=progress.weightDraft||{id:null,date:today(),weightKg:''},duplicate=progress.data.measurements.find(record=>record.id===progress.duplicateId);
 return `<form id="progress-weight-form" class="progress-editor" novalidate${progress.saving?' aria-busy="true"':''}><fieldset${progress.saving?' disabled':''}><legend>${draft.id?'Correct a dated measurement':'Add a weigh-in'}</legend><div id="progress-weight-error" class="form-error" role="alert"${progress.weightError?'':' hidden'}>${esc(progress.weightError)}</div><div class="form-grid">${input('Measurement date (Manila gym date)','date',draft.date,'date',`required max="${esc(today())}"`)}${input('Weight (kg)','weightKg',draft.weightKg,'number','required min="10" max="500" step="0.1" inputmode="decimal"')}</div><p class="progress-note">10–500 kg, up to one decimal place. These are data-entry limits, not a recommended weight. Records do not overwrite your separate health profile.</p>${duplicate?`<div id="progress-duplicate" class="notice"><div>A measurement already exists for ${namedDate(duplicate.date)} (${kg(duplicate.weightKg)}). Nothing has been replaced. ${button('Edit existing measurement','progress-replace-weight')}</div></div>`:''}<div class="progress-actions">${draft.id?button('Cancel correction','progress-cancel-weight'):''}<button type="submit" class="button primary">${progress.saving?'Saving…':draft.id?'Save corrected measurement':'Record weight'}</button></div></fieldset></form>`;
}
function measurementHistory(){
 const records=[...progress.data.measurements].sort((a,b)=>b.date.localeCompare(a.date));
 const health=progress.data.healthWeight;
 const latest=records[0];
 const current=progress.data.currentGoal,allSummary=progressSummary(null,records);
 const currentHasChart=current&&current.goalType!=='attendance'&&progressSummary(current,records).hasChart;
 const historyChart=allSummary.hasChart&&!currentHasChart?`<section class="progress-all-weights" aria-label="All recorded weights"><h3>All recorded weights</h3><p class="progress-note">This chart spans your saved measurements across goal periods. It is separate from progress toward the current goal and does not prescribe a target or claim a health trend.</p>${chartMarkup(allSummary)}</section>`:'';
 const source=health?.weightKg?`<p class="progress-note" id="progress-health-weight">Separate health-profile weight: ${kg(health.weightKg)}, profile saved ${esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(health.recordedAt)))} (Manila time). This is not a dated weigh-in. ${latest?`Latest logged measurement: ${kg(latest.weightKg)} on ${namedDate(latest.date)}.`:'No dated weight has been logged.'}</p>`:'';
 const rows=records.map(record=>`<tr data-measurement-id="${esc(record.id)}"><td><time datetime="${esc(record.date)}">${namedDate(record.date)}</time></td><td>${kg(record.weightKg)}</td><td><div class="progress-row-actions">${button('Correct','progress-edit-weight',`data-id="${esc(record.id)}"`,'small')}${button('Delete','progress-delete-weight',`data-id="${esc(record.id)}"`,'small')}</div></td></tr>`).join('');
 const deletion=records.find(record=>record.id===progress.deleteId);
 return `<section class="progress-measurements" aria-labelledby="progress-measurements-title"><h3 id="progress-measurements-title">Your dated weigh-ins</h3>${source}${weightEditor()}${deletion?`<div id="progress-delete-confirm" class="notice" role="alert"><div><strong>Delete ${kg(deletion.weightKg)} from ${namedDate(deletion.date)}?</strong><p>This removes the chart point and may change the latest value and recorded change. The goal’s confirmed starting reference remains unchanged.</p><div class="progress-actions">${button('Keep measurement','progress-cancel-delete')}${button('Delete measurement','progress-confirm-delete','','danger')}</div></div></div>`:''}${historyChart}${records.length?`<div class="table-scroll"><table class="data-table"><caption class="sr-only">Dated measurements, newest first</caption><thead><tr><th>Date</th><th>Weight</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="progress-note">No dated weigh-ins yet. No measurements have been inferred from your profile or attendance.</p>'}</section>`;
}
function goalHistory(){
 const history=progress.data.goals.filter(goal=>goal.id!==progress.data.currentGoal?.id);
 if(!history.length)return '';
 const timestamp=value=>esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)));
 return `<details id="progress-goal-history" class="progress-history"><summary>Earlier goal periods and settings (${history.length})</summary><ul>${history.map(goal=>`<li><strong>${LABELS[goal.goalType]}</strong> · ${goal.status==='paused'?'Paused':'Active'} at the time · started ${namedDate(goal.startDate)}${goal.startingWeightKg===null?'':` · reference ${kg(goal.startingWeightKg)} on ${namedDate(goal.measurementDate)}`}${goal.targetWeightKg===null?'':` · target ${kg(goal.targetWeightKg)}`}<small>${goal.periodId===progress.data.currentGoal?.periodId?'Earlier settings for the current goal':'Earlier goal period'}. Saved ${timestamp(goal.recordedAt)}${goal.endedAt?`; superseded ${timestamp(goal.endedAt)}`:''} (Manila time). Earlier settings remain as recorded.</small></li>`).join('')}</ul></details>`;
}
function attendanceSummary(){
 const data=progress.attendance,summary=data?.summary;
 const content=progress.attendanceError?`<p class="form-error" role="alert">${esc(progress.attendanceError)} ${button('Retry attendance','progress-attendance-retry')}</p>`:summary?`<p>${summary.completedAttended} of ${summary.completedPlanned} completed usual training days attended.</p><p><strong>${summary.percentage===null?'Not enough history yet':`${esc(summary.percentage)}% · ${esc(summary.label)}`}</strong> · ${summary.attendedDays} distinct attended days · ${summary.events} check-in events.</p><p>${namedDate(data.from)}–${namedDate(data.to)}. Today, future, unselected and ineligible dates keep the existing exclusions. Extra visits do not replace another usual date.</p>`:'<p role="status">Loading the existing attendance summary…</p>';
 return `<section id="progress-attendance-summary" class="progress-attendance-summary" aria-labelledby="progress-attendance-title"><h3 id="progress-attendance-title">Attendance — separate from weight progress</h3>${content}<p><a href="#/member/attendance" data-action="progress-attendance-link">See full attendance tracker and schedule history</a>. Attendance does not explain or prove a cause for weight changes.</p></section>`;
}
function panelMarkup(){
 const error=progress.error?`<div id="progress-error" class="form-error" role="alert">${esc(progress.error)} ${button('Retry loading','progress-retry')}</div>`:'';
 const data=progress.data;
 return `<section id="member-progress" class="panel member-progress" aria-labelledby="member-progress-title"${progress.loading||progress.saving?' aria-busy="true"':''}><div class="panel-header"><div><h2 id="member-progress-title">My progress</h2><p>Your goals and measurements are private to your enabled member account.</p></div>${button('Refresh saved records','progress-retry','','small')}</div><div class="member-progress-body"><p class="progress-note">Track your own choices and recorded measurements. This does not diagnose health, prescribe a target weight or diet, or change your membership.</p><p id="progress-status" role="status">${esc(progress.saving?'Saving…':progress.notice)}</p>${error}${data?`${goalSummary()}${goalEditor()}${measurementHistory()}${goalHistory()}${attendanceSummary()}`:progress.loading?'<p role="status">Loading your saved progress…</p>':''}</div></section>`;
}
function repaint(){
 const old=document.getElementById('member-progress');if(!old||!isOpen())return;
 const focused=old.contains(document.activeElement)?document.activeElement.id:null;
 old.outerHTML=panelMarkup();
 if(focused)document.getElementById(focused)?.focus({preventScroll:true});
}
function validView(data){return data&&typeof data.today==='string'&&Array.isArray(data.goals)&&Array.isArray(data.measurements)&&Object.hasOwn(data,'currentGoal');}
async function loadProgress(){
 syncOwner();if(!isOpen()||progress.loading||progress.saving)return;
 const owner=progress.owner,sequence=++progress.request,controller=new AbortController();
 progress.controller=controller;progress.loading=true;progress.error='';repaint();
 const current=()=>owner===ownerKey()&&owner===progress.owner&&sequence===progress.request&&isOpen();
 try{
  const response=await fetch('/api/member-progress',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  const payload=await response.json();if(!current())return;
  if(!response.ok){if([401,403].includes(response.status))progress.data=null;throw Error(payload.error||'Your progress could not be loaded.');}
  if(!validView(payload.memberProgress))throw Error('Your saved progress could not be read.');
  progress.data=payload.memberProgress;
 }catch(error){if(current()&&error.name!=='AbortError')progress.error=error.message||'Your progress could not be loaded. Please retry.';}
 finally{if(current()){progress.loading=false;progress.controller=null;repaint();}}
}
async function loadAttendanceSummary(){
 if(!isOpen()||progress.attendanceLoading)return;
 const owner=progress.owner,controller=new AbortController();progress.attendanceController=controller;progress.attendanceLoading=true;progress.attendanceError='';
 const current=()=>owner===ownerKey()&&owner===progress.owner&&progress.attendanceController===controller&&isOpen();
 try{
  const query=new URLSearchParams({period:'week',date:today()});
  const response=await fetch(`/api/member-attendance?${query}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  const data=await response.json();if(!current())return;
  if(!response.ok||!data.summary)throw Error(data.error||'Attendance summary could not be loaded.');
  progress.attendance=data;
 }catch(error){if(current()&&error.name!=='AbortError')progress.attendanceError=error.message||'Attendance summary could not be loaded.';}
 finally{if(current()){progress.attendanceLoading=false;progress.attendanceController=null;repaint();}}
}
function lifecycle(){
 syncOwner();const active=isOpen(),changed=progress.snapshot!==state;progress.snapshot=state;
 if(!active){if(progress.active){abortReads();progress.mutationController?.abort();progress.mutationController=null;progress.saving=false;}progress.active=false;return;}
 const entering=!progress.active;progress.active=true;
 if((entering||changed)&&!progress.saving){loadProgress();loadAttendanceSummary();}
}
const progressBaseRender=render;
render=function(){progressBaseRender();lifecycle();};

function makeGoalDraft(action){
 const current=progress.data?.currentGoal,health=progress.data?.healthWeight;
 const editing=action==='save_goal'&&current;
 return {action,requestId:requestId(),goalId:editing?current.id:current?.id||null,goalType:editing?current.goalType:'',startDate:editing?current.startDate:today(),startingWeightKg:editing?current.startingWeightKg:health?.weightKg??'',measurementDate:editing?current.measurementDate||'':'',targetWeightKg:editing?current.targetWeightKg??'':'',confirmed:false};
}
function captureDraft(form){
 const data=new FormData(form);
 if(form.id==='progress-goal-form'&&progress.goalDraft){
  const draft=progress.goalDraft;
  Object.assign(draft,{goalType:data.get('goalType'),startDate:data.get('startDate'),confirmed:data.get('confirmed')==='on'});
  for(const key of ['startingWeightKg','measurementDate','targetWeightKg'])if(data.has(key))draft[key]=data.get(key);
 }else if(form.id==='progress-weight-form'){
  progress.weightDraft={id:progress.weightDraft?.id||null,date:data.get('date'),weightKg:data.get('weightKg')};
 }
}
async function mutate(body,kind,onSuccess){
 if(!isOpen()||progress.saving)return;
 try{body=validateProgressMutation(body,today());}catch(error){progress[kind==='goal'?'goalError':'weightError']=error.message;repaint();return;}
 // An older refresh must never replace a later mutation's confirmed result.
 progress.request++;progress.controller?.abort();progress.controller=null;progress.loading=false;
 const owner=progress.owner,controller=new AbortController();progress.mutationController=controller;progress.saving=true;progress.notice='';progress[kind==='goal'?'goalError':'weightError']='';repaint();
 const current=()=>owner===ownerKey()&&owner===progress.owner&&progress.mutationController===controller&&isOpen();
 try{
  const response=await fetch('/api/member-progress',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const payload=await response.json();if(!current())return;
  if(!response.ok)throw Object.assign(Error(payload.error||'This change could not be saved. Your draft is kept for retry.'),{status:response.status});
  if(!validView(payload.memberProgress))throw Error('The saved result could not be confirmed. Your draft is kept; retry before treating it as recorded.');
  progress.data=payload.memberProgress;onSuccess();progress.notice='Saved. Progress uses your confirmed records.';
 }catch(error){if(current()&&error.name!=='AbortError'){
  if([401,403].includes(error.status)){progress.data=null;progress.error=error.message||'Your session cannot access private progress. Sign in again.';}
  else progress[kind==='goal'?'goalError':'weightError']=`${error.message||'The change could not be saved.'} Your draft is kept. Retry when ready.`;
 }}
 finally{if(current()){progress.mutationController=null;progress.saving=false;repaint();}}
}
document.addEventListener('input',event=>{
 const form=event.target.closest('#progress-goal-form,#progress-weight-form');if(!form||!isOpen()||progress.saving)return;
 captureDraft(form);if(form.id==='progress-goal-form')progress.goalDraft.requestId=requestId();
});
document.addEventListener('change',event=>{
 const form=event.target.closest('#progress-goal-form,#progress-weight-form');if(!form||!isOpen()||progress.saving)return;
 captureDraft(form);if(form.id==='progress-goal-form'){progress.goalDraft.requestId=requestId();if(event.target.name==='goalType')repaint();}
});
document.addEventListener('submit',event=>{
 if(!['progress-goal-form','progress-weight-form'].includes(event.target.id))return;
 event.preventDefault();event.stopImmediatePropagation();if(!isOpen()||progress.saving||!progress.data)return;
 captureDraft(event.target);
 if(event.target.id==='progress-goal-form'){
  const draft=progress.goalDraft;if(!draft)return;
  if(!draft.confirmed){progress.goalError='Confirm your chosen goal and, when needed, its actual measurement date.';repaint();return;}
  const weightGoal=draft.goalType!=='attendance';
  const number=value=>value===''||value===null?null:Number(value);
  const body={action:draft.action,requestId:draft.requestId,goalId:draft.goalId,goalType:draft.goalType,startDate:draft.startDate,startingWeightKg:weightGoal?number(draft.startingWeightKg):null,measurementDate:weightGoal?draft.measurementDate||null:null,targetWeightKg:weightGoal&&draft.goalType!=='maintain'?number(draft.targetWeightKg):null};
  mutate(body,'goal',()=>{progress.goalDraft=null;progress.goalError='';});
 }else{
  const draft=progress.weightDraft;
  const duplicate=progress.data.measurements.find(record=>record.date===draft.date&&record.id!==draft.id);
  if(duplicate){progress.duplicateId=duplicate.id;progress.weightError='That date already has a measurement. Open its explicit correction flow; no value has been replaced.';repaint();return;}
  const body=draft.id?{action:'update_weight',id:draft.id,date:draft.date,weightKg:draft.weightKg===''?null:Number(draft.weightKg)}:{action:'add_weight',date:draft.date,weightKg:draft.weightKg===''?null:Number(draft.weightKg)};
  mutate(body,'weight',()=>{progress.weightDraft=null;progress.weightError='';progress.duplicateId=null;});
 }
},true);
document.addEventListener('click',event=>{
 const control=event.target.closest('[data-action^="progress-"]');if(!control)return;
 event.preventDefault();event.stopImmediatePropagation();syncOwner();
 if(!ownerKey()||mode!=='member'||section!=='attendance')return;
 const action=control.dataset.action;
 if(action==='progress-tab'||action==='progress-attendance-link'){
  const tab=action==='progress-attendance-link'?'attendance':control.dataset.tab;
  if(!['attendance','progress'].includes(tab)||progress.saving)return;
  progress.tab=tab;render();document.getElementById(`progress-tab-${tab}`)?.focus();return;
 }
 if(!isOpen()||progress.saving)return;
 if(action==='progress-retry'){loadProgress();return;}
 if(action==='progress-attendance-retry'){loadAttendanceSummary();return;}
 if(!progress.data)return;
 progress.notice='';
 if(['progress-start-goal','progress-edit-goal','progress-new-goal'].includes(action)){
  progress.goalDraft=makeGoalDraft(action==='progress-new-goal'?'new_goal':'save_goal');progress.goalError='';repaint();document.getElementById('progress-goalType')?.focus();return;
 }
 if(action==='progress-cancel-goal'){progress.goalDraft=null;progress.goalError='';repaint();return;}
 if(['progress-pause-goal','progress-resume-goal'].includes(action)){
  const current=progress.data.currentGoal;if(!current)return;
  const statusAction=action==='progress-pause-goal'?'pause_goal':'resume_goal';
  if(progress.statusRequest?.action!==statusAction||progress.statusRequest?.goalId!==current.id)progress.statusRequest={action:statusAction,goalId:current.id,requestId:requestId()};
  mutate(progress.statusRequest,'goal',()=>{progress.statusRequest=null;progress.goalDraft=null;progress.goalError='';});return;
 }
 if(action==='progress-edit-weight'||action==='progress-replace-weight'){
  const record=progress.data.measurements.find(item=>item.id===(action==='progress-replace-weight'?progress.duplicateId:control.dataset.id));if(!record)return;
  progress.weightDraft={id:record.id,date:record.date,weightKg:record.weightKg};progress.weightError='';progress.duplicateId=null;repaint();document.getElementById('progress-weightKg')?.focus();return;
 }
 if(action==='progress-cancel-weight'){progress.weightDraft=null;progress.weightError='';progress.duplicateId=null;repaint();return;}
 if(action==='progress-delete-weight'){progress.deleteId=control.dataset.id;progress.weightError='';repaint();return;}
 if(action==='progress-cancel-delete'){progress.deleteId=null;repaint();return;}
 if(action==='progress-confirm-delete'&&progress.deleteId){
  const deletedId=progress.deleteId;
  mutate({action:'delete_weight',id:deletedId},'weight',()=>{progress.deleteId=null;progress.weightError='';if(progress.weightDraft?.id===deletedId)progress.weightDraft=null;});
 }
},true);
window.addEventListener('focus',()=>{if(isOpen()&&!document.hidden){loadProgress();loadAttendanceSummary();}});
window.addEventListener('pagehide',()=>{abortReads();progress.mutationController?.abort();progress.mutationController=null;progress.saving=false;progress.active=false;});
window.addEventListener('pageshow',lifecycle);
