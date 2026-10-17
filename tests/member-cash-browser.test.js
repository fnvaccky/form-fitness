// Real payment UI with isolated responses: no database, provider or account writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, describe, test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../src/dev.js';
import {capabilitiesFor, planView} from '../src/state.js';

const TODAY = '2026-10-17';
const MEMBER = '11111111-2222-3333-4444-555555555555';
const TITLE = 'Pay cash at the front desk';
const INSTRUCTION = 'Visit the gym reception to pay. Staff will record your payment after receiving it.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fixture({paid=false,waiting=false,role='member',configuredQr=false}={}) {
  const plans = [
    {id:'basic',name:'Essential',price_cents:89900,coaching:'none',coach_sessions:0,focus_tags:['strength','cardio']},
    {id:'plus',name:'Momentum',price_cents:149900,coaching:'group',coach_sessions:0,focus_tags:['cardio','mobility']}
  ].map(p => planView({...p,available:true,days:30,description:'Membership plan',features:['Catalog benefit']}));
  const terms = {...plans[0],features:['Purchased Essential benefit']};
  const member = {id:MEMBER,name:'Existing Member',email:'member@example.invalid',phone:'09170000001',goal:'Improve fitness',
    survey:{experience:'beginner',exercises:['strength'],availableDays:['mon','wed','fri'],updatedAt:TODAY+'T00:00:00Z'},
    enabled:true,photo:'',plan:'basic',terms,start:'2026-10-01',end:'2026-10-30',joined:'2026-10-01'};
  const invoice = {id:'INV-EXISTING-001',memberId:MEMBER,plan:'basic',terms,amount:899,amountCents:89900,
    paidCents:paid?89900:25000,start:member.start,end:member.end,due:member.start,created:member.start};
  const invoices = [invoice];
  if (waiting) invoices.push({id:'INV-NEXT-002',memberId:MEMBER,plan:'plus',terms:{...plans[1],features:['Frozen next-cycle benefit']},
    amount:1499,amountCents:149900,paidCents:0,start:'2026-10-31',end:'2026-11-29',due:'2026-10-31',created:TODAY});
  return {plans,member,invoices,payments:[],submissions:[],requests:[],unexpected:[],errors:[],navigation:[],
    user:{id:role==='member'?MEMBER:'staff-user',memberId:role==='member'?MEMBER:'staff-user',role,name:role==='member'?member.name:'Front Desk',can:capabilitiesFor(role)},
    settings:{payments:configuredQr?{gcash:{name:'Legacy recipient',detail:'Legacy transfer',image:'data:image/png;base64,iVBORw0KGgo='}}:{},email:null}};
}

const snapshot = f => ({user:f.user,date:TODAY,members:[f.member],plans:f.plans,invoices:f.invoices,memberships:[],payments:f.payments,
  submissions:f.submissions,checkins:[],activity:[],registrations:[],checkouts:[],outbox:[],settings:f.settings,stats:{visitsToday:0},
  staff:[],unpaidAccounts:[],memberHealth:null,visits:{recent:[],last:null,thisMonth:0},paymongo:{configured:true,methods:['gcash','paymaya','grab_pay','card'],testMode:true}});
const records = f => JSON.stringify({member:f.member,invoices:f.invoices,payments:f.payments,submissions:f.submissions});

