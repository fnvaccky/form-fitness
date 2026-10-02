import {randomBytes} from 'node:crypto';
import {serviceClient,result} from './supabase.js';
// Payment is already committed before this runs. Auth/email failures never erase it.
export async function fulfillRegistration(registration,env,origin,{retryEmail=false}={}) {
 const db=serviceClient(env);
 const read=async()=>result(await db.from('ff_registrations').select('*').eq('id',registration.id).eq('workspace',registration.workspace).single());
 let row=await read();
 if(!['paid','provisioned'].includes(row.status))return {registration:row,accountReady:false,invitationSent:false};
 if(!row.member_id){
  const {error}=await db.auth.admin.createUser({email:row.email,password:'Member9!'+randomBytes(32).toString('base64url'),email_confirm:true,
   app_metadata:{ff_workspace:row.workspace,ff_role:'member',ff_registration:row.id},
   user_metadata:{form_fitness:true,name:row.name,phone:row.phone,goal:row.goal,plan:row.plan_id,start:row.start_date,plan_name:row.plan_name,plan_features:row.features,membership_end:row.end_date}});
  row=await read();
  if(error&&!row.member_id)return {registration:row,accountReady:false,invitationSent:false,message:'Payment recorded. Account creation needs retry; do not collect payment again.'};
 }
 if(row.email_status==='sending'&&Date.parse(row.email_claimed_at)<Date.now()-5*60000){
  result(await db.from('ff_registrations').update({email_status:'needs_review'}).eq('id',row.id).eq('email_status','sending'));row=await read();
 }
 if(retryEmail&&['failed','needs_review'].includes(row.email_status)){
  result(await db.from('ff_registrations').update({email_status:'queued'}).eq('id',row.id).eq('email_status',row.email_status));row=await read();
 }
 if(row.email_status==='queued'){
  const claim=result(await db.from('ff_registrations').update({email_status:'sending',email_claimed_at:new Date().toISOString()}).eq('id',row.id).eq('email_status','queued').select('id'));
  if(claim.length){
   try{
    const {error}=await db.auth.resetPasswordForEmail(row.email,{redirectTo:origin+'/api/auth/callback'});
    const state=error?(error.status===429||error.status===400?'failed':'needs_review'):'sent';
    result(await db.from('ff_registrations').update({email_status:state,email_sent_at:error?null:new Date().toISOString()}).eq('id',row.id).eq('email_status','sending'));
   }catch{
    await db.from('ff_registrations').update({email_status:'needs_review'}).eq('id',row.id).eq('email_status','sending');
   }
  }
 }
 row=await read();
 return {registration:row,accountReady:!!row.member_id,invitationSent:row.email_status==='sent',message:row.email_status==='sent'?'Payment confirmed. Account setup email sent.':'Payment confirmed. Account is ready; setup email needs review or retry. Do not collect payment again.'};
}
