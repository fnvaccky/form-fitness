import { allRows, result } from './supabase.js';
import { today } from './validation.js';
export const BUCKET = 'form-fitness-private';
const datePH = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0,10);
export const paymentView = p => ({ id:p.id, invoiceId:p.invoice_id, memberId:p.member_id, amount:p.amount_cents/100, amountCents:p.amount_cents, method:p.method, reference:p.reference, date:p.payment_date });
export const planView = p => ({ id:p.id, name:p.name, price:p.price_cents/100, priceCents:p.price_cents, available:p.available, days:p.days, desc:p.description, features:p.features, tag:p.id==='plus'?'YOUR NEXT LEVEL':'YOUR FITNESS JOURNEY' });
export const userView = p => ({ id:p.id, memberId:p.id, role:p.role, name:p.name, email:p.email, workspace:p.workspace });
export async function signedImage(client, path) {
  if (!path) return '';
  return result(await client.storage.from(BUCKET).createSignedUrl(path, 300)).signedUrl;
}
export async function stateFor(client, profile, env) {
  const [profiles, cycles, invoices, payments, submissions, checkins, plans, settings, outbox] = await Promise.all([
    allRows(client,'ff_profiles'), allRows(client,'ff_memberships'), allRows(client,'ff_invoices'), allRows(client,'ff_payments'), allRows(client,'ff_submissions'),
    client.from('ff_checkins').select('*').order('created_at',{ascending:false}).limit(50).then(result),
    client.from('ff_plans').select('*').order('price_cents').then(result),
    client.from('ff_settings').select('*').single().then(result),
    profile.role==='admin' ? client.from('ff_notifications').select('id,recipient,subject,status,error,created_at,sent_at').order('created_at',{ascending:false}).limit(50).then(result) : []
  ]);
  const current = today();
  const members = await Promise.all(profiles.filter(p=>p.role==='member').map(async p=> {
    const own = cycles.filter(c=>c.member_id===p.id).sort((a,b)=>a.start_date.localeCompare(b.start_date));
    const cycle = own.find(c=>c.start_date<=current && c.end_date>=current) || own.find(c=>c.start_date>current) || own.at(-1);
    return { id:p.id,name:p.name,email:p.email,phone:p.phone,goal:p.goal,enabled:p.enabled,photo:await signedImage(client,p.photo),photoPath:p.photo,plan:cycle?.plan_id,start:cycle?.start_date,end:cycle?.end_date,joined:datePH(p.created_at) };
  }));
  const destinations = {};
  for (const [key, value] of Object.entries(settings.payments || {})) destinations[key] = {...value,imagePath:value.image,image:await signedImage(client,value.image)};
  return {
    user:userView(profile),date:current,members,plans:plans.map(planView),
    invoices:invoices.map(i=>{const c=cycles.find(c=>c.id===i.membership_id);return {id:i.id,memberId:i.member_id,plan:c.plan_id,amount:i.amount_cents/100,amountCents:i.amount_cents,paidCents:i.paid_cents,start:c.start_date,end:c.end_date,due:c.start_date,created:datePH(i.created_at)};}),
    memberships:cycles,payments:payments.map(paymentView),
    submissions:await Promise.all(submissions.map(async s=>({id:s.id,invoiceId:s.invoice_id,memberId:s.member_id,amount:s.amount_cents/100,method:s.method,reference:s.reference,status:s.status,receipt:await signedImage(client,s.receipt),date:datePH(s.created_at)}))),
    checkins:checkins.map(c=>({id:c.id,memberId:c.member_id,name:members.find(m=>m.id===c.member_id)?.name,date:datePH(c.created_at),timestamp:c.created_at})),
    activity:[...payments.map(p=>({text:`Payment confirmed: PHP ${(p.amount_cents/100).toFixed(2)}.`,date:datePH(p.created_at)})),...checkins.map(c=>({text:`${members.find(m=>m.id===c.member_id)?.name||'Member'} checked in.`,date:datePH(c.created_at)}))].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20),
    settings:{payments:destinations,email:profile.role==='admin'?{connected:!!(env.GMAIL_ADDRESS&&env.GMAIL_APP_PASSWORD),address:env.GMAIL_ADDRESS||'',disabled:profile.workspace==='demo'}:null},
    outbox:outbox.map(n=>({...n,created:Math.floor(Date.parse(n.created_at)/1000),sent:n.sent_at?Math.floor(Date.parse(n.sent_at)/1000):null}))
  };
}
