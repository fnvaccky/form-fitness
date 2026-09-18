alter function public.ff_public_plans() security invoker;
grant select on public.ff_plans to anon;
create policy ff_public_available_plans on public.ff_plans for select to anon using(workspace='production' and available);
-- Keys are deliberately inaccessible to clients even in a non-exposed schema.
create policy ff_secret_deny on ff_private.secrets for all to authenticated using(false) with check(false);
create index ff_memberships_plan_fk on public.ff_memberships(workspace,plan_id);
create index ff_submissions_invoice_fk on public.ff_submissions(workspace,invoice_id,member_id);
create index ff_submissions_reviewer_fk on public.ff_submissions(reviewed_by);
create index ff_payments_invoice_fk on public.ff_payments(workspace,invoice_id,member_id);
create index ff_payments_recorded_by_fk on public.ff_payments(recorded_by);
create index ff_checkins_membership_fk on public.ff_checkins(membership_id);
create index ff_checkins_staff_fk on public.ff_checkins(confirmed_by);
create index ff_notifications_member_fk on public.ff_notifications(member_id);
