import nodemailer from 'nodemailer';
import { serviceClient, result } from './supabase.js';
import { coachingLabel, termsLines } from './plans.js';
// terms: the cycle's purchased terms (Task 12A), so an email sent after a plan edit still describes what was bought.
export function paymentEmail(body, invoice, cycle, terms, origin) {
  const remaining=(invoice.amount_cents-invoice.paid_cents)/100;
  return [body, '', `Plan: ${terms.name}`, `Membership dates: ${cycle.start_date} to ${cycle.end_date}`, 'Plan privileges:', ...termsLines(terms).map(f=>`- ${f}`), `Coaching: ${coachingLabel(terms.coaching,terms.coachSessions)}`, '', remaining>0?`Remaining balance: PHP ${remaining.toFixed(2)}. Full payment is required for your member pass.`:'Your membership is fully paid. Your live member pass is available during the membership dates while your account is enabled.', `View your member pass: ${origin}/#/member/overview`, `View invoices and payment instructions: ${origin}/#/member/payments`, 'Sign in to your account. Member QR passes expire after 90 seconds; generate a fresh pass when visiting the gym.'].join('\n');
}
export async function notificationBody(db, row, env) {
  if (!row.event_key?.startsWith('payment:')) return row.body;
  const payment=result(await db.from('ff_payments').select('invoice_id').eq('id',row.event_key.slice(8)).eq('workspace',row.workspace).single());
  const invoice=result(await db.from('ff_invoices').select('*').eq('id',payment.invoice_id).eq('workspace',row.workspace).single());
  const cycle=result(await db.from('ff_memberships').select('*').eq('id',invoice.membership_id).eq('workspace',row.workspace).single());
  const origin=env.APP_ORIGIN || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
  if (!origin) throw Error('Notification origin is missing.');
  return paymentEmail(row.body,invoice,cycle,cycle.terms,new URL(origin).origin);
}
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
      const receipt = await sender.sendMail({from:{name:'RepReady',address:env.GMAIL_ADDRESS},to:row.recipient,subject:row.subject,text:await notificationBody(db,row,env),messageId:`<${row.id}@form-fitness.local>`});
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
