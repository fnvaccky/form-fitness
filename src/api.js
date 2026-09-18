import { randomUUID } from 'node:crypto';
import { serverClient, serviceClient, configuration, result } from './supabase.js';
import { HttpError, fail, contacts, password, startDate, cents, imageData, today } from './validation.js';
import { BUCKET, stateFor, planView, paymentView, userView, signedImage } from './state.js';
import { flushEmails } from './notifications.js';

function send(res, status, data) { res.statusCode=status; res.end(JSON.stringify(data)); }
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
    if (!['GET','POST'].includes(req.method)) fail('Method not allowed.',405);
    if (req.method==='POST' && req.headers.origin!==origin) fail('Request origin is not allowed.',403);
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
    if (path==='/signup' && req.method==='POST') {
      if(workspace==='demo') fail('Demo registration is disabled. Use the isolated demo setup script.',403);
      const info=contacts(body);password(body.password);startDate(body.start);
      const plans=result(await client.rpc('ff_public_plans')); if(!plans.some(p=>p.id===body.plan&&p.available))fail('Select an available membership plan.');
      const {data,error}=await client.auth.signUp({email:info.email,password:body.password,options:{emailRedirectTo:origin+'/api/auth/callback',data:{...info,form_fitness:true,plan:body.plan,start:body.start,goal:body.goal}}});
      if(error) fail(error.status===429?'Too many attempts. Try again later.':'Registration could not be completed. Check the details or try signing in.',error.status===429?429:400);
      return send(res,201,{memberId:data.user?.id,requiresEmailConfirmation:!data.session});
    }
    if (path==='/recovery' && req.method==='POST') {
      if(workspace==='demo') fail('Reset demo credentials using the secure local seed script.',403);
      const email=String(body.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');
      const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:origin+'/api/auth/callback?next=recovery'});
      if(error && error.status===429)fail('Too many recovery attempts. Try again later.',429);
      if(error)fail('Password recovery is currently unavailable. Contact the gym.',503);
      return send(res,200,{ok:true,message:'If the account exists, check your email for a password setup link.'});
    }
    if (path==='/auth/callback' && req.method==='GET') {
      const code=url.searchParams.get('code');
      if(!code)fail('The sign-in link is missing or invalid. Request a new link.');
      const {error}=await client.auth.exchangeCodeForSession(code);if(error)fail('This link expired or was already used. Request a new link.');
      res.statusCode=303;res.setHeader('Location',origin+'/#/set-password');return res.end();
    }
    if (path==='/auth/verify' && req.method==='POST') {
      if(!['invite','recovery','signup'].includes(body.type)||typeof body.tokenHash!=='string')fail('Invalid setup link.');
      const {error}=await client.auth.verifyOtp({token_hash:body.tokenHash,type:body.type});
      if(error)fail('This link expired or was already used. Request a new link.');
      return send(res,200,{ok:true});
    }
    const {data:{user:authUser}}=await client.auth.getUser();
    let profile=null;
    if(authUser) {
      profile=result(await client.from('ff_profiles').select('*').eq('id',authUser.id).maybeSingle());
      if(profile?.workspace!==workspace) profile=null;
    }
    if(path==='/session' && req.method==='GET')return send(res,200,{user:profile?userView(profile):null,canOwnerLogin:false,date:today()});
    if(!profile)fail('Please sign in to an authorized account for this workspace.',401);
    const admin=()=>{if(profile.role!=='admin')fail('Administrator access is required.',403);};
    if(['/members','/payments','/review-payment','/scan','/check-in','/settings/payments','/settings/email','/plans','/manage-member','/email-retry'].includes(path))admin();
    if(path==='/login')return send(res,200,{ok:true,user:userView(profile)});
    if(path==='/state' && req.method==='GET')return send(res,200,await stateFor(client,profile,env));
    if(path==='/qr' && req.method==='GET')return send(res,200,await rpc('qr'));
    if(req.method!=='POST')fail('Endpoint not found.',404);
    if(path==='/members') {
      admin();if(workspace==='demo')fail('Add demo accounts using the local demo setup script. No invitations are sent in demo mode.',403);
      const info=contacts(body);startDate(body.start);
      const plan=result(await client.from('ff_plans').select('id').eq('id',body.plan).eq('available',true).maybeSingle());if(!plan)fail('Select an available membership plan.');
      const {data,error}=await serviceClient(env).auth.admin.generateLink({type:'invite',email:info.email,options:{data:{...info,form_fitness:true,plan:body.plan,start:body.start,goal:body.goal},redirectTo:origin}});
      if(error)fail('Account invitation could not be created. The address may already be registered.',409);
      const setupUrl=origin+'/#/set-password?type=invite&token_hash='+encodeURIComponent(data.properties.hashed_token);
      // Return once to authorized staff for secure handoff. Never logged or stored in public tables.
      return send(res,201,{member:{id:data.user.id},setupUrl,message:'Share this one-time setup link securely with the member. No permanent password was created or exposed.'});
    }
    if(path==='/password' || path==='/set-password') {
      password(body.newPassword);
      if(path==='/password') {
        const {error}=await client.auth.signInWithPassword({email:profile.email,password:String(body.currentPassword||'')});if(error)fail('Current password is incorrect.',401);
      }
      const {error}=await client.auth.updateUser({password:body.newPassword});if(error)fail('The password could not be updated. Reauthenticate and try again.');
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
    if(path==='/plans'){admin();body.priceCents=cents(body.price);if(typeof body.name!=='string'||/[<>\r\n]/.test(body.name))fail('Enter a valid plan name.');}
    const allowed=['profile','payments','payment-submissions','review-payment','scan','check-in','settings/payments','plans','manage-member','renew'];
    if(!allowed.includes(path.slice(1)))fail('Endpoint not found.',404);
    const data=await rpc(path.slice(1),body);
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
