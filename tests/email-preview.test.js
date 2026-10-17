// Dummy-only email previews. No Auth, SMTP, mailbox, database or application request is made.
// Requires Go on PATH, or EMAIL_PREVIEW_GO pointing to a Go executable, for real contextual escaping.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {authEmailTemplates,authTextTemplates,buildEmailTemplates} from '../scripts/build-email-templates.js';
import {escapeEmail,notificationEmail} from '../src/email-layout.js';
import {paymentEmail} from '../src/notifications.js';

const output=resolve('test-results/email-preview');
const token='d'.repeat(64),redirect='https://example.invalid/api/auth/callback';
const member={Email:'member@example.invalid',RedirectTo:redirect,TokenHash:token,Data:{name:'Morgan Example',plan_name:'Essential',start:'2026-10-01',membership_end:'2026-10-30',plan_features:['Purchased gym access','Fitness orientation','No coach']}};
const staff={Email:'staff@example.invalid',RedirectTo:redirect,TokenHash:token,Data:{name:'Casey Example'}};
const terms={name:'Essential',days:30,features:['Purchased gym access','Fitness orientation'],coaching:'none',coachSessions:0};
const paymentText=paymentEmail('Hello Morgan Example, payment received: PHP 899.00.',{amount_cents:89900,paid_cents:89900},{start_date:'2026-10-01',end_date:'2026-10-30'},terms,'https://example.invalid');
const payment=notificationEmail({subject:'Payment received',text:paymentText,action:{label:'View your payment',url:'https://example.invalid/#/member/payments'}});
let browser,renderer;
before(async()=>{
 await mkdir(output,{recursive:true});renderer=join(output,process.platform==='win32'?'render-email-template.exe':'render-email-template');
 execFileSync(process.env.EMAIL_PREVIEW_GO||'go',['build','-o',renderer,'tests/render-email-template.go'],{env:{...process.env,GOTOOLCHAIN:'local',GOENV:'off',GOPROXY:'off'},encoding:'utf8',timeout:120000});
 browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER_CHANNEL||'msedge'});
});
after(async()=>{await browser?.close();});
const renderGo=(template,data,format='html')=>execFileSync(renderer,[],{input:JSON.stringify({template,data,format}),encoding:'utf8',timeout:10000});
async function preview(html,width=1440) {
 const page=await browser.newPage({viewport:{width,height:1000}}),requests=[],errors=[];
 await page.route('**/*',route=>route.abort());
 page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(error.message));
 await page.setContent(html,{waitUntil:'load'});
 return {page,requests,errors};
}
const clean=({requests,errors})=>{assert.deepEqual(requests,[],'no remote images, fonts, tracking or outbound navigation');assert.deepEqual(errors,[]);};

