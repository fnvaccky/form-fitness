'use strict';
const manualCheckout=checkoutModal;
const gatewayPayments=payments;
payments=function(){return gatewayPayments()+`<section class="panel" style="margin-top:20px"><div class="panel-header"><div><h2>PayMongo checkout history</h2><p>Check pending confirmations or payments requiring staff review.</p></div>${btn('View checkout status','paymongo-history','small')}</div></section>`;};
checkoutModal=async function(inv,method) {
  if(method)return manualCheckout(inv,method);
  paymentInvoice=inv.id;
  let config;try{config=await api('/paymongo/config');}catch(e){toast(e.message);return;}
  openModal('Pay your membership','Choose an online checkout or a manually verified transfer.',
    `<div class="review-card"><h3>Balance: ${money(balance(inv))}</h3></div>
    <div class="notice">${config.enabled?(config.mode==='test'?'TEST MODE — simulated payments only. No real money is collected.':'Secure checkout by PayMongo. Choose GCash or scan QR Ph with a supported banking app.'):'PayMongo is not configured for this workspace yet. Online payment is unavailable.'}</div>
    <p>QR Ph supports participating bank and wallet apps. An ordinary account-number bank transfer still needs staff verification.</p>
    ${config.enabled?'<button class="button primary" data-action="paymongo-start">Continue to GCash / QR Ph</button>':''}
    <p>Already transferred manually? Submit your reference and receipt below. Do not pay twice.</p>
    <div class="payment-methods"><button class="button" data-action="checkout-method" data-method="GCash">Manual GCash</button><button class="button" data-action="checkout-method" data-method="Bank transfer">Manual bank transfer</button></div>
    <div class="form-error" id="form-error" role="alert"></div>`,btn('Close','close'));
};
document.addEventListener('click',event=>{
  const historyButton=event.target.closest('[data-action="paymongo-history"]');
  if(historyButton){event.preventDefault();event.stopImmediatePropagation();
    api('/paymongo/attempts').then(({attempts})=>openModal('PayMongo checkout status','Pending does not mean paid. Contact staff before paying again.',
      attempts.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>Invoice</th><th>Amount</th><th>Status</th></tr></thead><tbody>${attempts.map(a=>`<tr><td>${esc(a.invoice_id)}<br><small>${esc(a.provider_payment_id||'Awaiting provider confirmation')}</small></td><td>${money(a.amount_cents/100)}</td><td>${esc(a.status)}</td></tr>`).join('')}</tbody></table></div>`:'<p>No online checkout attempts yet.</p>',btn('Close','close'))).catch(e=>toast(e.message));return;}
  const el=event.target.closest('[data-action="paymongo-start"]');if(!el)return;
  event.preventDefault();event.stopImmediatePropagation();el.disabled=true;
  api('/paymongo/checkout',{invoiceId:paymentInvoice}).then(data=>{location.assign(data.url);}).catch(e=>{error(e.message);el.disabled=false;});
},true);
const paymentReturn=new URLSearchParams(location.search).get('payment_return');
if(paymentReturn){
  const url=new URL(location.href);url.searchParams.delete('payment_return');history.replaceState({},'',url.pathname+url.search+url.hash);
  window.addEventListener('load',()=>setTimeout(()=>{
    openModal('Check your payment status','Returning from checkout does not confirm payment.',
      '<p>Sign in and refresh your Payments page to see the confirmed balance. Confirmation may take a moment. If you cancelled or the balance is still pending, contact staff before paying again.</p>',btn('Close','close'));
  },800),{once:true});
}
