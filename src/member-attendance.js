import {result} from './supabase.js';
import {fail} from './validation.js';
import {createAttendanceTracker,trackerPeriod,businessDate,shiftDay} from '../public/attendance-tracker.js';

// Each read is explicitly scoped to the stored authenticated owner and workspace; RLS is a second boundary.
async function ownerRows(client,table,columns,profile,configure=q=>q) {
  const rows=[];
  for(let offset=0;;offset+=1000) {
    const query=configure(client.from(table).select(columns).eq('member_id',profile.id).eq('workspace',profile.workspace));
    const page=result(await query.order('id').range(offset,offset+999));
    rows.push(...page);if(page.length<1000)return rows;
  }
}
export function paidCoverage(invoices,payments) {
  const coverage=[];let unconfirmedCoverage=false;
  for(const invoice of invoices) {
    if(!Number.isSafeInteger(invoice.amount_cents)||invoice.amount_cents<=0||invoice.paid_cents!==invoice.amount_cents)continue;
    let total=0,paidOn=null;
    for(const payment of payments.filter(p=>p.invoice_id===invoice.id).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))) {
      if(!Number.isSafeInteger(payment.amount_cents)||payment.amount_cents<=0)continue;
      total+=payment.amount_cents;if(total>=invoice.amount_cents){paidOn=businessDate(payment.created_at);break;}
    }
    if(!paidOn){unconfirmedCoverage=true;continue;}
    const cycle=invoice.membership;
    if(cycle)coverage.push({start:cycle.start_date>paidOn?cycle.start_date:paidOn,end:cycle.end_date});
  }
  return {coverage,unconfirmedCoverage};
}
export async function memberAttendance(client,profile,query,today) {
  if(profile.role!=='member'||profile.enabled!==true)fail('Sign in to your enabled member account to view your attendance.',403);
  if(Object.keys(query).some(key=>!['period','date'].includes(key)))fail('Send only the attendance period and date.');
  const period=query.period||'week',date=query.date||today;
  let range;try{range=trackerPeriod(period,date,today);}catch(error){fail(error.message);}
  const [events,schedules,invoices,payments]=await Promise.all([
    ownerRows(client,'ff_checkins','id,created_at',profile,q=>q.gte('created_at',range.from+'T00:00:00+08:00').lt('created_at',shiftDay(range.to,1)+'T00:00:00+08:00')),
    ownerRows(client,'ff_attendance_schedules','id,effective_from,available_days',profile,q=>q.lte('effective_from',range.to>today?range.to:shiftDay(today,1))),
    ownerRows(client,'ff_invoices','id,amount_cents,paid_cents,membership:ff_memberships(start_date,end_date)',profile),
    ownerRows(client,'ff_payments','id,invoice_id,amount_cents,created_at',profile)
  ]);
  return createAttendanceTracker({period,date,today,events:events.map(event=>({id:event.id,at:event.created_at})),
    schedules:schedules.map(schedule=>({effectiveFrom:schedule.effective_from,days:schedule.available_days})),...paidCoverage(invoices,payments)});
}
