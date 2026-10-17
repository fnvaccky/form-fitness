import { randomUUID } from 'node:crypto';
import { serverClient, serviceClient, configuration, result } from './supabase.js';
import { HttpError, fail, contacts, password, passwordRefusal, startDate, cents, imageData, today } from './validation.js';
import { BUCKET, stateFor, planView, paymentView, userView, signedImage } from './state.js';
import { fulfillRegistration } from './onboarding.js';
import {createCheckout,reconcileCheckout,recoverCheckout,cancelCheckout,handleWebhook} from './paymongo.js';
import {createStaff,updateStaff,setStaffEnabled,resendStaffSetup} from './staff.js';
import {createMember} from './members.js';
import {attendanceReport,checkinStatus} from './attendance.js';
import {validateSurvey,surveyView} from './survey.js';
import {saveMemberHealth} from './member-health.js';
import {planRequest} from './plans.js';
import {deleteUnpaidAccount,runAutomaticCleanup,cronAuthorized} from './cleanup.js';
import { flushEmails } from './notifications.js';

function send(res, status, data) { res.statusCode=status; res.end(JSON.stringify(data)); }
// Supabase Auth email link types this application accepts. Every link lands on the set-password screen.
const LINK_TYPES = ['signup','email','recovery','invite'];
const SET_PASSWORD = '/#/set-password';
const LINK_USED = 'This link expired or was already used — request a new one.';
// Confirmation links are opened by top-level browser navigation, so a JSON body would be
// shown to the member as raw text. Every interpolated value below is a fixed string or the
// validated origin; the token is never echoed back into the page.
function confirmationPage(res, origin, status, title, detail) {
  res.statusCode=status;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>RepReady</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#143d32;color:#f4f6f5;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:0 0 1.5rem;opacity:.85}a{display:inline-block;padding:.7rem 1.4rem;border-radius:999px;background:#f4f6f5;color:#143d32;text-decoration:none;font-weight:600}</style></head><body><main><h1>${title}</h1><p>${detail}</p><a href="${origin}/">Return to RepReady</a></main></body></html>`);
}
async function readBody(req) {
  if (!req.headers['content-type']?.includes('application/json')) fail('Use a JSON request.',415);
  let body=req.body;
  if (body===undefined) {
    const chunks=[];let length=0;
    for await (const chunk of req) {length+=chunk.length;if(length>1900000) fail('Upload is too large.',413);chunks.push(chunk);}
    body=Buffer.concat(chunks).toString();
  }
  if (typeof body==='string' || Buffer.isBuffer(body)) {try { body=JSON.parse(body.toString()); } catch { fail('Invalid JSON request.'); }}
  if (!body || Array.isArray(body) || typeof body!=='object' || JSON.stringify(body).length>1900000) fail('Invalid request body.');
  return body;
}
async function upload(client, profile, value, kind) {
  if (!value) return '';
  if (!value.startsWith('data:')) {
    const expected = kind==='payments'?`${profile.workspace}/payments/`:`${profile.workspace}/${profile.id}/${kind}/`;
    if (!value.startsWith(expected) || value.includes('..')) fail('Invalid stored image path.');
    return value;
  }
  const {bytes,contentType,extension}=imageData(value);
  const prefix=kind==='payments'?`${profile.workspace}/payments`:`${profile.workspace}/${profile.id}/${kind}`;
  const path=`${prefix}/${randomUUID()}.${extension}`;
  result(await client.storage.from(BUCKET).upload(path,bytes,{contentType,upsert:false}));
  return path;
}
export async function handle(req,res,env=process.env) {
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  try {
    const {origin,workspace}=configuration(env);
    const url=new URL(req.url,origin);
    const path=url.pathname==='/api'&&url.searchParams.has('__path')?'/'+url.searchParams.get('__path'):url.pathname.replace(/^\/api/,'')||'/';
    if(path==='/paymongo/webhook')return await handleWebhook(req,res,env,origin);
    // Task 10: the daily clean-up of never-paid accounts. Vercel Cron calls it with the CRON_SECRET bearer token.
    if(path==='/cron/account-cleanup'){
      if(req.method!=='GET')fail('Method not allowed.',405);
      if(!cronAuthorized(req.headers.authorization,env.CRON_SECRET))fail('Not authorized.',401);
      return send(res,200,await runAutomaticCleanup(env,origin));
    }
    if (!['GET','POST'].includes(req.method)) fail('Method not allowed.',405);
    if (req.method==='POST' && req.headers.origin!==origin) fail(`This page was opened from a different address than the app expects. Open ${origin} and try again.`,403);
    const body=req.method==='POST'?await readBody(req):{};
    const client=serverClient(req,res,env);
    const rpc = async(action, data={}) => result(await client.rpc('ff_command',{action,body:data}));
    if (path==='/plans' && req.method==='GET') return send(res,200,{plans:result(await client.rpc('ff_public_plans')).map(planView)});
    if (path==='/login' && req.method==='POST') {
      const {error}=await client.auth.signInWithPassword({email:String(body.email||'').trim().toLowerCase(),password:String(body.password||'')});
      if (error) fail('Email or password is incorrect, or email confirmation is still required.',401);
    }
    if (path==='/logout' && req.method==='POST') {
      const {error}=await client.auth.signOut({scope:'local'}); if(error && error.status!==403) fail('Sign out could not be confirmed. Try again.',502);
      return send(res,200,{ok:true});
    }
    if (path==='/signup' && req.method==='POST') fail('First membership registration and payment are handled at the gym. Sign in to renew an existing membership.',403);
    if (path==='/recovery' && req.method==='POST') {
      if(workspace==='demo') fail('Reset demo credentials using the secure local seed script.',403);
      const email=String(body.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');
      const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:origin+'/api/auth/callback'});
      if(error && error.status===429)fail('Too many recovery attempts. Try again later.',429);
      if(error)fail('Password recovery is currently unavailable. Contact the gym.',503);
      return send(res,200,{ok:true,message:'If the account exists, check your email for a password setup link.'});
    }
    if (path==='/auth/callback' && req.method==='GET') {
      // Link scanners (Google Safe Browsing, Gmail, Brave) open email links before people do, so a GET
      // never uses the token (BUG-011). It only moves the token into the fragment of the set-password
      // screen, which browsers never send to a server or put in a referrer. Save password checks it.
      // A link that lands on another host (for example Supabase's Site URL fallback) moves to the real
      // domain first, so the session cookie is set there. The target is the fixed APP_ORIGIN, never a
      // value from the request.
      if((req.headers.host||'').toLowerCase()!==new URL(origin).host.toLowerCase()){
        // Only the original query: Vercel's rewrite adds __path and path, which mean nothing to the callback.
        const query=new URLSearchParams(url.search);query.delete('__path');query.delete('path');
        res.statusCode=302;res.setHeader('Location',origin+'/api/auth/callback'+(String(query)?'?'+query:''));return res.end();
      }
      const type=url.searchParams.get('type')||'', tokenHash=url.searchParams.get('token_hash')||'', code=url.searchParams.get('code')||'';
      // Supabase's default email templates return ?code= instead. That exchange needs the verifier cookie
      // stored when the email was requested, so it only succeeds in the same browser, and a scanner
      // without that cookie can't use the code up.
      if(!tokenHash && code){
        const {error}=await client.auth.exchangeCodeForSession(code);
        if(error)
          return confirmationPage(res,origin,400,'This link expired or was already used','Each link works once and expires quickly. Request a new email, then open the most recent message. If you opened this on a different device, open it on the device where you requested it, or request a new link.');
        res.statusCode=303;res.setHeader('Location',origin+SET_PASSWORD);return res.end();
      }
      if(!LINK_TYPES.includes(type) || !tokenHash)
        return confirmationPage(res,origin,400,'This link is not valid','Request a new confirmation or password recovery email, then open the most recent message.');
      res.statusCode=303;res.setHeader('Location',origin+SET_PASSWORD+'?'+new URLSearchParams({token_hash:tokenHash,type}));return res.end();
    }
    if (path==='/auth/verify' && req.method==='POST') {
      // Save password on the set-password screen: the only place a token_hash link is checked. verifyOtp
      // needs no PKCE verifier, so a link works on any device. The password is set further down, once the
      // new session's profile has passed the same gate as /set-password.
      if(!LINK_TYPES.includes(body.type)||typeof body.tokenHash!=='string'||!body.tokenHash)fail('Invalid setup link.');
      password(body.newPassword); // A password the app refuses must not use the link up.
      const {error}=await client.auth.verifyOtp({token_hash:body.tokenHash,type:body.type});
      if(error?.status===429)fail('Too many attempts. Wait a minute, then try again.',429);
      if(error && !(error.status>=400 && error.status<500))fail('Your link couldn’t be checked just now. Try again in a moment.',503);
      if(error)fail(LINK_USED,410);
    }
    const {data:{user:authUser}}=await client.auth.getUser();
    let profile=null;
    if(authUser) {
      profile=result(await client.from('ff_profiles').select('*').eq('id',authUser.id).maybeSingle());
      if(profile?.workspace!==workspace) profile=null;
    }
    if(path==='/session' && req.method==='GET')return send(res,200,{user:profile?userView(profile):null,date:today()});
    if(!profile)fail('Please sign in to an authorized account for this workspace.',401);
    const admin=()=>{if(profile.role!=='admin')fail('Administrator access is required.',403);};
    const gymStaff=()=>{if(!['admin','staff'].includes(profile.role))fail('Gym staff access is required.',403);};
    // These two lists mirror the gate inside ff_private.command; edit them together.
    if(['/review-payment','/settings/payments','/settings/email','/plans','/manage-member','/email-retry'].includes(path))admin();
    if(['/members','/registration-payment','/registration-fulfill','/walkin-renew','/payments','/scan','/check-in'].includes(path))gymStaff();
    // Staff management mirrors the gate inside ff_private.staff_admin.
    if(path==='/staff'||path.startsWith('/staff/'))admin();
    if(path==='/login')return send(res,200,{ok:true,user:userView(profile)});
    if(path==='/state' && req.method==='GET')return send(res,200,await stateFor(client,profile,env));
    if(path==='/qr' && req.method==='GET'){
      const pass=await rpc('qr');
      // 13B: the short code shown under the QR: the same pass, sharing its nonce and 90 seconds.
      const issued=result(await client.rpc('ff_pass_code',{action:'issue',body:{token:pass.token}}));
      return send(res,200,{...pass,code:issued.code});
    }
    // 13A: the member's pass screen asks whether they have checked in today; only their own row is read.
    if(path==='/checkin-status' && req.method==='GET'){if(profile.role!=='member')fail('Sign in as a member.',403);return send(res,200,await checkinStatus(client,profile,today()));}
    // Task 13: attendance for gym staff, read through the caller's session (RLS keeps it to their workspace).
    if(path==='/reports/attendance' && req.method==='GET'){gymStaff();return send(res,200,await attendanceReport(client,Object.fromEntries(url.searchParams),today()));}
    if(req.method!=='POST')fail('Endpoint not found.',404);
    // Task 11: a member's fitness survey comes first. The screen asks for it at first login; this keeps it from being
    // skipped: no plan selection or online checkout until it is saved. Staff and administrators are never asked.
    if(profile.role==='member' && (path==='/renew'||path==='/paymongo/checkout') && !result(await client.from('ff_member_surveys').select('id').eq('id',profile.id).maybeSingle()))
      fail('Complete your fitness survey first.',403);
    // Separate optional health information belongs only to the member, never the roster or survey response.
    if(path==='/member-health') return send(res,200,{memberHealth:await saveMemberHealth(client,profile,body)});
    // Task 11 (from a classmate's survey work): members save their own answers through the session-scoped function.
    if(path==='/member-survey') {
      if(profile.role!=='member')fail('Only members can save their own survey.',403);
      const answers=validateSurvey(body);
      const saved=result(await client.rpc('ff_save_member_survey',{body:answers}));
      return send(res,200,{goal:answers.goal,survey:surveyView(saved)});
    }
    // Task 12A: plan management, through ff_private.plan_admin only (administrators of their own workspace, checked
    // in the database). It answers with the plan as saved, and any plan whose "Everything in" line followed a rename,
    // so the screen shows what the server stored.
    if(path==='/plans'){
      admin();const request=planRequest(body);
      const saved=result(await client.rpc('ff_plan_admin',request));
      return send(res,200,{plan:planView(saved),alreadySaved:saved.alreadySaved===true,alsoUpdated:(saved.alsoUpdated||[]).map(planView)});
    }
    if(path==='/staff'){admin();return send(res,201,await createStaff(client,body,env,origin));}
    if(path==='/staff/update'){admin();return send(res,200,await updateStaff(client,body));}
    if(path==='/staff/enable'){admin();return send(res,200,await setStaffEnabled(client,body));}
    if(path==='/staff/resend'){admin();return send(res,200,await resendStaffSetup(client,body,env,origin));}
    if(path==='/paymongo/checkout')return send(res,200,await createCheckout(client,body,env,origin));
    if(path==='/paymongo/status' || path==='/paymongo/recover' || path==='/paymongo/cancel'){
      if(path!=='/paymongo/status')admin();
      let checkout=result(await client.from('ff_checkouts').select('*').eq('id',body.id).maybeSingle());
      if(!checkout)fail('Checkout not found.',404);
      if(path==='/paymongo/recover'){
        return send(res,200,await recoverCheckout(checkout,body.sessionId,env,origin));
      }
      if(path==='/paymongo/cancel')return send(res,200,await cancelCheckout(client,checkout,env,origin));
      return send(res,200,await reconcileCheckout(checkout,env,origin));
    }
    if(path==='/members') {
      // Task 10, account first: the account now, an optional plan, and the member's own setup email.
      // First registrations saved before this change still finish through /registration-payment.
      gymStaff();
      return send(res,201,await createMember(client,body,env,origin));
    }
    if(path==='/members/delete-unpaid'){admin();return send(res,200,await deleteUnpaidAccount(client,body,env,origin));}
    if(path==='/registration-payment' || path==='/registration-fulfill') {
      gymStaff();
      if(body.retryEmail && body.emailChecked!==true)fail('Check delivery before resending a setup email.');
      const action=path==='/registration-payment'?'cash':'get';
      const request=action==='cash'?{...body,amountCents:cents(body.amount)}:body;
      const registration=result(await client.rpc('ff_registration',{action,body:request}));
      if(!['paid','provisioned'].includes(registration.status))fail('Confirm the first payment before creating an account.');
      let outcome;
      try { outcome=await fulfillRegistration(registration,env,origin,{retryEmail:body.retryEmail===true}); }
      catch { outcome={registration,accountReady:!!registration.member_id,invitationSent:false,message:'Payment recorded. Account/email completion needs retry; do not collect payment again.'}; }
      if(env.GMAIL_ADDRESS&&env.GMAIL_APP_PASSWORD)await flushEmails(env).catch(()=>{});
      return send(res,200,outcome);
    }
    if(path==='/walkin-renew') {
      gymStaff();startDate(body.start);
      const data=result(await client.rpc('ff_walkin_renew',{body:{...body,amountCents:cents(body.amount)}}));
      data.payment=paymentView(data.payment);
      if(env.GMAIL_ADDRESS&&env.GMAIL_APP_PASSWORD)await flushEmails(env).catch(()=>{});
      return send(res,200,data);
    }
    if(path==='/password' || path==='/set-password' || path==='/auth/verify') {
      password(body.newPassword);
      if(path==='/password') {
        const {error}=await client.auth.signInWithPassword({email:profile.email,password:String(body.currentPassword||'')});if(error)fail('Current password is incorrect.',401);
      }
      const {error}=await client.auth.updateUser({password:body.newPassword});
      if(error){
        // BUG-012: say why the account server refused it, with the same reason on the link, its retry and Change password.
        const refusal=passwordRefusal(error);
        if(refusal?.kind==='expired')fail(path==='/password'?'Your sign-in expired. Sign in again, then change your password.':'Your link expired. Request a new one.',path==='/password'?401:410);
        // A link is used up by now, but its session cookie is set, so the screen retries through /set-password (422).
        if(refusal)fail(refusal.message,path==='/auth/verify'?422:400);
        if(path==='/auth/verify')fail('Your link worked, but this password couldn’t be saved. Choose a different one and save again.',422);
        fail('The password could not be updated. Reauthenticate and try again.');
      }
      const signedOut=await client.auth.signOut({scope:'others'});if(signedOut.error)fail('Password changed, but other sessions could not be revoked. Contact the gym.',502);
      return send(res,200,{ok:true});
    }
    if(path==='/settings/email') {admin();fail('Set Gmail sender credentials in the server environment, then redeploy. Credentials are never stored in the browser.',400);}
    if(path==='/email-retry') {admin();await rpc('email-retry',body);return send(res,200,await flushEmails(env));}
    if(path==='/profile') {contacts(body);if(body.photo!==undefined)body.photo=await upload(client,profile,body.photo,'photo');}
    if(path==='/settings/payments') {
      admin();for(const key of ['gcash','bank'])if(body[key]?.image)body[key].image=await upload(client,profile,body[key].image,'payments');
    }
    if(path==='/payment-submissions' && body.receipt)body.receipt=await upload(client,profile,body.receipt,'receipt');
    if(['/payments','/payment-submissions'].includes(path))body.amountCents=cents(body.amount);
    if(path==='/renew')startDate(body.start);
    const allowed=['profile','payments','payment-submissions','review-payment','scan','check-in','settings/payments','manage-member','renew'];
    if(!allowed.includes(path.slice(1)))fail('Endpoint not found.',404);
    // 13B: a typed pass code brings back the member's own signed pass, so the scan (and the check-in after it) is the QR's.
    let viaCode=false;
    if(path==='/scan' && typeof body.code==='string' && !body.token){
      const found=result(await client.rpc('ff_pass_code',{action:'lookup',body:{code:body.code}}));
      if(found.error)fail(found.error,found.status);
      body.token=found.token;delete body.code;viaCode=true;
    }
    const data=await rpc(path.slice(1),body);
    if(viaCode)data.token=body.token;
    if(data.payment)data.payment=paymentView(data.payment);
    if(data.member){const snapshot=await stateFor(client,profile,env);data.member=snapshot.members.find(m=>m.id===data.member.id)||data.member;}
    if(['payments','review-payment','check-in','renew'].includes(path.slice(1)) && env.GMAIL_ADDRESS && env.GMAIL_APP_PASSWORD && env.SUPABASE_SECRET_KEY) {
      await flushEmails(env).catch(()=>{}); // Committed business records remain successful if delivery fails.
    }
    return send(res,200,data);
  } catch(error) {
    if(error instanceof HttpError)return send(res,error.status,{error:error.message});
    // Do not log request bodies, auth tokens, connection strings, or member records.
    console.error('FORM API failure:',error.name);
    return send(res,500,{error:'The request could not be completed. Please try again.'});
  }
}
