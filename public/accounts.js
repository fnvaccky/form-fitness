'use strict';
// Task 10, account first. Add member creates the member's account at once, with a plan only if staff pick
// one at the desk. A member without a paid plan sees a limited home: choose a plan, pay online or in cash at
// the desk, and no member pass until a fully paid cycle covers today (the database refuses it too).
// Administrators get an Unpaid accounts tab to delete accounts that never paid. The server and database decide;
// this file only renders.
// The header button opens the form with no plan; a plan card's "Register with …" preselects that plan.
let addMemberPlan='';
document.addEventListener('click',event=>{const el=event.target.closest('[data-action="register"]');if(el)addMemberPlan=el.dataset.plan||'';},true);
register=function(){
 const today=DEMO_DATE;
 openModal('Add member','Create the member’s account now. They set their own password from the setup email.',`<form id="member-create-form"><div class="form-grid">${field('Full name *','member-name','','text','required minlength="2" maxlength="70" autocomplete="off"')}${field('Email address *','member-email','','email','required maxlength="100" autocomplete="off"')}${field('Mobile number *','member-phone','','tel','required autocomplete="off"','Required · 09XXXXXXXXX or +639XXXXXXXXX')}${field('Goal (optional)','member-goal','','text','maxlength="100" autocomplete="off"')}<div class="field"><label for="member-plan">Plan (optional)</label><select id="member-plan"><option value="">No plan yet: the member chooses after signing in</option>${plans.filter(p=>p.available!==false).map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${money(p.price)}</option>`).join('')}</select></div>${field('Start date','member-start',today,'date',`min="${today}" max="${addDays(today,365)}" disabled`)}</div><div class="notice">The account works right away. Membership and the member pass start only after full payment.</div><div class="form-error" role="alert"></div></form>`,`${btn('Cancel','close')}<div class="right"><button class="button primary" type="submit" form="member-create-form">Create account</button></div>`);
 const plan=document.getElementById('member-plan'),start=document.getElementById('member-start');
 const update=()=>{start.disabled=!plan.value;start.required=!!plan.value;};
 if([...plan.options].some(o=>o.value&&o.value===addMemberPlan))plan.value=addMemberPlan;
 addMemberPlan='';plan.addEventListener('change',update);update();
};
function memberCreatedModal(response){
 const m=response.member,sent=response.setupEmailSent===true;
 openModal(sent?'Member account created':'Account created',sent?'The setup email is on its way.':'The setup email did not go out.',`<div class="review-card"><h3>${esc(m.name)}</h3><p>${esc(m.email)}</p></div><div class="notice">${esc(response.message)}</div>`,`${response.invoiceId&&can('recordCashPayment')?btn('Record cash payment','pay','',`data-id="${esc(response.invoiceId)}"`):''}<div class="right">${btn('Done','close','primary')}</div>`);
}
document.addEventListener('submit',event=>{
 const form=event.target;
 if(form.id!=='member-create-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 return runForm(form,async()=>{
  const value=id=>document.getElementById(id).value,name=value('member-name'),email=value('member-email'),phone=value('member-phone');
  validateContactFields(name,email,phone);
  const body={name,email,phone,goal:value('member-goal').trim()},plan=value('member-plan');
  if(plan){if(!value('member-start'))throw Error('Choose a start date for the plan.');Object.assign(body,{plan,start:value('member-start')});}
  const response=await api('/members',body);
  await refreshData();memberCreatedModal(response);
 });
},true);

// A member with no plan yet chooses one first; the existing renew path creates the unpaid invoice.
const firstPlanCopy=html=>html.replace('Choose a plan to create your next cycle and invoice. Your current paid cycle remains valid.','Choose a plan to create your first invoice.');
function choosePlanHome(m){
 const preview=currentUser?.role==='member'?'':`<label class="member-selector">Preview member<select id="member-selector" class="filter" aria-label="Preview member">${memberOptions()}</select></label>`;
 return heading(`Welcome, ${esc(m.name.split(' ')[0])}.`,'Choose a plan to start your membership.',preview,'GET STARTED','member-heading')
  +'<div class="notice">Pick a plan and a start date. Pay online right away, or pay cash at the front desk. Your member pass appears once your first payment is confirmed and your start date arrives.</div>'
  +firstPlanCopy(planCards());
}
const accountsBaseOverview=memberOverview,accountsBaseMembership=memberMembership;
memberOverview=function(){
 const m=memberById(selectedMember);
 if(m&&!m.start)return choosePlanHome(m);
 const html=accountsBaseOverview();
 if(!m||memberStatus(m)==='Active')return html;
 // No pass until a fully paid cycle covers today: offer the payment, or the next step, instead.
 const status=memberStatus(m),due=state.invoices.find(i=>i.memberId===m.id&&balance(i)>0);
 const [text,action]=due?['Your membership starts after full payment. Pay online now, or pay cash at the front desk.',can('initiateOnlinePayment')?btn('Pay now','pay','primary',`data-id="${esc(due.id)}"`,'arrow'):'']
  :status==='Scheduled'?[`Your member pass appears on ${date(m.start)}, when your paid membership starts.`,'']
  :status==='Inactive'?['Your membership is paused. Please contact the front desk.','']
  :['Your membership has ended. Choose a plan to renew it.',linkBtn('Choose a plan','members')];
 return html.replace(/<div class="member-pass-bar">[\s\S]*?<\/div>(?=<section class="member-hero">)/,`<div class="member-pass-bar"><span>${icon('card')}${text}</span>${action}</div>`);
};
// No plan yet: keep the member's details and the plan cards, without privileges of a plan they don't have.
memberMembership=function(){
 const m=memberById(selectedMember),html=accountsBaseMembership();
 if(!m||m.start)return html;
 return firstPlanCopy(html).replace(/<section class="panel membership-privileges">[\s\S]*?<\/section>/,'').replace('<h2>Explore your next cycle</h2><p>Choose a plan to see renewal details</p>','<h2>Choose your plan</h2><p>Pick a plan and a start date. Pay online, or pay cash at the front desk.</p>');
};
const accountsBaseSelectPlan=selectPlan;
selectPlan=function(id){
 accountsBaseSelectPlan(id);
 const m=memberById(selectedMember),form=document.getElementById('renew-form');
 if(!m||m.start||!form)return;
 document.getElementById('modal-title').textContent='Start your membership';
 document.querySelector('.modal-head p').textContent='Review the plan before creating your first invoice.';
 form.querySelector('.notice').textContent='This creates your first invoice. Nothing is charged automatically. Your membership and member pass start once the invoice is fully paid and the start date arrives.';
 document.querySelector('[form="renew-form"]').textContent='Create invoice';
};

// Administrators: never-paid member accounts, and Delete unpaid account.
function unpaidPanel(){
 const rows=state.unpaidAccounts||[],age=d=>d===0?'Today':d===1?'1 day':`${d} days`;
 return `<section class="panel"><div class="panel-header"><div><h2>Unpaid accounts</h2><p>Member accounts that have never paid. When the daily clean-up is turned on, it removes the ones older than 7 days.</p></div></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Member</th><th>Email</th><th>Age</th><th>Plan chosen</th><th>Online checkout</th><th><span aria-label="Actions">&nbsp;</span></th></tr></thead><tbody>${rows.length?rows.map(a=>`<tr data-unpaid="${esc(a.id)}"><td><strong>${esc(a.name)}</strong></td><td>${esc(a.email)}</td><td>${age(a.ageDays)}</td><td>${a.hasPlan?'Yes, unpaid':'No'}</td><td>${a.openCheckouts.length?`${a.openCheckouts.length} open`:'None'}</td><td>${btn('Delete unpaid account','unpaid-delete','small',`data-id="${esc(a.id)}"`)}</td></tr>`).join(''):'<tr><td colspan="6"><div class="empty"><h3>No unpaid accounts</h3><p>Every member account has paid at least once.</p></div></td></tr>'}</tbody></table></div></section>`;
}
const accountsBaseMembers=members;
members=function(){
 const html=accountsBaseMembers();
 if(!can('cleanupAccounts')){if(memberTab==='unpaid')memberTab='roster';return html;}
 const start=html.indexOf('aria-label="Membership sections"'),end=html.indexOf('</div>',start);
 if(start<0||end<0)return html;
 const tab=`<button class="tab ${memberTab==='unpaid'?'active':''}" role="tab" aria-selected="${memberTab==='unpaid'}" data-action="member-tab" data-tab="unpaid">Unpaid accounts<span>${(state.unpaidAccounts||[]).length}</span></button>`;
 return html.slice(0,end)+tab+'</div>'+(memberTab==='unpaid'?unpaidPanel():html.slice(end+'</div>'.length));
};
document.addEventListener('click',event=>{
 const el=event.target.closest('[data-action]');
 if(!el||!['unpaid-delete','unpaid-confirm-delete'].includes(el.dataset.action))return;
 event.preventDefault();event.stopImmediatePropagation();
 const account=(state.unpaidAccounts||[]).find(a=>a.id===el.dataset.id);
 if(!account)return toast('This account is no longer listed. Refresh and try again.');
 if(el.dataset.action==='unpaid-delete')return openModal(`Delete ${esc(account.name)}’s account?`,esc(account.email),'<p class="confirm-copy">This permanently deletes the account and frees the email. Only accounts that have never paid can be deleted.</p>',`${btn('Keep account','close')}<div class="right">${btn('Delete unpaid account','unpaid-confirm-delete','danger',`data-id="${esc(account.id)}"`)}</div>`);
 if(el.disabled)return;el.disabled=true;
 (async()=>{
  try{const response=await api('/members/delete-unpaid',{id:account.id});await refreshData();closeModal();toast(response.message||'Account deleted.');}
  catch(e){toast(e.message);}
  finally{if(el.isConnected)el.disabled=false;}
 })();
},true);
