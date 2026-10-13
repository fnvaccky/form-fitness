-- BUG-016 follow-up: a check-in is confirmed on the member's pass in the app (Task 13A), so it no longer queues an
-- email. Nothing on live sends queued email today; if a sender were configured, every queued check-in email would go
-- out at once, and each new check-in would use up the email quota.
--
-- 1. ff_private.notify skips check-in events: a check-in writes no notification row. Every other notification is
--    unchanged. The body is the original one (20260918150113_form_fitness_core.sql) plus the one condition.
-- 2. Check-in emails already waiting in the queue are marked 'suppressed'. Every row is kept.

create or replace function ff_private.notify(w text, m uuid, subject text, body text, event text) returns void
language sql security definer set search_path='' as $$
 insert into public.ff_notifications(workspace,member_id,recipient,subject,body,event_key,status)
 select w,m,p.email,subject,body,event,case when w='demo' then 'suppressed' else 'queued' end
 from public.ff_profiles p where p.id=m and p.workspace=w
  and event not like 'checkin:%' -- BUG-016: check-ins are confirmed in the app, not by email
 on conflict(event_key) do nothing
$$;
-- create or replace keeps the existing ACL; restated so this migration's privileges are explicit.
revoke all on function ff_private.notify(text,uuid,text,text,text) from public, anon, authenticated;

update public.ff_notifications set status='suppressed' where event_key like 'checkin:%' and status='queued';