describe('member front-desk cash instructions', {concurrency:false}, () => {
  let server, origin, browser;
  before(async () => {
    const env = {};
    server = createDevServer(env);
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    origin = env.APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
  });
  after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

  async function open(f, section='overview', width=1440) {
    const page = await browser.newPage({viewport:{width,height:1000}});
    page.setDefaultTimeout(5000);
    page.on('pageerror',error => f.errors.push(error.message));
    await page.addInitScript(() => document.addEventListener('repready-ready',()=>{window.paymentTestReady=true;}));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin === 'https://checkout.paymongo.com') {
        f.navigation.push(url.href);
        return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated secure checkout</title>'});
      }
      if (url.origin !== origin || path.startsWith('/_vercel/')) return route.fulfill({status:200,body:''});
      if (!path.startsWith('/api/')) return route.continue();
      const method = request.method(), payload = method==='GET'?undefined:request.postDataJSON();
      if (method !== 'GET') f.requests.push({path,body:payload});
      let body;
      if (path === '/api/plans' && method === 'GET') body = {plans:f.plans};
      else if (path === '/api/session' && method === 'GET') body = {user:f.user,date:TODAY};
      else if (path === '/api/state' && method === 'GET') body = snapshot(f);
      else if (path === '/api/renew' && method === 'POST') {
        assert.equal(payload.memberId,MEMBER);
        assert.equal(payload.plan,'plus');
        assert.equal(payload.start,'2026-10-31');
        assert.equal(f.invoices.length,1,'renewal creates exactly one isolated invoice');
        f.invoices.push({id:'INV-RENEWAL-003',memberId:MEMBER,plan:'plus',terms:{...f.plans[1]},amount:1499,amountCents:149900,
          paidCents:0,start:payload.start,end:'2026-11-29',due:payload.start,created:TODAY});
        body = {invoiceId:'INV-RENEWAL-003'};
      } else if (path === '/api/paymongo/checkout' && method === 'POST') {
        const invoice = f.invoices.find(i=>i.id===payload.invoiceId);
        assert.ok(invoice,'checkout uses an existing invoice');
        assert.equal(payload.kind,'invoice');
        assert.ok(['gcash','paymaya','grab_pay','card'].includes(payload.method));
        assert.match(payload.requestId,UUID);
        body = {checkout:{id:'checkout-isolated',status:'pending',url:'https://checkout.paymongo.com/isolated-existing-invoice',reviewReason:'',amount:(invoice.amountCents-invoice.paidCents)/100}};
      } else if (path === '/api/payments' && method === 'POST') {
        assert.equal(f.user.role,'staff');
        assert.equal(payload.invoiceId,'INV-EXISTING-001');
        assert.equal(payload.amount,649);
        assert.equal(payload.method,'Cash');
        assert.equal(payload.date,TODAY);
        assert.equal(payload.verified,true);
        assert.match(payload.idempotencyKey,UUID);
        f.invoices[0].paidCents=89900;
        const payment={id:'cash-record',invoiceId:payload.invoiceId,memberId:MEMBER,amount:payload.amount,amountCents:64900,method:'Cash',date:TODAY,reference:''};
        f.payments.push(payment); body={payment};
      } else if (path === '/api/review-payment' && method === 'POST') {
        assert.equal(f.user.role,'admin');
        assert.deepEqual(payload,{id:'old-submission',approve:true,verified:true});
        f.submissions[0].status='approved'; body={ok:true};
      } else {
        f.unexpected.push(`${method} ${path}`);
        return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Unexpected isolated test request'})});
      }
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto(`${origin}/#/${f.user.role==='member'?'member':'admin'}/${section}`);
    await page.waitForFunction(()=>window.paymentTestReady);
    return page;
  }

  const assertClean = f => {assert.deepEqual(f.unexpected,[]);assert.deepEqual(f.errors,[]);};
  async function cashPanel(page, f, invoice) {
    const before=records(f), requests=f.requests.length;
    await page.getByRole('button',{name:TITLE,exact:true}).click();
    const dialog=page.getByRole('dialog');
    assert.equal(await dialog.locator('#modal-title').innerText(),TITLE);
    assert.ok((await dialog.innerText()).includes(INSTRUCTION));
    assert.ok((await dialog.innerText()).includes(invoice.terms.name));
    assert.ok((await dialog.innerText()).includes(invoice.id),'existing invoice identity remains visible');
    assert.equal(await page.evaluate(()=>paymentInvoice),invoice.id);
    const due=(invoice.amountCents-invoice.paidCents)/100;
    assert.ok((await dialog.innerText()).includes(`₱${due.toLocaleString('en-PH',{minimumFractionDigits:due%1?2:0,maximumFractionDigits:2})}`));
    assert.equal(await dialog.locator('.payment-qr,#checkout-form,[data-action="checkout-method"]').count(),0);
    assert.doesNotMatch(await dialog.innerText(),/GCash is not set up|Scan with|Submit for verification|Amount sent|Transaction reference/);
    assert.equal(await dialog.locator('form').count(),0,'instructions cannot submit payment');
    assert.equal(records(f),before);
    assert.equal(f.requests.length,requests,'opening instructions sends no mutation');
    return dialog;
  }
  async function onlinePanel(page,invoice) {
    await page.locator('[data-action="paymongo-online-back"]').click();
    assert.equal(await page.getByRole('dialog').locator('#modal-title').innerText(),'Pay your membership');
    assert.equal(await page.locator('#invoice-channel option').count(),4);
    assert.equal(await page.locator('#invoice-channel optgroup').getAttribute('label'),'Pay online (TEST MODE)');
    assert.match(await page.getByRole('dialog').innerText(),/No real money is collected/);
    assert.equal(await page.evaluate(()=>paymentInvoice),invoice.id);
  }

  test('first unpaid invoice: overview and payments show instructions without QR or mutations; desktop and phones fit',async()=>{
    const f=fixture({configuredQr:true}), invoice=f.invoices[0];
    invoice.paidCents=0;
    const before=records(f), page=await open(f);
    try {
      await page.locator('[data-action="pay"][data-id="INV-EXISTING-001"]').first().click();
      await page.locator('#invoice-channel').selectOption('card');
      for (const width of [1440,390,320]) {
        await page.setViewportSize({width,height:844});
        const dialog=await cashPanel(page,f,invoice);
        assert.equal(await dialog.getByRole('button',{name:'Back',exact:true}).isVisible(),true);
        assert.equal(await dialog.getByRole('button',{name:'Close',exact:true}).isVisible(),true);
        assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,`cash dialog fits ${width}px`);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`page fits ${width}px`);
        if (width===390) {await mkdir('test-results',{recursive:true});await dialog.screenshot({path:'test-results/member-cash-phone.png'});}
        if (width===1440) {await mkdir('test-results',{recursive:true});await dialog.screenshot({path:'test-results/member-cash-desktop.png'});}
        await onlinePanel(page,invoice);
        assert.equal(await page.locator('#invoice-channel').inputValue(),'card','Back preserves selected online method');
      }
      await page.getByRole('button',{name:TITLE,exact:true}).click();
      await page.getByRole('button',{name:'Close',exact:true}).click();
      assert.equal(await page.getByRole('dialog').count(),0);
      await page.evaluate(()=>navigate('payments'));
      await page.locator('[data-action="pay"][data-id="INV-EXISTING-001"]').click();
      await cashPanel(page,f,invoice);
      await page.getByRole('button',{name:'Close dialog',exact:true}).click();
      assert.equal(records(f),before);assert.deepEqual(f.requests,[]);assertClean(f);
    } finally {await page.close();}
  });

  test('renewal creates one invoice; cash instructions preserve it and online checkout uses that existing invoice',async()=>{
    const f=fixture({paid:true}), page=await open(f,'members');
    try {
      await page.locator('[data-action="select-plan"][data-plan="plus"]').click();
      await page.locator('#renew-form input[type="checkbox"]').check();
      await page.getByRole('button',{name:'Create renewal invoice',exact:true}).click();
      await page.locator('[data-action="pay"][data-id="INV-RENEWAL-003"]').waitFor();
      assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/renew');
      const before=records(f), invoice=f.invoices[1];
      await page.locator('[data-action="pay"][data-id="INV-RENEWAL-003"]').click();
      await cashPanel(page,f,invoice);await onlinePanel(page,invoice);
      await page.locator('#invoice-channel').selectOption('card');
      await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).click();
      await page.waitForURL('https://checkout.paymongo.com/isolated-existing-invoice');
      assert.deepEqual(f.requests.map(r=>r.path),['/api/renew','/api/paymongo/checkout']);
      assert.equal(f.requests[1].body.invoiceId,'INV-RENEWAL-003');assert.equal(f.requests[1].body.method,'card');
      assert.equal(records(f),before);assert.equal(f.invoices.length,2);assert.equal(f.navigation.length,1);assertClean(f);
    } finally {await page.close();}
  });

  test('existing unpaid next cycle keeps waiting state and its invoice across cash/Back and every online method',async()=>{
    for (const method of ['gcash','paymaya','grab_pay','card']) {
      const f=fixture({paid:true,waiting:true}), page=await open(f,'members'), invoice=f.invoices[1], before=records(f);
      try {
        assert.match(await page.locator('.next-cycle-note.waiting').innerText(),/waiting for payment/);
        assert.equal(await page.locator('[data-action="select-plan"]').count(),0);
        await page.locator('.next-cycle-note.waiting [data-action="pay"]').click();
        await cashPanel(page,f,invoice);await onlinePanel(page,invoice);
        await page.locator('#invoice-channel').selectOption(method);
        const intent=await page.evaluate(()=>paymentIntent);
        await page.getByRole('button',{name:'Continue to secure checkout',exact:true}).click();
        await page.waitForURL('https://checkout.paymongo.com/isolated-existing-invoice');
        assert.deepEqual(f.requests,[{path:'/api/paymongo/checkout',body:{kind:'invoice',invoiceId:invoice.id,method,requestId:intent}}]);
        assert.equal(records(f),before);assert.equal(f.navigation.length,1);assertClean(f);
      } finally {await page.close();}
    }
  });

  test('staff can still record received cash on the same invoice after explicit funds confirmation',async()=>{
    const f=fixture({role:'staff'}), page=await open(f,'payments');
    try {
      await page.locator('[data-action="pay"][data-id="INV-EXISTING-001"]').click();
      assert.equal(await page.locator('#modal-title').innerText(),'Record a confirmed payment');
      assert.equal(await page.locator('#method').inputValue(),'Cash');
      assert.equal(await page.locator('#amount').inputValue(),'649');
      assert.equal(await page.locator('#funds-verified').isChecked(),false);
      await page.getByRole('button',{name:'Confirm payment',exact:true}).click();
      assert.deepEqual(f.requests,[],'required funds confirmation prevents an unverified record');
      await page.locator('#funds-verified').check();
      await page.getByRole('button',{name:'Confirm payment',exact:true}).click();
      await page.getByRole('heading',{name:'Payment confirmed',exact:true}).waitFor();
      assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/payments');
      assert.equal(f.payments.length,1);assert.equal(f.invoices[0].paidCents,89900);assertClean(f);
    } finally {await page.close();}
  });

  test('historical pending transfer stays visible to its member and remains reviewable by admin',async()=>{
    const submission={id:'old-submission',invoiceId:'INV-EXISTING-001',memberId:MEMBER,amount:649,method:'GCash',reference:'EXISTING-REF-001',status:'pending',receipt:'',date:TODAY};
    const member=fixture();member.submissions.push({...submission});
    const memberPage=await open(member,'payments');
    try {
      assert.match(await memberPage.locator('#main').innerText(),/Submitted payments/);
      assert.match(await memberPage.locator('#main').innerText(),/EXISTING-REF-001/);
      assert.equal(await memberPage.locator('[data-action="review-payment"]').count(),0);
      assert.deepEqual(member.requests,[]);assertClean(member);
    } finally {await memberPage.close();}
    const admin=fixture({role:'admin'});admin.submissions.push({...submission});
    const page=await open(admin,'payments');
    try {
      await page.locator('[data-action="review-payment"][data-id="old-submission"]').click();
      assert.match(await page.getByRole('dialog').innerText(),/Check your own GCash or bank transaction history first/);
      assert.match(await page.getByRole('dialog').innerText(),/EXISTING-REF-001/);
      await page.locator('#review-verified').check();
      await page.getByRole('button',{name:'Confirm payment',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'));
      assert.equal(admin.requests.length,1);assert.equal(admin.submissions[0].status,'approved');assertClean(admin);
    } finally {await page.close();}
  });
});
