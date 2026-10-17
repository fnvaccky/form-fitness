// Pure calendar rules shared by the owner-only API and focused tests. No health inputs or writes.
export const ATTENDANCE_ZONE = 'Asia/Manila';
export const WEEKDAYS = ['mon','tue','wed','thu','fri','sat','sun'];
const DAY = 86400000;
export function realDay(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === value;
}
export const shiftDay = (value, count) => new Date(Date.parse(value+'T00:00:00Z')+count*DAY).toISOString().slice(0,10);
export const weekday = value => WEEKDAYS[(new Date(value+'T00:00:00Z').getUTCDay()+6)%7];
export function businessDate(timestamp) {
  const stamp = Date.parse(timestamp);
  return Number.isFinite(stamp) ? new Intl.DateTimeFormat('en-CA',{timeZone:ATTENDANCE_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(stamp) : null;
}
export function trackerPeriod(period, date, today) {
  if (!['week','month'].includes(period)) throw Error('Choose a week or month.');
  if (!realDay(today) || !realDay(date) || date > today) throw Error('Choose a real date no later than today.');
  if (period === 'week') {
    const from = shiftDay(date,-WEEKDAYS.indexOf(weekday(date)));
    return {period,from,to:shiftDay(from,6)};
  }
  const from = date.slice(0,7)+'-01';
  const next = new Date(from+'T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+1);
  return {period,from,to:shiftDay(next.toISOString().slice(0,10),-1)};
}
export function createAttendanceTracker({today,period='week',date=today,events=[],schedules=[],coverage=[],unconfirmedCoverage=false}) {
  const range = trackerPeriod(period,date,today);
  const known = schedules.filter(s => realDay(s.effectiveFrom) && Array.isArray(s.days) && s.days.length
    && new Set(s.days).size === s.days.length && s.days.every(day=>WEEKDAYS.includes(day))).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  const scheduleFor = day => known.findLast(s=>s.effectiveFrom<=day);
  const trackingStart = known[0]?.effectiveFrom || null;
  const validCoverage = coverage.filter(c=>realDay(c.start)&&realDay(c.end)&&c.start<=c.end);
  const ownEvents = events.map(event=>({...event,date:businessDate(event.at)}))
    .filter(event=>event.date && event.date>=range.from && event.date<=range.to && event.date<=today)
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const counts = new Map();for (const event of ownEvents) counts.set(event.date,(counts.get(event.date)||0)+1);
  const days = [];
  for (let day=range.from;day<=range.to;day=shiftDay(day,1)) {
    const schedule=scheduleFor(day),covered=validCoverage.some(c=>c.start<=day&&day<=c.end);
    const usual=!!schedule?.days.includes(weekday(day)),eventCount=counts.get(day)||0;
    const completed=day<today&&!!schedule&&covered&&usual;
    const status=eventCount?'attended':!schedule?'before-tracking':!covered?'outside-coverage':!usual?'rest':day>today?'future':day===today?'today':'usual-without-checkin';
    days.push({date:day,weekday:weekday(day),usual,covered,tracked:!!schedule,eventCount,attended:eventCount>0,completedPlanned:completed,status,today:day===today,future:day>today});
  }
  const completedPlanned=days.filter(day=>day.completedPlanned).length;
  const completedAttended=days.filter(day=>day.completedPlanned&&day.attended).length;
  const percentage=completedPlanned?Math.round(completedAttended/completedPlanned*1000)/10:null;
  return {...range,date,today,timeZone:ATTENDANCE_ZONE,trackingStart,usualDays:scheduleFor(today)?.days||[],
    pendingSchedule:known.find(s=>s.effectiveFrom>today)||null,unconfirmedCoverage,
    summary:{attendedDays:counts.size,events:ownEvents.length,completedPlanned,completedAttended,percentage,
      label:percentage===null?'Not enough history yet':completedAttended===completedPlanned?'Consistent':'Building consistency'},
    days,history:ownEvents.map(event=>({id:event.id,at:event.at,date:event.date}))};
}
