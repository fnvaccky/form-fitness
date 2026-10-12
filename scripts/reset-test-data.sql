-- RepReady: reset test data (production workspace)
--
-- Deletes ALL member data in the production workspace, so testing can start again from a clean
-- database. IT CANNOT BE UNDONE.
--
-- Keeps: administrator and staff profiles and their Auth users, ff_plans, ff_settings, ff_staff_audit,
-- ff_account_cleanup_log (append-only), ff_paymongo_attempts and the migration history.
-- Deletes: every member profile and its Auth user, and all check-ins, payments, payment submissions,
-- online checkouts, invoices, membership cycles, first registrations and member notifications.
--
-- Member photo and receipt files stay in the form-fitness-private bucket, because SQL can't delete
-- storage objects. Nothing points to them any more, so they're harmless. `npm run reset:test-data`
-- (on the developer's machine) does the full version: backup, PayMongo expiry and the storage clean-up.
--
-- How to use it in the Supabase SQL Editor:
-- 1. Select PART 1 and run it. It only reads: it lists what would be deleted and who stays.
-- 2. If PART 1 lists an open online checkout, cancel it in the app first: Payments → Online payments
--    in progress → Cancel checkout. PART 2 refuses while any checkout is creating, pending or
--    needs_review, because a member could still pay on it.
-- 3. In PART 2, replace  type DELETE ALL MEMBERS here  with  DELETE ALL MEMBERS, then select PART 2
--    and run it. It is one transaction: if anything fails, nothing is deleted. It also refuses unless
--    it is clearing the production workspace.

-- ===== PART 1: preview (read-only) =====
with ws as (select 'production'::text as name),
members as (select p.id, p.email, p.name, p.created_at from public.ff_profiles p join ws on p.workspace = ws.name where p.role = 'member'),
preview(position, section, item, detail) as (
  select 11, 'Will delete', 'ff_profiles (members)', count(*)::text from members
  union all select 12, 'Will delete', 'auth.users (members)', count(*)::text from auth.users where id in (select id from members)
  union all select 13, 'Will delete', 'ff_checkins', count(*)::text from public.ff_checkins t join ws on t.workspace = ws.name
  union all select 14, 'Will delete', 'ff_payments', count(*)::text from public.ff_payments t join ws on t.workspace = ws.name
  union all select 15, 'Will delete', 'ff_submissions', count(*)::text from public.ff_submissions t join ws on t.workspace = ws.name
  union all select 16, 'Will delete', 'ff_checkouts', count(*)::text from public.ff_checkouts t join ws on t.workspace = ws.name
  union all select 17, 'Will delete', 'ff_notifications (members)', count(*)::text from public.ff_notifications t join ws on t.workspace = ws.name
    where t.member_id is null or t.member_id in (select id from members)
  union all select 18, 'Will delete', 'ff_invoices', count(*)::text from public.ff_invoices t join ws on t.workspace = ws.name
  union all select 19, 'Will delete', 'ff_memberships', count(*)::text from public.ff_memberships t join ws on t.workspace = ws.name
  union all select 20, 'Will delete', 'ff_registrations', count(*)::text from public.ff_registrations t join ws on t.workspace = ws.name
  union all select 30, 'Member account (deleted)', m.email, coalesce(m.name, '') || ' · created ' || to_char(m.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') from members m
  union all select 40, 'Stays: ' || p.role, p.email, case when p.enabled then 'enabled' else 'disabled' end
    from public.ff_profiles p join ws on p.workspace = ws.name where p.role in ('admin', 'staff')
  union all select 50, 'Open checkout: cancel it first', c.id::text, c.status || ' · PHP ' || to_char(c.amount_cents / 100.0, 'FM999990.00')
    from public.ff_checkouts c join ws on c.workspace = ws.name where c.status in ('creating', 'pending', 'needs_review')
  union all select 61, 'Keeps', 'ff_plans', count(*)::text from public.ff_plans t join ws on t.workspace = ws.name
  union all select 62, 'Keeps', 'ff_settings', count(*)::text from public.ff_settings t join ws on t.workspace = ws.name
  union all select 63, 'Keeps', 'ff_staff_audit', count(*)::text from public.ff_staff_audit t join ws on t.workspace = ws.name
  union all select 64, 'Keeps', 'ff_account_cleanup_log', count(*)::text from public.ff_account_cleanup_log t join ws on t.workspace = ws.name
  union all select 65, 'Keeps', 'ff_paymongo_attempts', count(*)::text from public.ff_paymongo_attempts t join ws on t.workspace = ws.name
)
select section, item, detail from preview order by position, item;

-- ===== PART 2: delete (one transaction) =====
do $$
declare
  confirm constant text := 'type DELETE ALL MEMBERS here';
  ws constant text := 'production';
  closed constant jsonb := '[]';
  -- (npm run reset:test-data fills in "closed" with the open checkouts it has just closed at PayMongo.)
  members uuid[];
  k bigint;
begin
  if confirm is distinct from 'DELETE ALL MEMBERS' then
    raise exception 'Nothing was deleted: type DELETE ALL MEMBERS in the confirm line of PART 2 first.';
  end if;
  if ws is distinct from 'production' then
    raise exception 'Nothing was deleted: this reset only clears the production workspace.';
  end if;
  if not exists (select 1 from public.ff_profiles where workspace = ws and role = 'admin' and enabled) then
    raise exception 'Nothing was deleted: there is no enabled administrator in the production workspace, so this does not look like the RepReady database.';
  end if;
  if exists (select 1 from public.ff_checkouts where workspace = ws and status in ('creating', 'pending', 'needs_review') and not (closed ? id::text)) then
    raise exception 'Nothing was deleted: an online checkout is still open. Cancel it first in Payments → Online payments in progress → Cancel checkout.';
  end if;
  select coalesce(array_agg(id), '{}') into members from public.ff_profiles where workspace = ws and role = 'member';
  if exists (select 1 from public.ff_staff_audit where actor_id = any (members) or target_id = any (members)) then
    raise exception 'Nothing was deleted: a member account appears in the staff audit log, which is kept.';
  end if;

  create temp table if not exists reset_deleted (position int, table_name text, rows_deleted bigint);
  truncate reset_deleted;
  -- Foreign-key order: rows that point to others go first.
  delete from public.ff_checkins where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (1, 'ff_checkins', k);
  delete from public.ff_payments where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (2, 'ff_payments', k);
  delete from public.ff_submissions where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (3, 'ff_submissions', k);
  delete from public.ff_checkouts where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (4, 'ff_checkouts', k);
  -- Member notifications, including ones already detached from an account deleted earlier (no member).
  delete from public.ff_notifications where workspace = ws and (member_id is null or member_id = any (members));
  get diagnostics k = row_count; insert into reset_deleted values (5, 'ff_notifications', k);
  delete from public.ff_invoices where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (6, 'ff_invoices', k);
  delete from public.ff_memberships where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (7, 'ff_memberships', k);
  delete from public.ff_registrations where workspace = ws; get diagnostics k = row_count; insert into reset_deleted values (8, 'ff_registrations', k);
  delete from public.ff_profiles where workspace = ws and role = 'member'; get diagnostics k = row_count; insert into reset_deleted values (9, 'ff_profiles (members)', k);
  delete from auth.users where id = any (members); get diagnostics k = row_count; insert into reset_deleted values (10, 'auth.users (members)', k);
end $$;
select table_name as deleted_from, rows_deleted from reset_deleted order by position;
