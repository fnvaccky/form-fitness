function canInitiatePaymongo(kind,target){
 if(!can('initiateOnlinePayment')||!['registration','renewal','invoice'].includes(kind))return false;
 if(['admin','staff'].includes(currentUser?.role))return true;
 return currentUser?.role==='member'&&kind!=='registration'&&target?.memberId===currentUser.memberId;
}
function paymentChannels(id,cash=true,authorized=can('initiateOnlinePayment')){
 const names={gcash:'GCash',paymaya:'Maya',grab_pay:'GrabPay',card:'Credit / debit card'},enabled=(state.paymongo?.methods||[]).filter(x=>names[x]);
 return `<div class="field"><label for="${id}">Payment method *</label><select id="${id}" required>${cash?'<optgroup label="Cash / Manual payment"><option value="cash">Cash at the desk</option></optgroup>':''}<optgroup label="Pay online (TEST MODE)">${enabled.map(x=>`<option value="${x}" ${state.paymongo?.configured&&authorized?'':'disabled'}>${names[x]}</option>`).join('')}</optgroup></select></div><p class="auth-help online-payment-help">PayMongo test checkout uses simulated payments. No real money is collected.${!authorized?' This transaction is not authorized for your account.':state.paymongo?.configured?'':' Online checkout is awaiting test configuration.'}</p>`;
}
let paymongoStarting=false,paymongoSafetyTimer=null,paymongoGeneration=0,paymongoInstalled=false,memberOnlineMethod='';
const paymongoRequests=new Map();
const paymongoOwner=()=>currentUser?`${currentUser.id}:${currentUser.role}:${currentUser.memberId||''}`:'';
const paymongoContext=anchor=>({generation:paymongoGeneration,owner:paymongoOwner(),hash:location.hash,anchor});
const currentPaymongoOwner=context=>!!context.owner&&context.generation===paymongoGeneration&&context.owner===paymongoOwner();
const currentPaymongoView=context=>currentPaymongoOwner(context)&&context.hash===location.hash&&(context.anchor?context.anchor.isConnected:!document.querySelector('.modal'));
// Non-paid reconciliation changes only checkout state. Financial/access updates still require /state.
function rememberPaymongo(checkout,body={}){
 if(!checkout?.id)return;
 state.checkouts ||= [];
 let row=state.checkouts.find(item=>item.id===checkout.id);
 if(!row){row={id:checkout.id,invoice_id:checkout.invoiceId||body.invoiceId,registration_id:checkout.registrationId||body.registrationId,member_id:body.memberId||state.invoices.find(invoice=>invoice.id===(checkout.invoiceId||body.invoiceId))?.memberId};state.checkouts.push(row);}
 Object.assign(row,{status:checkout.status,checkout_url:checkout.url||'',review_reason:checkout.reviewReason||'',amount_cents:Math.round(checkout.amount*100)});
 if(checkout.recoverySessionId)row.review_details={...row.review_details,sessionId:checkout.recoverySessionId};
}
async function reconcilePaymongo(outcome,context,body={}){
 if(!currentPaymongoOwner(context))return false;
 if(outcome.checkout.status==='paid')await refreshData();
 else rememberPaymongo(outcome.checkout,body);
 return currentPaymongoView(context);
}
function validPaymongoUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='checkout.paymongo.com'&&!url.username&&!url.password&&!url.port;}catch{return false;}}
// A cancelled checkout navigation or a Back/bfcache return must leave online payment usable again.
function resetPaymongoStart(){
 clearTimeout(paymongoSafetyTimer);paymongoSafetyTimer=null;
 paymongoStarting=false;
 document.querySelectorAll('form[data-redirecting],form[data-submitting]').forEach(form=>{if(!['paymongo-member-form','payment-form','registration-payment-form','walkin-renew-form'].includes(form.id))return;delete form.dataset.redirecting;delete form.dataset.submitting;const button=document.querySelector(`button[form="${form.id}"]`)||form.querySelector('[type="submit"]');if(button){button.disabled=false;if(button.dataset.paymongoLabel){button.textContent=button.dataset.paymongoLabel;delete button.dataset.paymongoLabel;}}});
}
window.addEventListener('pageshow',resetPaymongoStart);
document.addEventListener('repready-auth-changing',()=>{
 paymongoGeneration++;resetPaymongoStart();paymongoRequests.clear();paymentIntent='';paymentInvoice=null;memberOnlineMethod='';
});
async function startPaymongo(body,form){
 if(paymongoStarting)return;
 const target=body.kind==='invoice'?state.invoices.find(i=>i.id===body.invoiceId):{memberId:body.memberId};
 if(!canInitiatePaymongo(body.kind,target))throw Error('This online payment is not authorized for your account.');
 const context=paymongoContext(form),button=form&&(document.querySelector(`button[form="${form.id}"]`)||form.querySelector('[type="submit"]')),label=button?.textContent;
 paymongoStarting=true;let redirecting=false;
 if(button){button.dataset.paymongoLabel='Continue to secure checkout';button.disabled=true;button.textContent='Preparing checkout…';}
 clearTimeout(paymongoSafetyTimer);paymongoSafetyTimer=null;
 try{
  const response=await api('/paymongo/checkout',{...body,requestId:paymentIntent}),checkout=response.checkout;
  if(!currentPaymongoOwner(context))return;
  rememberPaymongo(checkout,body);
  if(!currentPaymongoView(context))return;
  if(checkout.status==='pending'&&!checkout.reviewReason&&validPaymongoUrl(checkout.url)){
   if(form)form.dataset.redirecting='true';
   window.location.assign(checkout.url);redirecting=true;
   paymongoSafetyTimer=setTimeout(()=>{if(document.visibilityState==='visible')resetPaymongoStart();},10000);
   return;
  }
  if(await reconcilePaymongo(response,context,body))showPaymongo(checkout);
 }catch(error){if(currentPaymongoView(context)&&error.code!=='STALE_RESPONSE')throw error;}
 finally{if(context.generation===paymongoGeneration&&!redirecting)paymongoStarting=false;if(button?.isConnected&&!redirecting){button.textContent=label;delete button.dataset.paymongoLabel;button.disabled=false;}}
}
function showPaymongo(checkout){
 if(checkout.status==='paid'&&!checkout.reviewReason){toast('Online payment confirmed.');return;}
 const safeUrl=validPaymongoUrl(checkout.url);
 const blocked=!safeUrl||!!checkout.reviewReason||checkout.status==='needs_review'||['failed','expired'].includes(checkout.status);
 const messages={creating:'Preparing secure test checkout. Do not pay again.',pending:'Waiting for PayMongo confirmation. Do not pay again.',needs_review:'PayMongo checkout could not be confirmed. Do not start another payment until this checkout is reconciled.',failed:'Payment was not completed.',expired:'Checkout closed without a confirmed payment.'};
 openModal('Online membership payment',messages[checkout.status]||'Check the payment status before paying again.',`<p>Amount: <strong>${money(checkout.amount)}</strong></p>${blocked?`<div class="notice">${esc(messages[checkout.status]||'Check payment status before continuing.')}${checkout.reviewReason?`<br>Review reason: ${esc(checkout.reviewReason.replaceAll('_',' '))}`:''}</div>`:`<p>The member can open checkout here or scan this code on their phone.</p><canvas id="checkout-link-qr" aria-label="PayMongo checkout QR code"></canvas><p><a class="button primary" href="${esc(checkout.url)}" target="_blank" rel="noopener noreferrer">Open secure checkout</a></p>`}<div class="notice">Returning from checkout does not itself confirm payment. Use Check payment status to update the membership.</div>${currentUser?.role==='admin'&&checkout.status==='needs_review'&&!checkout.url?`<form id="recover-checkout-form"><input id="recover-checkout-id" type="hidden" value="${checkout.id}">${field('Existing PayMongo session ID *','recover-session',checkout.recoverySessionId||'','text','required pattern="cs_[a-zA-Z0-9]+"')}<small>Find the existing session with reference ${esc(checkout.id)} in PayMongo.</small><div class="form-error" role="alert"></div></form>`:''}`,`${btn('Close','close')}${btn('Check payment status','paymongo-status','primary',`data-id="${checkout.id}"`)}${currentUser?.role==='admin'&&checkout.status==='needs_review'&&!checkout.url?'<button class="button" type="submit" form="recover-checkout-form">Recover existing checkout</button>':''}`);
 if(!blocked)FORM_QR.toCanvas(document.getElementById('checkout-link-qr'),checkout.url,{width:210,margin:2,color:{dark:'#173f33',light:'#ffffff'}}).catch(()=>toast('Use the checkout link if the QR code cannot be displayed.'));
}
// Task 09: an administrator closes an unpaid checkout so its invoice or registration can be paid another way.
function cancelCheckoutModal(id){openModal('Cancel this checkout?','Online payment in progress',`<p class="confirm-copy">This closes the PayMongo checkout so the member can pay another way. Only use it if the member has not paid.</p>`,`${btn('Keep checkout','close')}<div class="right">${btn('Cancel checkout','paymongo-cancel-confirm','danger',`data-id="${esc(id)}"`)}</div>`);}
async function confirmCancelCheckout(id){
 const context=paymongoContext(document.querySelector('.modal'));
 const outcome=await api('/paymongo/cancel',{id});if(!currentPaymongoOwner(context))return;await refreshData();if(!currentPaymongoView(context))return;
 // PayMongo showed a payment, so it was recorded instead: report it like any confirmed payment.
 if(!outcome.cancelled&&outcome.registration)return registrationOutcome(outcome);
 closeModal();toast(outcome.cancelled?'Checkout cancelled. It can now be paid another way.':outcome.message);
}
function installPaymongo(){
 if(paymongoInstalled)return;paymongoInstalled=true;
 const cashRegistration=registrationCash;
 registrationCash=function(row){
  const active=(state.checkouts||[]).find(c=>c.registration_id===row.id&&['creating','pending','needs_review'].includes(c.status));
  if(active)return showPaymongo({id:active.id,status:active.status,url:active.checkout_url,reviewReason:active.review_reason,recoverySessionId:active.review_details?.sessionId||'',amount:active.amount_cents/100});
  cashRegistration(row);
  const form=document.getElementById('registration-payment-form');form.insertAdjacentHTML('afterbegin',paymentChannels('registration-channel',true,canInitiatePaymongo('registration',row)));
  form.querySelector('.review-card strong').textContent='Amount due: '+money(row.amount_cents/100);
  const update=()=>{const online=document.getElementById('registration-channel').value!=='cash',cash=document.getElementById('registration-cash-confirmed'),amount=document.getElementById('registration-amount');cash.required=!online;cash.disabled=online;cash.closest('label').hidden=online;amount.readOnly=online;amount.closest('.field').querySelector('label').textContent=online?'Amount payable (PHP)':'Cash received (PHP) *';document.querySelector('[form="registration-payment-form"]').textContent=online?'Continue to secure checkout':'Confirm cash & create account';};
  document.getElementById('registration-channel').addEventListener('change',update);update();
 };
 const cashRenewal=walkinRenew;
 walkinRenew=function(id){cashRenewal(id);const form=document.getElementById('walkin-renew-form');if(!form)return;form.insertAdjacentHTML('afterbegin',paymentChannels('renewal-channel',true,canInitiatePaymongo('renewal',{memberId:document.getElementById('walkin-member').value})));
  const update=()=>{const authorized=canInitiatePaymongo('renewal',{memberId:document.getElementById('walkin-member').value});for(const option of document.querySelectorAll('#renewal-channel option'))if(option.value!=='cash')option.disabled=!state.paymongo?.configured||!authorized;const online=document.getElementById('renewal-channel').value!=='cash',checkbox=document.getElementById('walkin-verified');checkbox.closest('label').lastChild.textContent=online?'I reviewed the member, next plan and amount to pay.':'I received the full cash payment for this renewal.';const amount=document.getElementById('walkin-amount');amount.readOnly=online;amount.closest('.field').querySelector('label').textContent=online?'Amount payable (PHP)':'Full cash received (PHP) *';document.querySelector('#walkin-renew-form .notice').textContent=online?'The next cycle activates after confirmed full payment and when its start date is reached. Your current paid cycle remains valid.':'The current cycle stays unchanged. This creates and pays the next cycle together; the next plan begins on its start date.';document.querySelector('[form="walkin-renew-form"]').textContent=online?'Continue to secure checkout':'Confirm cash renewal';};
  document.querySelector('.modal-head p').textContent='Choose the next plan and payment method.';document.getElementById('renewal-channel').addEventListener('change',update);document.getElementById('walkin-member').addEventListener('change',update);update();
 };
 const cashPay=pay,cashSubmit=submitPayment;
 function frontDeskPayment(inv){
  if(currentUser?.role!=='member'||inv?.memberId!==currentUser.memberId||balance(inv)<=0)return;
  openModal('Pay cash at the front desk','Visit the gym reception to pay. Staff will record your payment after receiving it.',`<div class="review-card"><h3>${esc(termsOf(inv).name)}</h3><p>Outstanding balance: <strong>${money(balance(inv))}</strong></p><p>Invoice: ${esc(inv.id)}</p></div>`,`${btn('Back','paymongo-online-back')}${btn('Close','close')}`);
  document.querySelector('.modal').classList.add('member-payment-modal');
 }
 pay=function(id){
  const inv=state.invoices.find(x=>x.id===id);if(!inv||balance(inv)<=0)return toast('This invoice is already settled.');
  const active=(state.checkouts||[]).find(c=>c.invoice_id===id&&['creating','pending','needs_review'].includes(c.status));
  if(active)return showPaymongo({id:active.id,status:active.status,url:active.checkout_url,reviewReason:active.review_reason,recoverySessionId:active.review_details?.sessionId||'',amount:active.amount_cents/100});
  paymentInvoice=id;paymentIntent=crypto.randomUUID();
  if(can('recordCashPayment')){
   cashPay(id);document.getElementById('method').value='Cash';const form=document.getElementById('payment-form');form.insertAdjacentHTML('afterbegin',paymentChannels('invoice-channel',true,canInitiatePaymongo('invoice',inv)));if(can('recordOnlinePayment'))document.querySelector('#invoice-channel option[value="cash"]').textContent='Record cash / existing transfer';
   const update=()=>{const online=document.getElementById('invoice-channel').value!=='cash';for(const id of ['method','payment-date','reference']){const input=document.getElementById(id);input.closest('.field').hidden=online;input.disabled=online;}const funds=document.getElementById('funds-verified');funds.closest('label').hidden=online;funds.disabled=online;funds.required=!online;const amount=document.getElementById('amount');amount.readOnly=online;if(online)amount.value=balance(inv);document.querySelector('[form="payment-form"]').textContent=online?'Continue to secure checkout':'Confirm payment';};
   document.getElementById('invoice-channel').addEventListener('change',update);update();
  }else{
   openModal('Pay your membership','Choose a simulated PayMongo payment or pay cash at the front desk.',`<form id="paymongo-member-form">${paymentChannels('invoice-channel',false,canInitiatePaymongo('invoice',inv))}<div class="review-card"><h3>${esc(termsOf(inv).name)}</h3><p>Remaining balance: <strong>${money(balance(inv))}</strong></p></div><div class="form-error" role="alert"></div></form>`,`${btn('Close','close')}${btn('Pay cash at the front desk','paymongo-front-desk')}<button class="button primary" form="paymongo-member-form" type="submit" ${state.paymongo?.configured&&canInitiatePaymongo('invoice',inv)?'':'disabled'}>Continue to secure checkout</button>`);
   document.querySelector('.modal').classList.add('member-payment-modal');
  }
 };
 submitPayment=async function(form){const method=document.getElementById('invoice-channel')?.value;if(method&&method!=='cash')return startPaymongo({kind:'invoice',invoiceId:paymentInvoice,method},form);return cashSubmit();};
 const cashPayments=payments;
 payments=function(){let html=cashPayments();const pending=(state.checkouts||[]).filter(c=>['creating','pending','needs_review'].includes(c.status)||c.review_reason);if(pending.length)html+=`<section class="panel"><div class="panel-header"><div><h2>Online payments in progress</h2><p>Resume or check an existing payment before paying again.</p></div></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Member / checkout</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${pending.map(c=>`<tr><td>${esc(memberById(c.member_id)?.name||(state.registrations||[]).find(r=>r.id===c.registration_id)?.name||'Membership')}<br><small>${esc(c.id)}</small></td><td>${money(c.amount_cents/100)}</td><td>${esc(c.status)}${c.review_reason?`<br><small>${esc(c.review_reason.replaceAll('_',' '))}</small>`:''}</td><td><div class="checkout-actions">${btn('Open / check','paymongo-open','small',`data-id="${c.id}"`)}${can('cancelCheckout')&&['creating','pending','needs_review'].includes(c.status)?btn('Cancel checkout','paymongo-cancel','small',`data-id="${c.id}"`):''}</div></td></tr>`).join('')}</tbody></table></div></section>`;return html;};
 document.addEventListener('submit',event=>{
  const form=event.target;if(!['paymongo-member-form','recover-checkout-form'].includes(form.id))return;
  event.preventDefault();event.stopImmediatePropagation();
  runForm(form,async()=>{
   if(form.id==='paymongo-member-form')return startPaymongo({kind:'invoice',invoiceId:paymentInvoice,method:document.getElementById('invoice-channel').value},form);
   const context=paymongoContext(form),id=document.getElementById('recover-checkout-id').value,key='checkout:'+id,request=Symbol();
   if(paymongoRequests.has(key))return;
   paymongoRequests.set(key,request);
   try{const outcome=await api('/paymongo/recover',{id,sessionId:document.getElementById('recover-session').value});if(await reconcilePaymongo(outcome,context))showPaymongo(outcome.checkout);}
   catch(error){if(currentPaymongoView(context)&&error.code!=='STALE_RESPONSE')throw error;}
   finally{if(paymongoRequests.get(key)===request)paymongoRequests.delete(key);}
  });
 },true);
 document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  if(!button||!['paymongo-status','paymongo-open','paymongo-front-desk','paymongo-online-back','paymongo-cancel','paymongo-cancel-confirm'].includes(button.dataset.action))return;
  event.preventDefault();event.stopImmediatePropagation();
  const action=button.dataset.action,key=(['paymongo-status','paymongo-cancel-confirm'].includes(action)?'checkout':action)+':'+(button.dataset.id||''),context=paymongoContext(document.querySelector('.modal')),request=Symbol(),label=button.textContent;
  if(button.disabled||paymongoRequests.has(key))return;
  paymongoRequests.set(key,request);button.disabled=true;
  if(action==='paymongo-status')button.textContent='Checking payment status…';
  if(action==='paymongo-cancel-confirm')button.textContent='Checking and cancelling…';
  (async()=>{
   if(action==='paymongo-front-desk'){memberOnlineMethod=document.getElementById('invoice-channel')?.value||'';return frontDeskPayment(state.invoices.find(i=>i.id===paymentInvoice));}
   if(action==='paymongo-online-back'){pay(paymentInvoice);const channel=document.getElementById('invoice-channel');if(channel&&[...channel.options].some(option=>option.value===memberOnlineMethod))channel.value=memberOnlineMethod;return;}
   if(action==='paymongo-cancel')return cancelCheckoutModal(button.dataset.id);
   if(action==='paymongo-cancel-confirm')return confirmCancelCheckout(button.dataset.id);
   if(action==='paymongo-open'){const row=state.checkouts.find(c=>c.id===button.dataset.id);if(row)return showPaymongo({id:row.id,status:row.status,url:row.checkout_url,reviewReason:row.review_reason,recoverySessionId:row.review_details?.sessionId||'',amount:row.amount_cents/100});return;}
   const outcome=await api('/paymongo/status',{id:button.dataset.id});
   if(!await reconcilePaymongo(outcome,context))return;
   if(outcome.checkout.status==='paid'){if(outcome.registration)registrationOutcome(outcome);else{closeModal();toast('Online payment confirmed. Membership balance updated.');}}
   else if(outcome.checkout.status==='expired'){closeModal();toast('Checkout closed without a confirmed payment. Choose a payment method again.');}
   else showPaymongo(outcome.checkout);
  })().catch(error=>{if(currentPaymongoView(context)&&error.code!=='STALE_RESPONSE')toast(error.message);}).finally(()=>{if(paymongoRequests.get(key)===request)paymongoRequests.delete(key);if(button.isConnected){button.disabled=false;button.textContent=label;}});
 },true);
 // PayMongo returns to the app without carrying an authenticated payment assertion.
 const checkout=new URL(location.href).searchParams.get('checkout');
 if(checkout){document.addEventListener('repready-ready',async()=>{
  const context=paymongoContext(null),key='checkout:'+checkout,request=Symbol();if(paymongoRequests.has(key))return;
  paymongoRequests.set(key,request);
  try{toast('Checking payment status. Do not pay again while confirmation is pending.');const outcome=await api('/paymongo/status',{id:checkout});if(!await reconcilePaymongo(outcome,context))return;if(outcome.checkout.status==='paid')toast('Online payment confirmed.');else showPaymongo(outcome.checkout);}
  catch(error){if(currentPaymongoView(context)&&error.code!=='STALE_RESPONSE')toast(error.message);}
  finally{if(paymongoRequests.get(key)===request)paymongoRequests.delete(key);}
 },{once:true});}
}