test('committed Auth templates match the shared generator and use an image-independent inline shell',async()=>{
 await buildEmailTemplates({check:true});
 for(const [name,html] of Object.entries(authEmailTemplates())) {
  assert.equal((await readFile(new URL('../supabase/templates/'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n'),html);
  assert.match(html,/name="viewport"/);assert.match(html,/role="presentation"/);assert.match(html,/<!--[\s\S]*mso/);
  assert.match(html,/RepReady/);assert.match(html,/copy and paste this link/);
  assert.doesNotMatch(html,/<img\b|<script\b|<link\b|@import|url\(/i);
  assert.doesNotMatch(html,/confirmation_url|access_token/i);
 }
});

test('prepared plain-text Auth companions render with real Go text templates without claiming active SMTP multipart delivery',async()=>{
 for(const [name,template] of Object.entries(authTextTemplates())) {
  assert.equal((await readFile(new URL('../supabase/templates/'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n'),template);
  const text=renderGo(template,member,'text'),type=name==='invite.txt'?'invite':'recovery';
  assert.ok(text.includes(`${redirect}?token_hash=${token}&type=${type}`));assert.match(text,/Purchased gym access/);assert.match(text,/No coach/);
  assert.doesNotMatch(text,/<html|<body|<a\b|undefined|<nil>/i);
  await writeFile(join(output,'after-'+name),text);
 }
 const staffText=renderGo(authTextTemplates()['recovery.txt'],staff,'text');assert.doesNotMatch(staffText,/Your purchased membership|Plan:/);
});

test('real Go HTML templates preserve the expected Auth destinations and escape hostile profile values',async()=>{
 for(const [name,template] of Object.entries(authEmailTemplates())) {
  const data=structuredClone(member);data.Data.name='Example <img src="https://example.invalid/private" onerror="alert(1)"> & "Member"';
  data.Data.plan_name='Essential <script>alert(1)</script>';data.Data.plan_features=['Benefit <img src=x>','A & B'];
  const html=renderGo(template,data),view=await preview(html);
  try {
   const links=await view.page.locator('a').evaluateAll(anchors=>anchors.map(anchor=>anchor.getAttribute('href')));
   assert.equal(links.length,2,'one action and one visible fallback');
   for(const href of links){const url=new URL(href);assert.equal(url.origin,'https://example.invalid');assert.equal(url.pathname,'/api/auth/callback');assert.equal(url.searchParams.get('token_hash'),token);assert.equal(url.searchParams.get('type'),name==='invite.html'?'invite':'recovery');}
   assert.equal(await view.page.locator('img,script').count(),0);
   assert.ok((await view.page.locator('body').innerText()).includes(data.Data.name));
   assert.ok((await view.page.locator('body').innerText()).includes(data.Data.plan_name));
   assert.doesNotMatch(html,/#ZgotmplZ|<no value>|<nil>/);clean(view);
  }finally{await view.page.close();}
 }
});

test('staff and missing optional metadata render a useful recovery email without invented purchased terms',async()=>{
 for(const data of [staff,{...staff,Data:{}}]) {
  const view=await preview(renderGo(authEmailTemplates()['recovery.html'],data));
  try {
   const text=await view.page.locator('body').innerText();assert.match(text,/staff@example\.invalid/);assert.match(text,/choose.*password/i);
   assert.doesNotMatch(text,/Your purchased membership|Plan privileges|Plan:|undefined|<nil>/i);
   assert.equal(await view.page.locator('a').count(),2);clean(view);
  }finally{await view.page.close();}
 }
});

test('Node notifications preserve the plain-text alternative while escaping dynamic text and rejecting unsafe actions',async()=>{
 const text='Hello <img src="https://example.invalid/x">\n\nBalance: PHP 12.00 & benefits unchanged.';
 const email=notificationEmail({subject:'An <unsafe> title',text,action:{label:'Open "account"',url:'https://example.invalid/#/member/payments'}});
 assert.equal(email.text,text);assert.match(email.html,/&lt;unsafe&gt;/);assert.match(email.html,/&lt;img/);
 assert.throws(()=>notificationEmail({subject:'Test',text,action:{label:'Open',url:'javascript:alert(1)'}}),/invalid/i);
 const view=await preview(email.html);
 try{assert.equal(await view.page.locator('img,script').count(),0);assert.ok((await view.page.locator('body').innerText()).includes(text));clean(view);}finally{await view.page.close();}
 assert.equal(payment.text,paymentText);assert.match(payment.html,/Purchased gym access/);assert.match(payment.html,/No coach/);
});

test('long member values and fallback destinations stay within phone widths without relying on images',async()=>{
 const data=structuredClone(member);data.Data.name='VeryLongMemberName'.repeat(12);data.Email='long-account-name'.repeat(8)+'@example.invalid';
 const html=renderGo(authEmailTemplates()['recovery.html'],data);
 for(const width of [390,320]) {
  const view=await preview(html,width);
  try{assert.equal(await view.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px no horizontal overflow`);assert.equal(await view.page.locator('a').first().isVisible(),true);clean(view);}finally{await view.page.close();}
 }
});

test('dummy before/after previews fit desktop and phones with all external resources blocked',async()=>{
 const beforeInvite=execFileSync('git',['show','2dbd5c3:supabase/templates/invite.html'],{encoding:'utf8'});
 const beforeRecovery=execFileSync('git',['show','2dbd5c3:supabase/templates/recovery.html'],{encoding:'utf8'});
 const variants=[
  {name:'invite-member',before:renderGo(beforeInvite,member),after:renderGo(authEmailTemplates()['invite.html'],member)},
  {name:'recovery-member',before:renderGo(beforeRecovery,member),after:renderGo(authEmailTemplates()['recovery.html'],member)},
  {name:'recovery-staff',before:renderGo(beforeRecovery,staff),after:renderGo(authEmailTemplates()['recovery.html'],staff)},
  {name:'payment',before:'<!doctype html><html><body><pre style="white-space:pre-wrap;overflow-wrap:anywhere;">'+escapeEmail(paymentText)+'</pre></body></html>',after:payment.html}
 ];
 for(const variant of variants)for(const stage of ['before','after']) {
  await writeFile(join(output,`${stage}-${variant.name}.html`),variant[stage]);
  for(const width of [1440,390,320]) {
   const view=await preview(variant[stage],width);
   try {
    if(stage==='after') {
     assert.equal(await view.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${variant.name} ${width}px`);
     const button=view.page.locator('a').first(),box=await button.boundingBox();assert.ok(box.height>=44,'prominent action fits a touch target');
     assert.match(await view.page.locator('body').innerText(),/RepReady/);assert.equal(await view.page.locator('img').count(),0);
    }
    await view.page.screenshot({path:join(output,`${stage}-${variant.name}-${width}-images-blocked.png`),fullPage:true,animations:'disabled'});clean(view);
   }finally{await view.page.close();}
  }
 }
 const gallery=variants.map(variant=>`<section><h2>${escapeEmail(variant.name)}</h2><p><a href="before-${variant.name}.html">Before HTML</a> · <a href="after-${variant.name}.html">After HTML</a></p>${[1440,390,320].map(width=>`<h3>${width}px, external images blocked</h3><div class="pair">${['before','after'].map(stage=>`<figure><figcaption>${stage}</figcaption><a href="${stage}-${variant.name}-${width}-images-blocked.png"><img src="${stage}-${variant.name}-${width}-images-blocked.png" alt="${stage} ${escapeEmail(variant.name)} at ${width}px"></a></figure>`).join('')}</div>`).join('')}</section>`).join('');
 await writeFile(join(output,'index.html'),'<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RepReady dummy email previews</title><style>body{max-width:1100px;margin:30px auto;padding:0 20px;font:16px/1.6 Arial,sans-serif;color:#183e33;background:#f5f6f2}section{margin:40px 0}.pair{display:flex;gap:24px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}img{display:block;max-width:100%;height:auto;border:1px solid #ddd}figcaption{text-transform:capitalize;font-weight:bold;margin-bottom:8px}</style><h1>RepReady dummy email previews</h1><p>Dummy accounts and tokens only. No messages were sent and no action links were opened. These browser previews verify the layout with remote resources blocked; they do not replace Gmail, Apple Mail or Outlook inbox testing.</p>'+gallery+'</html>');
});
