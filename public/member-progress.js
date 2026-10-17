// Private, confirmed member-selected goals and measurements. Attendance calculations stay in their existing API.
import {validateProgressMutation,progressSummary,goalSuggestion} from './member-progress-model.js';

const LABELS={lose:'Lose weight',gain:'Gain weight',maintain:'Maintain weight',attendance:'Attendance consistency'};
const progress={owner:'',data:null,error:'',loading:false,saving:false,active:false,request:0,controller:null,mutationController:null,snapshot:null,editor:null,goalDraft:null,weightDraft:null,deleteId:null,goalError:'',weightError:'',notice:'',statusRequest:null};
const ownerKey=()=>currentUser?.role==='member'&&currentUser.memberId?`${currentUser.id||''}:${currentUser.memberId}:${currentUser.workspace||''}`:'';
const isOpen=()=>!!ownerKey()&&mode==='member'&&section==='goal'&&!!document.getElementById('member-progress');
const today=()=>progress.data?.today||DEMO_DATE;
const namedDate=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
const kg=value=>typeof value==='number'&&Number.isFinite(value)?`${value.toFixed(1)} kg`:'Not recorded';
const requestId=()=>crypto.randomUUID();
const button=(label,action,extra='',kind='')=>action==='progress-record-weight'&&progress.editor==='weight'?'':`<button type="button" class="button ${kind}" data-action="${action}" ${extra}${progress.saving?' disabled':''}>${label}</button>`;
const input=(label,name,value,type='number',extra='')=>`<div class="field"><label for="progress-${name}">${label}</label><input id="progress-${name}" name="${name}" type="${type}" value="${esc(value??'')}" ${extra}></div>`;

function abortReads(){progress.request++;progress.controller?.abort();progress.controller=null;progress.loading=false;}
function syncOwner(){
 const owner=ownerKey();
 if(owner===progress.owner)return;
 abortReads();progress.mutationController?.abort();
 Object.assign(progress,{owner,data:null,error:'',saving:false,active:false,snapshot:null,editor:null,goalDraft:null,weightDraft:null,deleteId:null,goalError:'',weightError:'',notice:'',statusRequest:null,mutationController:null});
}
// The router exposes this page only to an actual member; previews never read private progress.
window.memberGoalPage=function(){
 syncOwner();
 if(!ownerKey()||mode!=='member')return '';
 return `<div class="member-goal-page">${heading('My goal','Your chosen goal and recorded weight, in one place.','','YOUR FITNESS JOURNEY')}${panelMarkup()}</div>`;
};

