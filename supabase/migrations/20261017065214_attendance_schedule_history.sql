-- Attendance consistency uses the usual weekdays known on each date, never a later survey edit.
-- Existing surveys establish a baseline on this migration's Manila date only. No earlier schedule
-- or attendance is inferred. A member's first saved schedule starts today; later changes start tomorrow.
-- This trigger also covers surveys entered at the desk and any future authorized survey update path.
-- Existing survey permissions, shared commands, check-ins, memberships and payments are unchanged.

create function ff_private.attendance_weekdays(days text[]) returns text[]
language sql immutable set search_path='' as $$
 select array(select day from unnest(array['mon','tue','wed','thu','fri','sat','sun']::text[])
  with ordinality as d(day,ord) where day=any(days) order by ord)
$$;

create table public.ff_attendance_schedules (
 id uuid primary key default gen_random_uuid(),
 workspace text not null,
 member_id uuid not null,
 effective_from date not null,
 available_days text[] not null check (
  cardinality(available_days) between 1 and 7
  and array_position(available_days,null) is null
  and available_days=ff_private.attendance_weekdays(available_days)
 ),
 recorded_at timestamptz not null default now(),
 foreign key (workspace,member_id) references public.ff_profiles(workspace,id) on delete cascade,
 unique (workspace,member_id,effective_from)
);
alter table public.ff_attendance_schedules enable row level security;
revoke all on public.ff_attendance_schedules from public,anon,authenticated,service_role;
grant select on public.ff_attendance_schedules to authenticated;
create policy ff_attendance_schedule_owner_read on public.ff_attendance_schedules for select to authenticated
 using (workspace=(select ff_private.workspace()) and member_id=(select auth.uid())
  and (select (ff_private.actor()).role)='member');

-- The currently saved weekday set is known from launch onward, not from its old updated_at date.
insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days)
 select s.workspace,s.id,ff_private.today(),ff_private.attendance_weekdays(s.available_days)
 from public.ff_member_surveys s join public.ff_profiles p on p.workspace=s.workspace and p.id=s.id
 where p.role='member';

create function ff_private.capture_attendance_schedule() returns trigger
language plpgsql security definer set search_path='' as $$
declare days text[]:=ff_private.attendance_weekdays(new.available_days); starts date;
begin
 if tg_op='UPDATE' and days=ff_private.attendance_weekdays(old.available_days) then return new; end if;
 if not exists(select 1 from public.ff_profiles p where p.workspace=new.workspace and p.id=new.id and p.role='member') then return new; end if;
 starts:=case when exists(select 1 from public.ff_attendance_schedules s where s.workspace=new.workspace and s.member_id=new.id)
  then ff_private.today()+1 else ff_private.today() end;
 -- Multiple edits before tomorrow replace only that pending date; today's and completed rows stay intact.
 insert into public.ff_attendance_schedules(workspace,member_id,effective_from,available_days)
  values(new.workspace,new.id,starts,days)
 on conflict(workspace,member_id,effective_from) do update set available_days=excluded.available_days,recorded_at=now();
 return new;
end $$;
create trigger ff_member_survey_attendance_schedule after insert or update of available_days on public.ff_member_surveys
 for each row execute function ff_private.capture_attendance_schedule();

revoke all on function ff_private.attendance_weekdays(text[]) from public,anon,authenticated,service_role;
revoke all on function ff_private.capture_attendance_schedule() from public,anon,authenticated,service_role;
notify pgrst, 'reload schema';
