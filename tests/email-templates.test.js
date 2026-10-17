import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import nodemailer from 'nodemailer';
import {readFile} from 'node:fs/promises';
import {notificationEmail} from '../src/email-layout.js';
import {paymentEmail,notificationMessage,flushEmails} from '../src/notifications.js';
import {authEmailTemplates,authTextTemplates,buildEmailTemplates} from '../scripts/build-email-templates.js';

test('HTML notifications escape content and action attributes while retaining the exact plain text',()=>{
 const text='Hello <img src=x onerror=alert(1)> & "Member"\n\nYour account update.';
 const result=notificationEmail({subject:'Update <script>alert(1)</script>',text,action:{label:'Open <account>',url:'https://preview.example.invalid/?a=1&b="two"'}});
 assert.equal(result.text,text);assert.match(result.html,/&lt;img/);assert.match(result.html,/&lt;script&gt;/);assert.match(result.html,/&lt;account&gt;/);
 assert.doesNotMatch(result.html,/<(?:img|script)\b/i);assert.match(result.html,/a=1&amp;b=&quot;two&quot;/);
 for(const url of ['javascript:alert(1)','data:text/html,bad','https://user:password@example.invalid/'])assert.throws(()=>notificationEmail({subject:'Update',text:'Body',action:{label:'Open',url}}));
});

test('payment HTML and text use exact frozen purchased terms and remaining amounts without catalog or health reads',async()=>{
 const terms={name:'Purchased <Momentum>',features:['Everything in Essential','Group classes & equipment'],included:[{line:'Everything in Essential',features:['Frozen locker access']}],coaching:'group',coachSessions:0};
 const cycle={id:'cycle',start_date:'2026-10-01',end_date:'2026-10-30',terms};
 const invoice={id:'invoice',membership_id:cycle.id,amount_cents:149900,paid_cents:50000};
 const values={ff_payments:{invoice_id:invoice.id},ff_invoices:invoice,ff_memberships:cycle},reads=[];
 const db={from(table){assert.ok(Object.hasOwn(values,table),'no unrelated table read');const q={select(){return q;},eq(key,value){reads.push([table,key,value]);return q;},async single(){return {data:values[table],error:null};}};return q;}};
 const row={event_key:'payment:payment-id',workspace:'production',body:'Payment confirmed.',subject:'RepReady payment confirmed',memberHealth:{conditions:['PRIVATE-HEALTH-SENTINEL']}};
 const result=await notificationMessage(db,row,{APP_ORIGIN:'https://preview.example.invalid'});
 assert.equal(result.text,paymentEmail(row.body,invoice,cycle,terms,'https://preview.example.invalid'));
 assert.match(result.text,/PHP 999\.00/);assert.match(result.text,/Everything in Essential: Frozen locker access/);
 assert.match(result.html,/PHP 999\.00/);assert.match(result.html,/Purchased &lt;Momentum&gt;/);assert.match(result.html,/Group classes &amp; equipment/);
 assert.match(result.html,/href="https:\/\/preview\.example\.invalid\/#\/member\/payments"/);
 assert.equal(new Set(reads.map(([table])=>table)).size,3);assert.doesNotMatch(JSON.stringify(result),/PRIVATE-HEALTH-SENTINEL|memberHealth/);
});

test('ordinary notices preserve their body and use the shared layout without unrelated reads',async()=>{
 const row={subject:'Membership update',body:'Your membership is ready.',event_key:'membership:1',conditions:['PRIVATE-SENTINEL']};
 const result=await notificationMessage({from(){throw Error('No data lookup needed');}},row,{APP_ORIGIN:'https://preview.example.invalid'});
 assert.equal(result.text,row.body);assert.match(result.html,/Membership update/);assert.match(result.html,/RepReady/);assert.doesNotMatch(result.html,/PRIVATE-SENTINEL/);
});

test('Auth generated files preserve existing link destinations/parameters, approved wording and expiry behavior',async()=>{
 await buildEmailTemplates({check:true});
 const html=authEmailTemplates(),text=authTextTemplates();
 for(const [name,type] of [['invite','invite'],['recovery','recovery']]) {
   const expression='{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type='+type;
   assert.equal(html[name+'.html'].split('href="'+expression+'"').length-1,2,'button and fallback use the identical existing destination');
   assert.equal(html[name+'.html'].split(expression).length-1,3,'the fallback also displays that same destination as text');
   assert.ok(text[name+'.txt'].includes('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type='+type));
   assert.doesNotMatch(html[name+'.html'],/\.ConfirmationURL|\.SiteURL|\b(?:expires? in|valid for) \d/i);
   for(const field of ['.Data.plan_name','.Data.plan_features','.Data.start','.Data.membership_end'])assert.ok(html[name+'.html'].includes(field),'frozen metadata remains visible');
   assert.doesNotMatch(html[name+'.html'],/\.Data\.(?:conditions|height|weight|health)/i);
 }
 assert.match(html['invite.html'],/>Set up your password<\/h1>/);
 assert.match(html['recovery.html'],/>Choose your RepReady password<\/h1>/);
 assert.doesNotMatch(html['recovery.html'],/set up or (?:recover|reset)/i);
 const config=await readFile('supabase/config.toml','utf8');assert.match(config,/subject = "RepReady - choose your password"/);
});

test('the existing queue sends a real multipart message through an isolated stream transport with unchanged envelope and claim behavior',async()=>{
 const row={id:'notice-id',recipient:'member@example.invalid',subject:'RepReady account update',body:'Your account update.\n\nContact gym reception for help.',status:'queued',event_key:'account:notice'};
 const patches=[],captured=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const url=new URL(req.url,'http://localhost');
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){assert.equal(url.pathname,'/rest/v1/ff_notifications');res.end(JSON.stringify([row]));return;}
  const body=JSON.parse(raw);patches.push(body);
  if(url.searchParams.get('id')==='eq.notice-id')Object.assign(row,body);
  res.end(JSON.stringify(body.status==='sending'?[{id:row.id}]:[]));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const stream=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});
 const transport={async sendMail(message){const output=await stream.sendMail(message);captured.push({message,mime:output.message.toString()});return {accepted:[message.to]};},close(){stream.close();}};
 try {
  const result=await flushEmails({APP_WORKSPACE:'production',SUPABASE_URL:`http://127.0.0.1:${server.address().port}`,SUPABASE_SECRET_KEY:'dummy-local-key',GMAIL_ADDRESS:'sender@example.invalid',GMAIL_APP_PASSWORD:'dummy-unused-password',APP_ORIGIN:'https://preview.example.invalid'},transport);
  assert.deepEqual(result,{status:'processed',count:1});assert.equal(row.status,'sent');assert.equal(captured.length,1);
  const {message,mime}=captured[0];assert.deepEqual(message.from,{name:'RepReady',address:'sender@example.invalid'});assert.equal(message.to,row.recipient);assert.equal(message.subject,row.subject);assert.equal(message.messageId,'<notice-id@form-fitness.local>');
  assert.equal(message.text,row.body);assert.match(message.html,/RepReady/);assert.match(mime,/Content-Type: multipart\/alternative/);assert.match(mime,/Content-Type: text\/plain; charset=utf-8/);assert.match(mime,/Content-Type: text\/html; charset=utf-8/);
  assert.deepEqual(patches.map(p=>p.status),['needs_review','sending','sent']);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
