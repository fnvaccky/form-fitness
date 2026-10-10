'use strict';
// Staff tab in Members & plans, for administrators only. The server sends the staff list only to
// administrators and refuses every /api/staff call from anyone else; this file only renders it.
const staffBaseMembers=members;
let staffQuery='';
const staffById=id=>(state.staff||[]).find(s=>s.id===id);
function filteredStaff(){
 const q=staffQuery.trim().toLowerCase();
 return (state.staff||[]).filter(s=>!q||`${s.name} ${s.email} ${s.phone}`.toLowerCase().includes(q))
  .sort((a,b)=>(a.role===b.role?0:a.role==='admin'?-1:1)||a.name.localeCompare(b.name));
}
function staffRow(s,i){
 const id=`data-id="${esc(s.id)}"`;
 const actions=s.role==='admin'?'<small class="staff-locked">Admins can’t be changed here</small>'
  :`<div class="staff-actions">${btn('Edit','staff-edit','small',id)}${btn(s.enabled?'Disable':'Enable','staff-toggle','small',id)}${s.enabled?btn('Resend setup link','staff-resend','small',id):''}</div>`;
 return `<tr data-staff="${esc(s.id)}"><td><div class="person-cell">${avatar(s,i)}<div><strong>${esc(s.name)}</strong></div></div></td><td>${esc(s.email)}</td><td>${esc(s.phone)}</td><td>${badge(s.role==='admin'?'Admin':'Staff')}</td><td>${badge(s.enabled?'Active':'Disabled')}</td><td>${date(s.added)}</td><td>${actions}</td></tr>`;
}
function staffTable(rows){return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Role</th><th>Status</th><th>Added</th><th><span aria-label="Actions">&nbsp;</span></th></tr></thead><tbody>${rows.length?rows.map(staffRow).join(''):'<tr><td colspan="7"><div class="empty"><h3>No staff found</h3><p>Try a different name, email, or mobile number.</p></div></td></tr>'}</tbody></table></div>`;}
const staffCount=()=>`Showing ${filteredStaff().length} of ${(state.staff||[]).length} staff accounts`;
function staffPanel(){return `<section class="panel"><div class="toolbar"><div class="toolbar-left"><label class="searchbox">${icon('search')}<input id="staff-search" type="search" placeholder="Search name, email, or mobile" aria-label="Search staff" value="${esc(staffQuery)}"></label></div>${btn('Add staff','staff-add','primary','','plus')}</div><div id="staff-results">${staffTable(filteredStaff())}</div><div class="panel-footer"><span id="staff-count">${staffCount()}</span><span>Accounts are disabled, never deleted</span></div></section>`;}
members=function(){
 if(!can('manageStaff')){if(memberTab==='staff')memberTab='roster';return staffBaseMembers();}
 const html=staffBaseMembers();
 const start=html.indexOf('aria-label="Membership sections"'),end=html.indexOf('</div>',start);
 if(start<0||end<0)return html;
 const tab=`<button class="tab ${memberTab==='staff'?'active':''}" role="tab" aria-selected="${memberTab==='staff'}" data-action="member-tab" data-tab="staff">Staff<span>${(state.staff||[]).length}</span></button>`;
 return html.slice(0,end)+tab+'</div>'+(memberTab==='staff'?staffPanel():html.slice(end+'</div>'.length));
};
const staffFormFooter=(form,label)=>`${btn('Cancel','close')}<div class="right"><button class="button primary" type="submit" form="${form}">${label}</button></div>`;
const staffPhoneHint='Required · 09XXXXXXXXX or +639XXXXXXXXX';
function addStaffModal(){
 openModal('Add staff','Create a front-desk account.',`<form id="staff-create-form"><div class="form-grid">${field('Full name *','staff-name','','text','required minlength="2" maxlength="70" autocomplete="off"')}${field('Email address *','staff-email','','email','required maxlength="100" autocomplete="off"')}${field('Mobile number *','staff-phone','','tel','required autocomplete="off"',staffPhoneHint)}</div><div class="notice">They’ll get an email to set their own password. Staff can register members, take cash, renew and check members in. They can’t change plans, settings or approve transfers.</div><div class="form-error" role="alert"></div></form>`,staffFormFooter('staff-create-form','Create staff account'));
}
function staffCreatedModal(response,name,email){
 const sent=response.setupEmailSent===true,id=response.staff?.id;
 openModal(sent?'Staff account created':'Account created',sent?'The setup email is on its way.':'The setup email did not go out.',`<div class="review-card"><h3>${esc(name)}</h3><p>${esc(email)}</p></div><div class="notice">${sent?`A password setup email was sent to ${esc(email)}. They choose their own password from that email.`:'Account created; setup email needs a resend. Use Resend setup link in the Staff tab once email delivery is fixed.'}</div>`,`${!sent&&id?btn('Resend setup link','staff-resend','',`data-id="${esc(id)}"`):''}<div class="right">${btn('Done','close','primary')}</div>`);
}
function editStaffModal(s){
 openModal('Edit staff member','Update the name or mobile number.',`<form id="staff-edit-form"><input type="hidden" id="staff-edit-id" value="${esc(s.id)}"><div class="form-grid">${field('Full name *','staff-edit-name',s.name,'text','required minlength="2" maxlength="70"')}${field('Email address','staff-edit-email',s.email,'email','readonly','Email changes require re-creating the account.')}${field('Mobile number *','staff-edit-phone',s.phone,'tel','required',staffPhoneHint)}</div><div class="form-error" role="alert"></div></form>`,staffFormFooter('staff-edit-form','Save changes'));
}
function toggleStaffModal(s){
 const id=`data-id="${esc(s.id)}"`;
 if(s.enabled)openModal(`Disable ${esc(s.name)}?`,'They will be signed out immediately.',`<p>${esc(s.name)} will be signed out immediately and can’t sign in until the account is enabled again. Their recorded payments and check-ins stay on record.</p>`,`${btn('Cancel','close')}${btn('Disable account','staff-confirm-toggle','primary',id)}`);
 else openModal(`Enable ${esc(s.name)}?`,'They can sign in again with their own password.',`<p>${esc(s.name)} will be able to sign in again. If they never finished setting a password, send a new setup link afterwards.</p>`,`${btn('Cancel','close')}${btn('Enable account','staff-confirm-toggle','primary',id)}`);
}
document.addEventListener('click',event=>{
 const el=event.target.closest('[data-action]');
 if(!el||!String(el.dataset.action||'').startsWith('staff-'))return;
 event.preventDefault();event.stopImmediatePropagation();
 const a=el.dataset.action,s=staffById(el.dataset.id);
 if(a==='staff-add')return addStaffModal();
 if(!s||s.role!=='staff')return;
 if(a==='staff-edit')return editStaffModal(s);
 if(a==='staff-toggle')return toggleStaffModal(s);
 if(el.disabled)return;
 el.disabled=true;
 (async()=>{
  try{
   if(a==='staff-confirm-toggle'){const enabled=!s.enabled;await api('/staff/enable',{id:s.id,enabled});await refreshData();closeModal();toast(enabled?`${s.name} can sign in again.`:`${s.name} is disabled and has been signed out.`);}
   if(a==='staff-resend'){const response=await api('/staff/resend',{id:s.id});toast(response.message||`Setup link sent to ${s.email}.`);}
  }catch(e){toast(e.message);}
  finally{el.disabled=false;}
 })();
},true);
document.addEventListener('submit',event=>{
 const form=event.target;
 if(!['staff-create-form','staff-edit-form'].includes(form.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 return runForm(form,async()=>{
  if(form.id==='staff-create-form'){
   const name=document.getElementById('staff-name').value,email=document.getElementById('staff-email').value,phone=document.getElementById('staff-phone').value;
   validateContactFields(name,email,phone);
   const response=await api('/staff',{name,email,phone});
   await refreshData();staffCreatedModal(response,name.trim(),email.trim().toLowerCase());return;
  }
  const s=staffById(document.getElementById('staff-edit-id').value);if(!s)throw Error('This staff member is no longer listed. Refresh and try again.');
  const name=document.getElementById('staff-edit-name').value,phone=document.getElementById('staff-edit-phone').value;
  validateContactFields(name,s.email,phone);
  await api('/staff/update',{id:s.id,name,phone});
  await refreshData();closeModal();toast('Staff details updated.');
 });
},true);
document.addEventListener('input',event=>{
 if(event.target.id!=='staff-search')return;
 staffQuery=event.target.value;
 document.getElementById('staff-results').innerHTML=staffTable(filteredStaff());
 document.getElementById('staff-count').textContent=staffCount();
});
