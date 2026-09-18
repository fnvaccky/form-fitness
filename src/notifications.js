import nodemailer from 'nodemailer';
import { serviceClient, result } from './supabase.js';
// A stable Message-ID helps investigation; SMTP cannot guarantee exactly-once delivery.
export async function flushEmails(env = process.env, transport) {
  if (env.APP_WORKSPACE === 'demo') return { status:'suppressed', count:0 };
  if (!env.GMAIL_ADDRESS || !env.GMAIL_APP_PASSWORD) return { status:'unconfigured', count:0 };
  const db = serviceClient(env);
  const stale = new Date(Date.now()-5*60000).toISOString();
  result(await db.from('ff_notifications').update({status:'needs_review',error:'The sending process ended without a confirmed result. Check Gmail Sent before retrying.'}).eq('workspace','production').eq('status','sending').lt('claimed_at',stale));
  const rows = result(await db.from('ff_notifications').select('*').eq('workspace','production').eq('status','queued').order('created_at').limit(3));
  const sender = transport || nodemailer.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:env.GMAIL_ADDRESS,pass:env.GMAIL_APP_PASSWORD},connectionTimeout:8000,greetingTimeout:8000,socketTimeout:10000,logger:false,debug:false});
  let count=0;
  for (const row of rows) {
    const claim = result(await db.from('ff_notifications').update({status:'sending',claimed_at:new Date().toISOString()}).eq('id',row.id).eq('status','queued').select('id'));
    if (!claim.length) continue;
    try {
      const receipt = await sender.sendMail({from:{name:'FORM Fitness',address:env.GMAIL_ADDRESS},to:row.recipient,subject:row.subject,text:row.body,messageId:`<${row.id}@form-fitness.local>`});
      const accepted = receipt.accepted?.includes(row.recipient);
      result(await db.from('ff_notifications').update({status:accepted?'sent':'failed',sent_at:accepted?new Date().toISOString():null,error:accepted?null:'SMTP rejected the recipient.'}).eq('id',row.id).eq('status','sending'));
      count++;
    } catch (error) {
      // Authentication/connect failures occur before DATA; anything else is ambiguous.
      const definite = ['EAUTH','ECONNECTION','EDNS'].includes(error.code);
      await db.from('ff_notifications').update({status:definite?'failed':'needs_review',error:definite?'The Gmail connection or authentication failed. Check server configuration.':'SMTP acceptance was not confirmed. Check Gmail Sent before retrying.'}).eq('id',row.id).eq('status','sending');
    }
  }
  sender.close?.();
  return {status:'processed',count};
}
