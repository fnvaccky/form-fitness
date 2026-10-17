'use strict';
// Task 12A: plan management. In Members & plans → Membership plans, administrators add plans and edit every field but
// the ID: name, price, cycle length, description, features, availability, coaching and focus tags. Staff see the cards
// read-only. No plan is ever deleted: making one unavailable retires it, and members who already have it keep it.
// ff_private.plan_admin checks the administrator and every field again; the screen shows the plan as the server saved it.
// What a member bought is frozen on their cycle, so a change here applies to new cycles only.
const COACHING_CHOICES=[['none','No coach'],['group','Group coaching'],['personal','Personal coach']];
// A suggested ID from the name, until the administrator types one: "Strength & Cardio" → "strength-cardio".
const planSlug=name=>name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^[^a-z]+|-+$/g,'').slice(0,31);

function planAdminPanel(){
 return `<section class="panel plan-admin" aria-label="Manage plans"><div class="panel-header"><div><h2>Manage plans</h2><p>Changes apply to new cycles only. Memberships, invoices and payments already made keep the terms they were bought with.</p></div>${btn('Add plan','plan-add','primary small','','plus')}</div>`
  +`<div class="table-scroll"><table class="data-table"><thead><tr><th>Plan</th><th>Price</th><th>Coaching</th><th>Status</th><th><span aria-label="Actions">&nbsp;</span></th></tr></thead><tbody>`
  +plans.map(p=>`<tr data-plan-row="${esc(p.id)}"><td><strong>${esc(p.name)}</strong><br><small>${esc(p.id)}</small></td><td>${money(p.price)} / ${p.days||30} days</td><td>${esc(p.coachingLabel||'No coach')}</td><td>${badge(p.available===false?'Retired':'Available')}</td><td>${btn('Edit plan','edit-plan','small',`data-id="${esc(p.id)}"`)}</td></tr>`).join('')
  +'</tbody></table></div></section>';
}
{
 const plansBaseCards=planCards;
 planCards=function(){const html=plansBaseCards();return mode==='admin'&&can('plans')?html+planAdminPanel():html;};
}

function planForm(id){
 const p=id?plans.find(x=>x.id===id):null;
 if(id&&!p)return toast('This plan is no longer listed. Refresh and try again.');
 const v=p||{id:'',name:'',price:'',days:30,desc:'',features:[],available:true,coaching:'none',coachSessions:0,focusTags:[]};
 openModal(p?`Edit ${esc(p.name)}`:'Add a plan',p?'Changes apply to new cycles only. Existing memberships and invoices keep their terms.':'Members can choose it for a new cycle once it is saved as available.',
  `<form id="plan-form" data-kind="${p?'update':'create'}" novalidate><div class="form-grid">`
  +field('Plan name *','plan-name',v.name,'text','required minlength="2" maxlength="60" autocomplete="off"')
  +(p?`<div class="field"><label for="plan-id">Plan ID</label><input id="plan-id" value="${esc(v.id)}" readonly><small>A plan’s ID can’t be changed.</small></div>`
     :field('Plan ID *','plan-id','','text','required maxlength="31" autocomplete="off" spellcheck="false" autocapitalize="off"','Lowercase letters, numbers, - or _, starting with a letter. It can’t be changed later.'))
  +field('Price (PHP) *','plan-price',v.price,'number','required min="0.01" max="100000" step="0.01" inputmode="decimal"')
  +field('Cycle length (days) *','plan-days',v.days,'number','required min="1" max="366" step="1" inputmode="numeric"')
  +`<div class="field full"><label for="plan-description">Description</label><textarea id="plan-description" rows="2" maxlength="200">${esc(v.desc)}</textarea><small>Up to 200 characters, on one line.</small></div>`
  +`<div class="field full"><label for="plan-features">Features</label><textarea id="plan-features" rows="5">${esc((v.features||[]).join('\n'))}</textarea><small>One per line: up to 10 lines of 80 characters. “Everything in” followed by another plan’s exact name includes that plan’s features as they are when a member buys, and follows that plan if it is renamed.</small></div>`
  +`<div class="field"><label for="plan-coaching">Coaching</label><select id="plan-coaching">${COACHING_CHOICES.map(([value,label])=>`<option value="${value}" ${v.coaching===value?'selected':''}>${label}</option>`).join('')}</select></div>`
  +field('Coach sessions per cycle','plan-sessions',v.coachSessions||0,'number','min="0" max="30" step="1" inputmode="numeric"','0 to 30. A plan with no coach has none.')
  +`<fieldset class="field full plan-focus-field"><legend>Focus</legend><div class="plan-focus-choices">${Object.entries(FOCUS_LABELS).map(([value,label])=>`<label class="checkline"><input type="checkbox" name="plan-focus" value="${value}" ${(v.focusTags||[]).includes(value)?'checked':''}>${label}</label>`).join('')}</div><small>Used to suggest plans from a member’s fitness survey. Members don’t see it.</small></fieldset>`
  +`</div><label class="checkline"><input id="plan-available" type="checkbox" ${v.available!==false?'checked':''}>Available for new cycles (registration and renewal)</label>`
  +`<p class="plan-form-help">${p?'Unticking this retires the plan: members who already have it keep it, and its unpaid invoices stay payable.':'Untick this to save the plan without offering it yet.'}</p><div class="form-error" id="form-error" role="alert"></div></form>`,
  `${btn('Cancel','close')}<div class="right"><button class="button primary" type="submit" form="plan-form">${p?'Save plan':'Add plan'}</button></div>`,true);
 const coaching=document.getElementById('plan-coaching'),sessions=document.getElementById('plan-sessions');
 const sync=()=>{const none=coaching.value==='none';if(none)sessions.value=0;sessions.disabled=none;};
 coaching.addEventListener('change',sync);sync();
 if(!p){
  const name=document.getElementById('plan-name'),planId=document.getElementById('plan-id');
  name.addEventListener('input',()=>{if(!planId.dataset.typed)planId.value=planSlug(name.value);});
  planId.addEventListener('input',()=>{planId.dataset.typed='true';});
 }
}

