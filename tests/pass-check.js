import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import QRCode from 'qrcode';
import {handle} from '../src/api.js';
import {serviceClient,result} from '../src/supabase.js';
import {today} from '../src/validation.js';
assert(['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname),'Local fixtures only');
// Task 13 Part 4: the member QR pass end to end, in the browser, without changing how passes or check-ins work.
// Staff scan by pasted text, QR image and (on a phone) the camera, which Edge's fake camera feeds with a real
// pass. 13A: the member's open pass turns into the check-in confirmation. 13B: staff can type the short pass code
// shown under the QR. Every fixture is removed afterwards.
const env={...process.env,GMAIL_ADDRESS:'',GMAIL_APP_PASSWORD:''};
const db=serviceClient(env),users=[],passed=[],work=path.join(tmpdir(),'repready-pass-'+randomBytes(4).toString('hex'));
const pass=label=>{passed.push(label);console.log('PASS: '+label);};
const root=path.resolve('public');
let origin;
const server=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api/'))return handle(req,res,{...env,APP_WORKSPACE:'production',APP_ORIGIN:origin});
 try{const file=path.resolve(root,'.'+new URL(req.url,origin).pathname),target=file===root?path.join(root,'index.html'):file;assert(target.startsWith(root+path.sep));
  res.setHeader('Content-Type',target.endsWith('.js')?'application/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(target));}
 catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
function client(){
 let cookies='';
 const send=async(method,endpoint,body,status)=>{
  const response=await fetch(origin+'/api'+endpoint,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookies?{Cookie:cookies}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.getSetCookie().length)cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const data=await response.json().catch(()=>({}));if(status!==undefined)assert.equal(response.status,status,`${method} ${endpoint}: ${data.error||response.status}`);return data;
 };
 return {post:(e,b,s=200)=>send('POST',e,b,s),get:(e,s=200)=>send('GET',e,undefined,s)};
}
// Task 11: fixture members come with their fitness survey (as if filled in at the desk), so they skip the first-login survey.
const SURVEY={experience:'regular',exercises:['strength'],availableDays:['mon']};
async function account(role,name,plan){
 const email=`pass-${role}-${randomUUID().slice(0,8)}@example.invalid`,password='Local9!'+randomBytes(24).toString('base64url');
 const {data,error}=await db.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{ff_workspace:'production',...(role==='member'?{}:{ff_role:role})},
  user_metadata:{form_fitness:true,name,phone:'09170000090',...(plan?{plan,start:today()}:{}),...(role==='member'?{survey:SURVEY}:{})}});
 assert.ifError(error);users.push(data.user.id);return {id:data.user.id,email,password,name};
}
// A raw YUV video (Y4M) of a QR code, for Edge's fake camera. The QR fits inside the scanner's centre scan region.
async function qrVideo(token,file){
 const qr=QRCode.create(token,{errorCorrectionLevel:'M'}).modules,n=qr.size,W=640,H=480,scale=Math.floor(280/(n+8)),size=scale*(n+8),ox=(W-size)>>1,oy=(H-size)>>1;
 const Y=Buffer.alloc(W*H,235),UV=Buffer.alloc(W*H/4,128);
 for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.data[r*n+c])for(let y=0;y<scale;y++)Y.fill(16,(oy+(r+4)*scale+y)*W+ox+(c+4)*scale,(oy+(r+4)*scale+y)*W+ox+(c+5)*scale);
 const frame=Buffer.concat([Buffer.from('FRAME\n'),Y,UV,UV]);
 await writeFile(file,Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`),...Array(10).fill(frame)]));
}
const browsers=[];
try{
 await mkdir('test-results',{recursive:true});await mkdir(work,{recursive:true});
 const staff=await account('staff','LOCAL TEST Pass Desk');
 const paid=await account('member','LOCAL TEST Paid Pass','basic'),camera=await account('member','LOCAL TEST Camera Pass','basic'),refresher=await account('member','LOCAL TEST Refresh Pass','plus'),typed=await account('member','LOCAL TEST Typed Pass','basic');
 const unpaid=await account('member','LOCAL TEST Unpaid Pass','basic'),disabled=await account('member','LOCAL TEST Disabled Pass','basic');
 const staffApi=client();await staffApi.post('/login',{email:staff.email,password:staff.password});
 for(const member of [paid,camera,disabled,refresher,typed]){
  const invoice=result(await db.from('ff_invoices').select('id,amount_cents').eq('member_id',member.id).single());
  await staffApi.post('/payments',{invoiceId:invoice.id,amount:invoice.amount_cents/100,method:'Cash',verified:true,date:today(),idempotencyKey:randomUUID()});
 }
 const checkins=async id=>result(await db.from('ff_checkins').select('id').eq('member_id',id).eq('checkin_date',today())).length;
 const shot=async(page,name,fullPage=false)=>{await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:`test-results/${name}.png`,fullPage});};
 const errors=[];
 async function open(browser,person,viewport={width:1440,height:1000},options={}){
  const context=await browser.newContext({viewport,...options});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  if(options.clock)await page.clock.install();
  await page.goto(origin);await page.getByLabel('Email address',{exact:true}).fill(person.email);await page.getByLabel('Password',{exact:true}).fill(person.password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForFunction(()=>currentUser);return page;
 }
 const showPass=async page=>{const got=page.waitForResponse(r=>r.url().endsWith('/api/qr'));await page.getByRole('button',{name:'Show my member QR',exact:true}).click();const r=await got;assert.equal(r.status(),200);return (await r.json()).token;};
 const openScanner=async page=>{await page.getByRole('button',{name:'Scan member',exact:true}).click();await page.locator('#scanner-status').waitFor();};
 const statusPolls=page=>{const seen={count:0};page.on('request',r=>{if(r.url().endsWith('/api/checkin-status'))seen.count++;});return seen;};
 const confirm=async page=>{const done=page.waitForResponse(r=>r.url().endsWith('/api/check-in'));await page.locator('#identity-confirmed').check();await page.getByRole('button',{name:'Confirm check-in',exact:true}).click();assert.equal((await done).status(),200);return Date.now();};
 const confirmation=async(page,confirmedAt,label)=>{
  await page.locator('.checked-in').filter({hasText:/Checked in — \d{1,2}:\d\d [AP]M/}).waitFor({timeout:5000});
  const waited=Date.now()-confirmedAt;assert(waited<=5000,`${label}: the confirmation took ${waited} ms`);
  const shown=await page.locator('.checked-in').innerText(),todayShown=await page.evaluate(d=>date(d),today());
  assert.match(shown,/Have a good workout!/);assert(shown.includes(todayShown),`${label}: today's date (${todayShown}) is shown`);
  assert.equal(await page.locator('#member-qr-canvas').count(),0,`${label}: the QR is gone`);
  return {waited,shown};
 };
 const pasteToken=async(page,token)=>{await page.locator('.scan-alternatives summary').click();await page.locator('#scan-text').fill(token);await page.getByRole('button',{name:'Verify pass',exact:true}).click();};

 const desktop=await chromium.launch({channel:'msedge',headless:true});browsers.push(desktop);
 const member=await open(desktop,paid),desk=await open(desktop,staff);
 const first=await showPass(member);
 await member.locator('#member-qr-canvas').waitFor();await shot(member,'pass-desktop');
 await openScanner(desk);
 await desk.locator('#scanner-status').filter({hasText:'Camera unavailable or permission denied. You can upload a QR image instead.'}).waitFor();
 await pasteToken(desk,first);
 await desk.locator('#modal-title').filter({hasText:'Membership verified'}).waitFor();
 assert.equal(await desk.locator('.scan-member .badge').filter({hasText:'Already recorded'}).count(),0);
 const confirmedAt=await confirm(desk);
 await desk.locator('#toast').filter({hasText:'Check-in confirmed'}).waitFor();
 assert.equal(await checkins(paid.id),1,'one check-in recorded');
 pass('Paid member: the pass shows; staff paste its text, confirm identity and the check-in is recorded');
 const desktopDone=await confirmation(member,confirmedAt,'desktop');assert.match(desktopDone.shown,/Essential/,'the plan is shown');
 await shot(member,'pass-checked-in-desktop');
 await member.getByRole('button',{name:'Close',exact:true}).click();
 const time=desktopDone.shown.match(/Checked in — (\d{1,2}:\d\d [AP]M)/)[1];
 await member.getByRole('link',{name:'Attendance',exact:true}).click();
 assert.match(await member.locator('.my-visits').innerText(),new RegExp(`This month: 1 visit[^s][\\s\\S]*Last visit: [^\\n]*${time}`),'My visits already has the visit');
 assert.match(await member.locator('.my-visits tbody tr').first().innerText(),new RegExp(time));
 await member.getByRole('link',{name:'My overview',exact:true}).click();
 const reopened=member.waitForResponse(r=>r.url().endsWith('/api/checkin-status'));await member.getByRole('button',{name:'Show my member QR',exact:true}).click();await reopened;
 await member.locator('.checked-in').filter({hasText:`Already checked in today at ${time}`}).waitFor();
 assert.equal(await member.locator('#member-qr-canvas').count(),0,'no new QR once checked in today');
 await shot(member,'pass-already-checked-in');
 await member.getByRole('button',{name:'Close',exact:true}).click();
 pass(`Desktop: the member's open pass turned into "Checked in — ${time}" ${desktopDone.waited} ms after staff confirmed, with the date and plan; My visits has the visit; reopening shows "Already checked in today"`);
 await openScanner(desk);await pasteToken(desk,first);
 await desk.locator('#form-error').filter({hasText:'This pass was already used.'}).waitFor();
 await desk.getByRole('button',{name:'Close scanner',exact:true}).click();
 const paidApi=client();await paidApi.post('/login',{email:paid.email,password:paid.password});
 const second=(await paidApi.get('/qr')).token;assert.notEqual(second,first);
 const image=path.join(work,'second.png');await QRCode.toFile(image,second,{width:420,margin:4});
 await openScanner(desk);await desk.locator('#scan-file').setInputFiles(image);
 await desk.locator('#modal-title').filter({hasText:'Membership verified'}).waitFor();
 await desk.locator('.scan-member .badge').filter({hasText:'Already recorded'}).waitFor();
 assert.match(await desk.locator('.modal .notice').innerText(),/Checked in today at \d\d:\d\d \(Manila time\)\. Another scan will not add a visit\./);
 assert.equal(await desk.getByRole('button',{name:'Confirm check-in',exact:true}).isDisabled(),true);
 await shot(desk,'pass-already-recorded');
 await desk.keyboard.press('Escape');assert.equal(await checkins(paid.id),1,'still one check-in');
 pass('The same QR again: "This pass was already used." A fresh QR the same day, scanned from an image: "Already recorded", and Confirm is disabled');
 // 13B: the pass code under the QR, readable on a phone; staff type it in any case, with a space for the dash.
 const CODE=/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
 const typedPhone=await open(desktop,typed,{width:390,height:844},{isMobile:true,hasTouch:true});await showPass(typedPhone);
 const typedCode=await typedPhone.locator('#pass-code').innerText();assert.match(typedCode,CODE,'the code is XXXX-XXXX in Crockford base32');
 const look=await typedPhone.locator('#pass-code').evaluate(e=>({size:parseFloat(getComputedStyle(e).fontSize),left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,below:e.getBoundingClientRect().top>=document.getElementById('member-qr-canvas').getBoundingClientRect().bottom}));
 assert(look.size>=24&&look.left>=0&&look.right<=390&&look.below,'large, on screen and under the QR: '+JSON.stringify(look));
 await shot(typedPhone,'pass-code-phone');
 const typeCode=async value=>{await openScanner(desk);await desk.locator('.scan-alternatives summary').click();await desk.locator('#scan-text').fill(value);await desk.getByRole('button',{name:'Verify pass',exact:true}).click();};
 await typeCode(typedCode==='7KQ2-M9XD'?'7KQ2-M9XA':'7KQ2-M9XD');
 assert.equal(await desk.getByLabel('Pass code',{exact:true}).getAttribute('placeholder'),'e.g. 7KQ2-M9XD');
 await desk.locator('#form-error').filter({hasText:'Pass code not recognised. Check it with the member.'}).waitFor();
 await desk.locator('#scan-text').fill(typedCode.toLowerCase().replace('-',' '));await desk.getByRole('button',{name:'Verify pass',exact:true}).click();
 await desk.locator('#modal-title').filter({hasText:'Membership verified'}).waitFor();
 assert.match(await desk.locator('.scan-member').innerText(),/LOCAL TEST Typed Pass/);
 assert.equal(await desk.locator('#identity-confirmed').isChecked(),false,'the photo-ID box is still required');
 const typedConfirmedAt=await confirm(desk);await desk.locator('#toast').filter({hasText:'Check-in confirmed'}).waitFor();
 assert.equal(await checkins(typed.id),1,'checked in by the typed code');
 await confirmation(typedPhone,typedConfirmedAt,'typed code');
 await typeCode(typedCode);await desk.locator('#form-error').filter({hasText:'This pass code was already used.'}).waitFor();
 await desk.getByRole('button',{name:'Close scanner',exact:true}).click();
 pass('Pass code: readable under the QR on a phone; staff type it in lower case with a space for the dash, still tick the photo ID, and check the member in; a wrong code and a used code are refused');
 const guard=await account('staff','LOCAL TEST Code Guard'),guardApi=client();await guardApi.post('/login',{email:guard.email,password:guard.password});
 for(let i=1;i<=10;i++)assert.equal((await guardApi.post('/scan',{code:'0000-00'+String(i).padStart(2,'0')},400)).error,'Pass code not recognised. Check it with the member.');
 assert.equal((await guardApi.post('/scan',{code:typedCode},429)).error,'Too many attempts — wait a few minutes.');
 pass('Through the API: ten wrong codes from one staff account, then 429 "Too many attempts — wait a few minutes."');
 const unpaidPage=await open(desktop,unpaid);
 await unpaidPage.locator('.member-pass-bar').filter({hasText:'Your membership starts after full payment'}).waitFor();
 assert.equal(await unpaidPage.getByRole('button',{name:'Show my member QR',exact:true}).count(),0);
 const unpaidApi=client();await unpaidApi.post('/login',{email:unpaid.email,password:unpaid.password});
 assert.match((await unpaidApi.get('/qr',400)).error,/^Check-in denied/);
 const disabledApi=client();await disabledApi.post('/login',{email:disabled.email,password:disabled.password});
 const disabledToken=(await disabledApi.get('/qr')).token;
 result(await db.from('ff_profiles').update({enabled:false}).eq('id',disabled.id));
 await openScanner(desk);await pasteToken(desk,disabledToken);
 await desk.locator('#form-error').filter({hasText:'This membership is inactive.'}).waitFor();
 assert.equal(await checkins(disabled.id),0);
 pass('An unpaid member has no pass (none offered, and the server refuses one); a disabled member\'s pass is refused at the scanner');

 // Phone: a camera that sees the camera member's live pass.
 const cameraApi=client();await cameraApi.post('/login',{email:camera.email,password:camera.password});
 const video=path.join(work,'pass.y4m');await qrVideo((await cameraApi.get('/qr')).token,video);
 const phoneBrowser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${video}`]});browsers.push(phoneBrowser);
 const phoneContext=await phoneBrowser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['camera']});
 await phoneContext.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__cameraRequests=[];navigator.mediaDevices.getUserMedia=c=>{window.__cameraRequests.push(JSON.stringify(c));return original(c);};});
 const phone=await phoneContext.newPage();phone.on('pageerror',e=>errors.push(e.message));
 await phone.goto(origin);await phone.getByLabel('Email address',{exact:true}).fill(staff.email);await phone.getByLabel('Password',{exact:true}).fill(staff.password);
 await phone.getByRole('button',{name:'Log in',exact:true}).click();await phone.waitForFunction(()=>currentUser);
 const cameraPhone=await open(desktop,camera,{width:390,height:844},{isMobile:true,hasTouch:true});await showPass(cameraPhone);
 await openScanner(phone);
 await phone.locator('#modal-title').filter({hasText:'Membership verified'}).waitFor({timeout:30000});
 assert.match(await phone.locator('.scan-member').innerText(),/LOCAL TEST Camera Pass/);
 const requests=await phone.evaluate(()=>window.__cameraRequests);
 assert(requests.some(r=>/environment/.test(r)),'the back camera is asked for first: '+requests.join(' | '));
 await shot(phone,'pass-phone-camera-verified');
 const phoneConfirmedAt=await confirm(phone);
 await phone.locator('#toast').filter({hasText:'Check-in confirmed'}).waitFor();assert.equal(await checkins(camera.id),1);
 pass('Phone: the camera asks for the back camera, reads a live pass from the camera feed, and the check-in is recorded');
 const phoneDone=await confirmation(cameraPhone,phoneConfirmedAt,'phone');
 const card=await cameraPhone.locator('.checked-in').boundingBox();assert(card.x>=0&&card.x+card.width<=390,'the confirmation fits a phone screen');
 await shot(cameraPhone,'pass-checked-in-phone');
 pass(`Phone: the member's open pass turned into the confirmation ${phoneDone.waited} ms after staff confirmed`);

 // Phone: camera blocked.
 const blockedBrowser=await chromium.launch({channel:'msedge',headless:true});browsers.push(blockedBrowser);
 const blocked=await open(blockedBrowser,staff,{width:390,height:844},{isMobile:true,hasTouch:true});
 await openScanner(blocked);
 await blocked.locator('#scanner-status').filter({hasText:'Camera unavailable or permission denied. You can upload a QR image instead.'}).waitFor();
 assert.equal(await blocked.locator('#scan-file').isVisible(),true);assert.equal(await blocked.locator('.scan-alternatives summary').isVisible(),true);
 await shot(blocked,'pass-phone-camera-blocked');
 pass('Phone: with the camera blocked, a readable message, and the image upload and pasted-text fallbacks stay visible');

 // The pass screen refreshes itself every 90 seconds while it is open (10 times at most).
 const watcher=await open(desktop,refresher),polls=statusPolls(watcher);
 await showPass(watcher);await watcher.waitForTimeout(6500);
 assert(polls.count>=2&&polls.count<=4,'about every 3 seconds while the pass is open: '+polls.count);
 const visibility=hidden=>watcher.evaluate(h=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>h});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>h?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));},hidden);
 await visibility(true);await watcher.waitForTimeout(500);let before=polls.count;await watcher.waitForTimeout(6500);assert.equal(polls.count,before,'no checks while the tab is hidden');
 before=polls.count;await visibility(false);await watcher.waitForTimeout(1500);assert(polls.count>before,'checking resumes as soon as the tab is visible again');
 await watcher.getByRole('button',{name:'Close',exact:true}).click();await watcher.waitForTimeout(300);before=polls.count;await watcher.waitForTimeout(6500);
 assert.equal(polls.count,before,'no checks after the pass screen closes');
 pass('The pass screen checks for the check-in about every 3 seconds, and stops while the tab is hidden or once the screen closes');
 const passPhone=await open(blockedBrowser,refresher,{width:390,height:844},{isMobile:true,hasTouch:true,clock:true});
 const tokenA=await showPass(passPhone);
 await passPhone.locator('#qr-countdown').filter({hasText:/Pass expires in (8\d|90) seconds/}).waitFor();
 const box=await passPhone.locator('#member-qr-canvas').boundingBox();assert(box.width>=240&&box.width<=390,'the QR is large enough on a phone: '+box.width);
 await shot(passPhone,'pass-phone');
 let previous=tokenA;
 for(let i=1;i<=10;i++){
  const next=passPhone.waitForResponse(r=>r.url().endsWith('/api/qr'));await passPhone.clock.fastForward(91000);
  const fresh=await (await next).json(),token=fresh.token;assert.notEqual(token,previous,`refresh ${i} brings a new pass`);previous=token;
  await passPhone.locator('#pass-code').filter({hasText:fresh.code}).waitFor();assert.match(fresh.code,CODE,'and a new code with it');
  await passPhone.locator('#qr-countdown').filter({hasText:/Pass expires in (8\d|90) seconds/}).waitFor();
  assert.equal(await passPhone.locator('#member-qr-canvas').evaluate(c=>c.style.opacity),'','the fresh QR is fully visible');
 }
 await passPhone.clock.fastForward(91000);
 await passPhone.locator('#qr-countdown').filter({hasText:'Pass expired. Refresh to get a new QR.'}).waitFor();
 pass('The pass refreshes itself when its 90 seconds run out (counting from when it arrived, so a phone clock that is off doesn\'t matter), and stops after 10 refreshes');
 assert.deepEqual(errors,[],'no JavaScript errors');
 console.log(`PASS: ${passed.length} pass checks`);
}finally{
 for(const b of browsers)await b.close();server.close();await rm(work,{recursive:true,force:true});
 for(const id of users){for(const table of ['ff_checkins','ff_notifications','ff_payments','ff_invoices','ff_memberships'])result(await db.from(table).delete().eq('member_id',id));}
 for(const id of users.reverse()){result(await db.from('ff_profiles').delete().eq('id',id));await db.auth.admin.deleteUser(id);}
}
