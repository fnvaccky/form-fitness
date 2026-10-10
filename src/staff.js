import {randomBytes} from 'node:crypto';
import {serviceClient,result} from './supabase.js';
import {fail,contacts,personName,mobile} from './validation.js';
import {staffView} from './state.js';
// Staff accounts, for administrators. ff_private.staff_admin authorizes every step inside
// PostgreSQL, and src/api.js also gates these routes with admin(). Administrators never see or
// set a staff password: new staff choose their own through the same setup link members receive.
export const RESEND_WINDOW_SECONDS=60;
// Seconds until another setup link may be sent. The database enforces the same window and is the
// authority (its audit row is the sending claim); this only tells the administrator how long to wait.
export function resendRetryAfter(lastResendAt,now=Date.now()){
 const last=Date.parse(lastResendAt||'');
 return Number.isFinite(last)?Math.max(0,Math.ceil((last+RESEND_WINDOW_SECONDS*1000-now)/1000)):0;
}
async function staffAdmin(client,action,body){
 const response=await client.rpc('ff_staff_admin',{action,body});
 if(response.error?.code==='PT429')fail(response.error.message,429);
 return result(response);
}
// Same path as member onboarding: recovery email -> /api/auth/callback -> /#/set-password.
async function sendSetupLink(env,origin,email){
 try{const {error}=await serviceClient(env).auth.resetPasswordForEmail(email,{redirectTo:origin+'/api/auth/callback'});return !error;}
 catch{return false;}
}
export async function createStaff(client,body,env,origin){
 // Defence in depth: the metadata below is a fixed allowlist, but refuse an attempt outright.
 for(const key of ['role','ff_role','ff_workspace','workspace','app_metadata','app_meta_data','password'])
  if(key in body)fail('Staff accounts always get the staff role and set their own password. Remove that field and try again.');
 const prepared=await staffAdmin(client,'prepare-create',contacts(body));
 // SQL can't create a proper Auth user. register_auth_user turns this one into a staff profile with
 // no membership or invoice. Nobody ever sees the throwaway password.
 const {data,error}=await serviceClient(env).auth.admin.createUser({email:prepared.email,password:'Staff9!'+randomBytes(32).toString('base64url'),email_confirm:true,
  app_metadata:{ff_workspace:prepared.workspace,ff_role:'staff'},user_metadata:{form_fitness:true,name:prepared.name,phone:prepared.phone}});
 if(error){
  if(error.code==='email_exists'||/already (been )?registered|already exists/i.test(error.message||''))fail('An account already uses this email.',409);
  fail('The staff account could not be created. Check the details and try again.',502);
 }
 let profile;
 try{profile=await staffAdmin(client,'log-create',{id:data.user.id});}
 catch{fail('Account created, but it could not be recorded. Refresh the staff list, then resend the setup link.',502);}
 // The account stays if the email fails; the administrator resends it later.
 const setupEmailSent=await sendSetupLink(env,origin,prepared.email);
 return {staff:staffView(profile),setupEmailSent,message:setupEmailSent?`Staff account created. A password setup email was sent to ${prepared.email}.`:'Account created; setup email needs a resend.'};
}
export async function updateStaff(client,body){
 if(body.email!==undefined)fail('Email changes require re-creating the account.');
 return {staff:staffView(await staffAdmin(client,'update',{id:body.id,name:personName(body.name),phone:mobile(body.phone)}))};
}
export async function setStaffEnabled(client,body){
 if(typeof body.enabled!=='boolean')fail('Choose whether the account is enabled.');
 return {staff:staffView(await staffAdmin(client,'set-enabled',{id:body.id,enabled:body.enabled}))};
}
export async function resendStaffSetup(client,body,env,origin){
 const wait=resendRetryAfter((await staffAdmin(client,'get',{id:body.id})).lastResendAt);
 if(wait>0)fail(`A setup link was sent less than a minute ago. Try again in ${wait} seconds.`,429);
 const claimed=await staffAdmin(client,'resend',{id:body.id});
 const setupEmailSent=await sendSetupLink(env,origin,claimed.email);
 return {staff:staffView(claimed),setupEmailSent,message:setupEmailSent?`Setup link sent to ${claimed.email}.`:'The setup email could not be sent. Try again in a minute.'};
}