// The form as plan management expects it. These checks only save a round trip; the database has the final say.
function planFormBody(form){
 const value=id=>document.getElementById(id).value.trim();
 const features=document.getElementById('plan-features').value.split('\n').map(line=>line.trim()).filter(Boolean);
 const body={action:form.dataset.kind,id:value('plan-id'),name:value('plan-name'),price:value('plan-price'),days:Number(value('plan-days')),description:value('plan-description'),
  features,available:document.getElementById('plan-available').checked,coaching:document.getElementById('plan-coaching').value,coachSessions:Number(value('plan-sessions')||0),
  focusTags:[...form.querySelectorAll('input[name="plan-focus"]:checked')].map(input=>input.value)};
 if(body.name.length<2||body.name.length>60||/[<>]/.test(body.name))throw Error('Enter a plan name of 2 to 60 characters, without < or >.');
 if(!/^[a-z][a-z0-9_-]{1,30}$/.test(body.id))throw Error('Plan ID: 2 to 31 lowercase letters, numbers, hyphens or underscores, starting with a letter.');
 if(!/^\d{1,6}(\.\d{1,2})?$/.test(body.price)||Number(body.price)<0.01||Number(body.price)>100000)throw Error('Enter a price between PHP 0.01 and PHP 100,000.');
 if(!Number.isInteger(body.days)||body.days<1||body.days>366)throw Error('Enter a cycle length of 1 to 366 days.');
 if(body.description.length>200||/[<>]/.test(body.description))throw Error('Keep the description to 200 characters, on one line, without < or >.');
 if(features.length>10)throw Error('List up to 10 features.');
 if(features.some(line=>line.length>80||/[<>]/.test(line)))throw Error('Each feature is one line of 1 to 80 characters, without < or >.');
 if(!Number.isInteger(body.coachSessions)||body.coachSessions<0||body.coachSessions>30)throw Error('Enter 0 to 30 coach sessions per cycle.');
 return body;
}

document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='plan-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 runForm(form,async()=>{
  const button=document.querySelector('button[form="plan-form"]'),label=button?.textContent;
  try{
   const body=planFormBody(form);if(button)button.textContent='Saving…';
   const {plan,alsoUpdated=[]}=await api('/plans',body);
   // Show the plans as the server saved them at once (a rename also updates the "Everything in" line of the plans that
   // include it); the full refresh follows.
   for(const saved of [plan,...alsoUpdated]){const at=plans.findIndex(p=>p.id===saved.id);if(at>=0)plans[at]=saved;else plans.push(saved);}
   if(state.plans)state.plans=plans.slice();
   closeModal();render();
   const others=alsoUpdated.map(p=>p.name);
   toast(body.action==='create'?`${plan.name} added${plan.available?'':', not yet offered'}.`
    :`${plan.name} saved.${others.length?` ${others.join(', ')} now ${others.length===1?'says':'say'} “Everything in ${plan.name}”.`:''} Existing memberships and invoices keep their terms.`);
   refreshData().catch(()=>{});
  }catch(e){if(button?.isConnected)button.textContent=label;throw e;}
 });
},true);
document.addEventListener('click',event=>{
 const el=event.target.closest('[data-action]');if(!el||!['plan-add','edit-plan'].includes(el.dataset.action))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(!can('plans'))return toast('Administrator access is required.');
 planForm(el.dataset.action==='edit-plan'?el.dataset.id:'');
},true);
