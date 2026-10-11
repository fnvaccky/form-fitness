// FEATURE-002: one helper for every password field. It decorates each password input as it appears: an
// eye button to show or hide it, and, for inputs marked data-password-rule (new passwords), a checklist
// of the shared rule that ticks as the person types. No form needs code of its own.
import {PASSWORD_CHECKS,PASSWORD_MESSAGE,passwordMeetsRule} from './password-rule.js';
const svg=shapes=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${shapes}</svg>`;
const EYE='<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const ICONS={show:svg(EYE),hide:svg(EYE+'<path d="M4 4l16 16"/>'),met:svg('<path d="M5 12l4 4L19 6"/>'),unmet:svg('<circle cx="12" cy="12" r="4"/>')};
const toggles=new WeakMap();
function setVisible(input,visible){
 const toggle=toggles.get(input),focused=document.activeElement===input;
 const [start,end,direction]=[input.selectionStart,input.selectionEnd,input.selectionDirection];
 input.type=visible?'text':'password';
 if(focused&&start!==null)input.setSelectionRange(start,end,direction||'none'); // changing type can move the caret
 toggle.setAttribute('aria-pressed',String(visible));
 toggle.setAttribute('aria-label',visible?'Hide password':'Show password');
 toggle.innerHTML=visible?ICONS.hide:ICONS.show;
}
// Words as well as the icon, so the state never depends on colour alone.
function updateChecklist(input,list){
 PASSWORD_CHECKS.forEach((check,index)=>{
  const met=check.test(input.value),item=list.children[index];
  if(item.dataset.met===String(met))return;
  item.dataset.met=String(met);item.firstChild.innerHTML=met?ICONS.met:ICONS.unmet;item.lastChild.textContent=met?', met':', not met';
 });
 // The browser check: the form won't submit, and shows the server's own message, until the rule is met.
 input.setCustomValidity(input.value&&!passwordMeetsRule(input.value)?PASSWORD_MESSAGE:'');
}
function decorate(input){
 if(toggles.has(input))return;
 const focused=document.activeElement===input,wrap=document.createElement('span'),toggle=document.createElement('button');
 wrap.className='password-input';input.replaceWith(wrap);wrap.append(input);if(focused)input.focus();
 toggle.type='button';toggle.className='password-toggle';if(input.id)toggle.setAttribute('aria-controls',input.id);
 toggle.addEventListener('mousedown',event=>event.preventDefault()); // a click leaves focus and the caret in the field
 toggle.addEventListener('click',()=>setVisible(input,input.type==='password'));
 wrap.append(toggle);toggles.set(input,toggle);setVisible(input,false);
 if(!input.hasAttribute('data-password-rule'))return;
 const list=document.createElement('ul');
 list.className='password-checklist';list.id=input.id+'-rules';
 for(const check of PASSWORD_CHECKS){
  const item=document.createElement('li');
  item.append(document.createElement('span'),check.label,document.createElement('span'));
  item.firstChild.className='password-check-icon';item.lastChild.className='visually-hidden';list.append(item);
 }
 wrap.after(list);
 input.setAttribute('aria-describedby',[input.getAttribute('aria-describedby'),list.id].filter(Boolean).join(' '));
 input.addEventListener('input',()=>updateChecklist(input,list));updateChecklist(input,list);
}
const scan=node=>{
 if(node.nodeType!==1)return;
 if(node.matches('input[type=password]'))decorate(node);
 for(const input of node.querySelectorAll('input[type=password]'))decorate(input);
};
new MutationObserver(records=>{for(const record of records)record.addedNodes.forEach(scan);}).observe(document.body,{childList:true,subtree:true});
scan(document.body);
// Every password is hidden again when its form is submitted, so it stays hidden after a successful save;
// a closed dialog takes its fields with it. A window capture listener runs before the app's own handlers.
window.addEventListener('submit',event=>{
 for(const input of event.target.querySelectorAll('.password-input input'))if(toggles.has(input)&&input.type!=='password')setVisible(input,false);
},true);