function goalEditor(){
 const draft=progress.goalDraft;if(!draft||progress.editor!=='goal')return '';
 const weightGoal=draft.goalType!=='attendance',health=progress.data?.healthWeight;
 const existing=progress.data?.currentGoal;
 const title=draft.action==='new_goal'?'Start a new goal':existing?'Edit goal settings':'Choose your goal';
 const options=[['','Choose a goal'],...Object.entries(LABELS)].map(([value,label])=>`<option value="${value}"${draft.goalType===value?' selected':''}>${label}</option>`).join('');
 const sourceOptions=[['manual',existing&&draft.action==='save_goal'?'Keep confirmed starting reference':'Enter a starting measurement'],...[...progress.data.measurements].sort((a,b)=>b.date.localeCompare(a.date)).map(record=>[`measurement:${record.id}`,`${namedDate(record.date)} — ${kg(record.weightKg)}`]),...(health?.weightKg?[['health','Use optional health-profile weight']]:[])].map(([value,label])=>`<option value="${esc(value)}"${draft.startingSource===value?' selected':''}>${esc(label)}</option>`).join('');
 const healthNote=draft.startingSource==='health'&&health?.weightKg?`<p class="progress-note" id="progress-health-source">Health-profile weight: ${kg(health.weightKg)}. Profile saved ${esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(health.recordedAt)))} (Manila time). This is not its measurement date; enter when you actually measured it. Saving this goal will not change your health profile.</p>`:'';
 const dateChoice=`<p class="progress-note">${draft.differentStart?'Choose when this goal began.':`Goal starts ${namedDate(draft.startDate)}${draft.startDate===today()?' (today)':''}.`}</p><label class="checkline"><input id="progress-different-start" name="differentStart" type="checkbox"${draft.differentStart?' checked':''}><span>Use a different goal start date</span></label>${draft.differentStart?input('Goal start date','startDate',draft.startDate,'date',`required max="${esc(today())}"`):''}`;
 return `<form id="progress-goal-form" class="progress-editor" novalidate aria-labelledby="progress-goal-editor-title"${progress.saving?' aria-busy="true"':''}><fieldset${progress.saving?' disabled':''}><legend id="progress-goal-editor-title">${title}</legend><div id="progress-goal-error" class="form-error" role="alert"${progress.goalError?'':' hidden'}>${esc(progress.goalError)}</div><div class="field"><label for="progress-goalType">Goal</label><select id="progress-goalType" name="goalType" required>${options}</select></div>${dateChoice}${weightGoal?`<div class="field progress-source"><label for="progress-starting-source">Starting weight</label><select id="progress-starting-source" name="startingSource">${sourceOptions}</select></div>${healthNote}<div class="form-grid">${input('Starting weight (kg)','startingWeightKg',draft.startingWeightKg,'number','required min="10" max="500" step="0.1" inputmode="decimal"')}${input('Starting measurement date','measurementDate',draft.measurementDate,'date',`required max="${esc(draft.startDate||today())}"`)}${draft.goalType==='maintain'?'':input('Target weight (kg, optional)','targetWeightKg',draft.targetWeightKg,'number','min="10" max="500" step="0.1" inputmode="decimal"')}</div><p class="progress-note">The measurement date is when you actually weighed yourself. It can be earlier than the goal start, but cannot be later.</p><details class="progress-help"><summary>Starting weights, targets and history</summary><p>A new date adds a starting measurement. An existing different value must be edited in Weight history first. Your goal keeps its confirmed reference if a measurement is later edited or deleted. Targets are your choice, not medical recommendations. Weight entries allow 10–500 kg and one decimal place; these are data-entry limits.</p></details>`:'<p class="progress-note">Your Attendance page uses the usual weekdays and history already saved in your fitness profile. No weight is needed.</p>'}<label class="checkline progress-confirm"><input id="progress-goal-confirm" name="confirmed" type="checkbox"${draft.confirmed?' checked':''} required><span>I confirm this goal${weightGoal?' and the actual starting measurement date':''}.</span></label><p class="progress-note">${draft.action==='new_goal'?'Your previous goal and measurements stay in history.':existing?'Earlier goal settings stay in history.':'Nothing is saved until you confirm.'}</p><div class="progress-actions">${button('Cancel','progress-cancel-goal')}<button class="button primary" type="submit">${progress.saving?'Saving…':'Save goal'}</button></div></fieldset></form>`;
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
 const latest=summary.latestWeightKg===null?'Not recorded':kg(summary.latestWeightKg);
 const changed=summary.changeKg===null?'No recorded change yet':`${summary.changeKg>0?'+':''}${summary.changeKg.toFixed(1)} kg from the confirmed reference`;
 const meter=summary.percentage===null?'':`<div class="progress-target"><label for="progress-target-meter">Toward your chosen target: ${summary.percentage.toFixed(1)}%</label><progress id="progress-target-meter" max="100" value="${Math.max(0,Math.min(100,summary.percentage))}"></progress><p>The visual is limited to 0–100%; actual measurements above remain unchanged. Moving beyond a target receives no extra credit.</p></div>`;
 return `<section id="progress-summary" aria-labelledby="progress-current-title"><div class="progress-goal-heading"><div><h3 id="progress-current-title">${LABELS[goal.goalType]}</h3><span class="badge">${goal.status==='paused'?'Paused':'Active'}</span><p>Started ${namedDate(goal.startDate)}</p></div>${button('Record weight','progress-record-weight','','primary')}</div>${weightGoal?`<dl class="progress-values"><div><dt>Starting weight</dt><dd>${kg(goal.startingWeightKg)}</dd><small>Measured ${namedDate(goal.measurementDate)}</small></div><div><dt>Latest weight</dt><dd>${esc(latest)}</dd><small>${summary.latestDate?namedDate(summary.latestDate):'No measurement in this goal period'}</small></div>${goal.targetWeightKg===null?'':`<div><dt>Your target</dt><dd>${kg(goal.targetWeightKg)}</dd><small>Your chosen target</small></div>`}<div><dt>Recorded change</dt><dd>${esc(changed)}</dd></div></dl>${meter}${chartMarkup(summary)}`:'<p class="progress-note">See <a href="#/member/attendance">Attendance</a> for your calendar, history and consistency. Attendance does not explain weight changes.</p>'}<div class="progress-actions progress-settings">${button('Edit goal','progress-edit-goal')}${button(goal.status==='paused'?'Resume':'Pause',goal.status==='paused'?'progress-resume-goal':'progress-pause-goal')}${button('New goal','progress-new-goal')}</div>${progress.editor!=='goal'&&progress.goalError?`<p id="progress-goal-error" class="form-error" role="alert">${esc(progress.goalError)}</p>`:''}${goal.status==='paused'?'<p class="progress-note">Your goal is paused. Saved measurements remain available and you can still record weight.</p>':''}</section>`;
}
function weightEditor(){
 const draft=progress.weightDraft;if(!draft||progress.editor!=='weight')return '';
 const duplicate=progress.data.measurements.find(record=>record.date===draft.date&&record.id!==draft.id);
 return `<form id="progress-weight-form" class="progress-editor" novalidate aria-labelledby="progress-weight-editor-title"${progress.saving?' aria-busy="true"':''}><fieldset${progress.saving?' disabled':''}><legend id="progress-weight-editor-title">${draft.id?'Edit measurement':'Record weight'}</legend><div id="progress-weight-error" class="form-error" role="alert"${progress.weightError&&!duplicate?'':' hidden'}>${esc(progress.weightError)}</div><div class="form-grid">${input('Measurement date (Manila gym date)','date',draft.date,'date',`required max="${esc(today())}"`)}${input('Weight (kg)','weightKg',draft.weightKg,'number','required min="10" max="500" step="0.1" inputmode="decimal"')}</div>${duplicate?`<div id="progress-duplicate" class="progress-existing"><p><strong>${namedDate(duplicate.date)} already has a measurement: ${kg(duplicate.weightKg)}.</strong></p><p>Choose Edit measurement to change it. Your proposed value is kept; nothing changes until you save.</p>${button('Edit measurement','progress-replace-weight','','primary')}</div>`:''}<details class="progress-help"><summary>About these measurements</summary><p>Record when you actually weighed yourself. Entries allow 10–500 kg and one decimal place; these are data-entry limits, not a recommended weight. Records do not change your separate health profile.</p></details><div class="progress-actions">${button('Cancel','progress-cancel-weight')}${duplicate?'':`<button type="submit" class="button primary">${progress.saving?'Saving…':draft.id?'Save measurement':'Save weight'}</button>`}</div></fieldset></form>`;
}
function measurementHistory(){
 const records=[...progress.data.measurements].sort((a,b)=>b.date.localeCompare(a.date));
 const current=progress.data.currentGoal,allSummary=progressSummary(null,records);
 const currentHasChart=current&&current.goalType!=='attendance'&&progressSummary(current,records).hasChart;
 const historyChart=allSummary.hasChart&&!currentHasChart?`<section class="progress-all-weights" aria-label="All recorded weights"><h3>All recorded weights</h3><p class="progress-note">This chart spans your saved measurements across goal periods. It is separate from progress toward the current goal and does not prescribe a target or claim a health trend.</p>${chartMarkup(allSummary)}</section>`:'';
 const rows=records.map(record=>`<tr data-measurement-id="${esc(record.id)}"><td><time datetime="${esc(record.date)}">${namedDate(record.date)}</time></td><td>${kg(record.weightKg)}</td><td><div class="progress-row-actions">${button('Edit','progress-edit-weight',`data-id="${esc(record.id)}"`,'small')}${button('Delete','progress-delete-weight',`data-id="${esc(record.id)}"`,'small')}</div></td></tr>`).join('');
 const deletion=records.find(record=>record.id===progress.deleteId);
 return `<section class="progress-measurements" aria-labelledby="progress-measurements-title"><div class="progress-history-heading"><h3 id="progress-measurements-title">Weight history</h3>${!current&&progress.editor!=='weight'?button('Record weight','progress-record-weight','','primary'):''}</div>${deletion?`<div id="progress-delete-confirm" class="notice" role="alert"><div><strong>Delete ${kg(deletion.weightKg)} from ${namedDate(deletion.date)}?</strong><p>This removes the chart point and may change the latest value and recorded change. The goal’s confirmed starting reference remains unchanged.</p><div class="progress-actions">${button('Keep measurement','progress-cancel-delete')}${button('Delete measurement','progress-confirm-delete','','danger')}</div></div></div>`:''}${historyChart}${records.length?`<div class="table-scroll"><table class="data-table"><caption class="sr-only">Dated measurements, newest first</caption><thead><tr><th>Date</th><th>Weight</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="progress-note">No measurements recorded yet.</p>'}</section>`;
}
function goalHistory(){
 const history=progress.data.goals.filter(goal=>goal.id!==progress.data.currentGoal?.id);
 if(!history.length)return '';
 const timestamp=value=>esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)));
 return `<details id="progress-goal-history" class="progress-history"><summary>Earlier goal periods and settings (${history.length})</summary><ul>${history.map(goal=>`<li><strong>${LABELS[goal.goalType]}</strong> · ${goal.status==='paused'?'Paused':'Active'} at the time · started ${namedDate(goal.startDate)}${goal.startingWeightKg===null?'':` · reference ${kg(goal.startingWeightKg)} on ${namedDate(goal.measurementDate)}`}${goal.targetWeightKg===null?'':` · target ${kg(goal.targetWeightKg)}`}<small>${goal.periodId===progress.data.currentGoal?.periodId?'Earlier settings for the current goal':'Earlier goal period'}. Saved ${timestamp(goal.recordedAt)}${goal.endedAt?`; superseded ${timestamp(goal.endedAt)}`:''} (Manila time). Earlier settings remain as recorded.</small></li>`).join('')}</ul></details>`;
}
function draftActions(){
 const buttons=[progress.goalDraft&&progress.editor!=='goal'?button('Resume goal draft','progress-resume-goal-draft'):'' ,progress.weightDraft&&progress.editor!=='weight'?button('Resume weight draft','progress-resume-weight-draft'):''].join('');
 return buttons?`<div class="progress-drafts"><p>Your unsaved draft is kept while you use other pages.</p><div class="progress-actions">${buttons}</div></div>`:'';
}
function panelMarkup(){
 const error=progress.error?`<div id="progress-error" class="form-error" role="alert">${esc(progress.error)} ${button('Retry loading','progress-retry')}</div>`:'';
 const weightError=progress.weightError&&progress.editor!=='weight'?`<p id="progress-weight-error" class="form-error" role="alert">${esc(progress.weightError)}</p>`:'';
 const data=progress.data;
 return `<section id="member-progress" class="panel member-progress" aria-labelledby="member-progress-title"${progress.loading||progress.saving?' aria-busy="true"':''}><div class="panel-header"><div><h2 id="member-progress-title">Your goal and weight</h2><p>Private to your member account.</p></div>${button('Refresh saved records','progress-retry','','small')}</div><div class="member-progress-body"><p id="progress-status" role="status">${esc(progress.saving?'Saving…':progress.notice)}</p>${error}${data?`${goalSummary()}${draftActions()}${goalEditor()}${weightEditor()}${weightError}${measurementHistory()}${goalHistory()}<p class="progress-note progress-disclaimer">Your own goals and measurements, not a diagnosis or prescribed weight or diet. They do not change your membership.</p>`:progress.loading?'<p role="status">Loading your saved progress…</p>':''}</div></section>`;
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
function lifecycle(){
 syncOwner();const active=isOpen(),changed=progress.snapshot!==state;progress.snapshot=state;
 if(!active){if(progress.active){abortReads();progress.mutationController?.abort();progress.mutationController=null;progress.saving=false;}progress.active=false;return;}
 const entering=!progress.active;progress.active=true;
 if((entering||changed)&&!progress.saving)loadProgress();
}
const progressBaseRender=render;
render=function(){progressBaseRender();lifecycle();};

function makeGoalDraft(action){
 const current=progress.data?.currentGoal;
 const editing=action==='save_goal'&&current;
 return {action,requestId:requestId(),goalId:editing?current.id:current?.id||null,goalType:editing?current.goalType:'',startDate:editing?current.startDate:today(),differentStart:!!editing&&current.startDate!==today(),startingSource:'manual',startingWeightKg:editing?current.startingWeightKg:'',measurementDate:editing?current.measurementDate||'':'',targetWeightKg:editing?current.targetWeightKg??'':'',confirmed:false};
}
function captureDraft(form){
 const data=new FormData(form);
 if(form.id==='progress-goal-form'&&progress.goalDraft){
  const draft=progress.goalDraft;
  Object.assign(draft,{goalType:data.get('goalType'),differentStart:data.get('differentStart')==='on',confirmed:data.get('confirmed')==='on'});
  if(data.has('startDate'))draft.startDate=data.get('startDate');
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
 if(form.id==='progress-weight-form'&&event.target.name==='date'){progress.weightError='';repaint();}
});
document.addEventListener('change',event=>{
 const form=event.target.closest('#progress-goal-form,#progress-weight-form');if(!form||!isOpen()||progress.saving)return;
 captureDraft(form);
 if(form.id==='progress-goal-form'){
  const draft=progress.goalDraft;draft.requestId=requestId();
  if(event.target.name==='differentStart'){
   if(!draft.differentStart)draft.startDate=today();
   repaint();
  }
  if(event.target.name==='startingSource'){
   draft.startingSource=event.target.value;draft.confirmed=false;
   const record=progress.data.measurements.find(item=>`measurement:${item.id}`===draft.startingSource);
   if(record){draft.startingWeightKg=record.weightKg;draft.measurementDate=record.date;}
   else if(draft.startingSource==='health'){draft.startingWeightKg=progress.data.healthWeight.weightKg;draft.measurementDate='';}
   repaint();
  }
  if(event.target.name==='goalType')repaint();
 }else if(event.target.name==='date'){progress.weightError='';repaint();}
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
  mutate(body,'goal',()=>{progress.goalDraft=null;progress.goalError='';progress.editor=null;});
 }else{
  const draft=progress.weightDraft;
  const duplicate=progress.data.measurements.find(record=>record.date===draft.date&&record.id!==draft.id);
  if(duplicate){progress.weightError='';repaint();return;}
  const body=draft.id?{action:'update_weight',id:draft.id,date:draft.date,weightKg:draft.weightKg===''?null:Number(draft.weightKg)}:{action:'add_weight',date:draft.date,weightKg:draft.weightKg===''?null:Number(draft.weightKg)};
  mutate(body,'weight',()=>{progress.weightDraft=null;progress.weightError='';progress.editor=null;});
 }
},true);
document.addEventListener('click',event=>{
 const control=event.target.closest('[data-action^="progress-"]');if(!control)return;
 event.preventDefault();event.stopImmediatePropagation();syncOwner();
 if(!ownerKey()||mode!=='member'||section!=='goal')return;
 const action=control.dataset.action;
 if(!isOpen()||progress.saving)return;
 if(action==='progress-retry'){loadProgress();return;}
 if(!progress.data)return;
 progress.notice='';
 if(['progress-start-goal','progress-edit-goal','progress-new-goal','progress-resume-goal-draft'].includes(action)){
  if(!progress.goalDraft){progress.goalDraft=makeGoalDraft(action==='progress-new-goal'?'new_goal':'save_goal');progress.goalError='';}
  else if(action==='progress-new-goal'&&progress.goalDraft.action!=='new_goal')progress.notice='Your goal draft is kept. Save or Cancel it before starting a different goal.';
  progress.editor='goal';repaint();document.getElementById('progress-goalType')?.focus();return;
 }
 if(action==='progress-cancel-goal'){progress.goalDraft=null;progress.goalError='';progress.editor=null;repaint();return;}
 if(action==='progress-record-weight'||action==='progress-resume-weight-draft'){
  progress.weightDraft??={id:null,date:today(),weightKg:''};progress.editor='weight';repaint();document.getElementById('progress-date')?.focus();return;
 }
 if(['progress-pause-goal','progress-resume-goal'].includes(action)){
  const current=progress.data.currentGoal;if(!current)return;
  const statusAction=action==='progress-pause-goal'?'pause_goal':'resume_goal';
  if(progress.statusRequest?.action!==statusAction||progress.statusRequest?.goalId!==current.id)progress.statusRequest={action:statusAction,goalId:current.id,requestId:requestId()};
  mutate(progress.statusRequest,'goal',()=>{progress.statusRequest=null;progress.goalError='';if(progress.goalDraft){progress.goalDraft.goalId=progress.data.currentGoal.id;progress.goalDraft.requestId=requestId();}});return;
 }
 if(action==='progress-edit-weight'||action==='progress-replace-weight'){
  const replacing=action==='progress-replace-weight';
  const record=progress.data.measurements.find(item=>replacing?item.date===progress.weightDraft?.date&&item.id!==progress.weightDraft.id:item.id===control.dataset.id);if(!record)return;
  if(!replacing&&progress.weightDraft){progress.editor='weight';if(progress.weightDraft.id!==record.id)progress.notice='Your weight draft is kept. Save or Cancel it before editing another measurement.';repaint();return;}
  const proposed=replacing&&progress.weightDraft.weightKg!==''?progress.weightDraft.weightKg:record.weightKg;
  progress.weightDraft={id:record.id,date:record.date,weightKg:proposed};progress.editor='weight';progress.weightError='';repaint();document.getElementById('progress-weightKg')?.focus();return;
 }
 if(action==='progress-cancel-weight'){progress.weightDraft=null;progress.weightError='';progress.editor=null;repaint();return;}
 if(action==='progress-delete-weight'){progress.deleteId=control.dataset.id;progress.weightError='';repaint();return;}
 if(action==='progress-cancel-delete'){progress.deleteId=null;repaint();return;}
 if(action==='progress-confirm-delete'&&progress.deleteId){
  const deletedId=progress.deleteId;
  mutate({action:'delete_weight',id:deletedId},'weight',()=>{progress.deleteId=null;progress.weightError='';if(progress.weightDraft?.id===deletedId){progress.weightDraft=null;if(progress.editor==='weight')progress.editor=null;}});
 }
},true);
window.addEventListener('focus',()=>{if(isOpen()&&!document.hidden)loadProgress();});
// Private drafts stay in memory for this owner, never in browser storage. Reload/close needs an explicit choice.
window.addEventListener('beforeunload',event=>{if(progress.owner===ownerKey()&&(progress.goalDraft||progress.weightDraft||progress.saving)){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{abortReads();progress.mutationController?.abort();progress.mutationController=null;progress.saving=false;progress.active=false;});
window.addEventListener('pageshow',lifecycle);
