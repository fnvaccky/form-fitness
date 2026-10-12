import {randomBytes} from 'node:crypto';
import {serviceClient,result} from './supabase.js';
import {fail,contacts,startDate} from './validation.js';
import {sendSetupLink} from './staff.js';
// Task 10: account-first registration. Gym staff create the member's account at once, with no plan
// needed; the member sets their own password from the same setup link staff get, then chooses a plan and
// pays online or at the desk. ff_private.member_admin checks the role and the email in the database first.
export async function createMember(client,body,env,origin){
 // Defence in depth: the metadata below is a fixed allowlist, but refuse an attempt outright.
 for(const key of ['role','ff_role','ff_workspace','workspace','app_metadata','app_meta_data','password'])
  if(key in body)fail('Accounts created here are always members, and members set their own password. Remove that field and try again.');
 const info=contacts(body),goal=String(body.goal??'').trim();
 if(goal.length>100||/[<>\r\n]/.test(goal))fail('Keep the goal under 100 characters, without special characters.');
 const plan=String(body.plan??'').trim();
 if(plan)startDate(body.start);
 const prepared=result(await client.rpc('ff_member_admin',{action:'prepare-create',body:{email:info.email}}));
 // SQL can't create a proper Auth user. register_auth_user turns this one into a member profile with no
 // plan yet. Nobody ever sees the throwaway password.
 const {data,error}=await serviceClient(env).auth.admin.createUser({email:prepared.email,password:'Member9!'+randomBytes(32).toString('base64url'),email_confirm:true,
  app_metadata:{ff_workspace:prepared.workspace,ff_role:'member'},user_metadata:{form_fitness:true,name:info.name,phone:info.phone,goal}});
 if(error){
  if(error.code==='email_exists'||/already (been )?registered|already exists/i.test(error.message||''))fail('An account already uses this email.',409);
  // A simultaneous Add member for the same email loses inside the Auth trigger, which GoTrue reports only
  // as a database error. Asking the database again gives the real reason.
  result(await client.rpc('ff_member_admin',{action:'prepare-create',body:{email:info.email}}));
  fail('The member account could not be created. Check the details and try again.',502);
 }
 const member={id:data.user.id,name:info.name,email:prepared.email,phone:info.phone};
 // A plan chosen at the desk creates the unpaid cycle and invoice the way renewals do.
 let invoiceId=null,planNote='';
 if(plan){
  try{invoiceId=result(await client.rpc('ff_command',{action:'renew',body:{memberId:member.id,plan,start:body.start}})).invoiceId;}
  catch(e){planNote=` The plan wasn't added: ${e.message} Choose it again from Renewals & payments.`;}
 }
 // The account stays if the email fails; the member can use Forgot password for a fresh link.
 const setupEmailSent=await sendSetupLink(env,origin,prepared.email);
 return {member,invoiceId,setupEmailSent,
  message:(setupEmailSent?`Account created. A password setup email was sent to ${prepared.email}.`:'Account created, but the setup email didn’t go out. The member can use Forgot password on the sign-in page.')+planNote};
}
