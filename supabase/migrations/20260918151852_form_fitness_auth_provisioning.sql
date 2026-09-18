-- Auth administration can populate app_metadata after the initial INSERT.
-- Read the final row at transaction end, rather than the INSERT's stale NEW image.
create or replace function ff_private.register_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb; w text; r text; phone text; u auth.users;
begin
 select * into u from auth.users where id=new.id;
 d:=u.raw_user_meta_data;
 if coalesce(d->>'form_fitness','')<>'true' then return new; end if;
 w:=case when u.raw_app_meta_data->>'ff_workspace'='demo' then 'demo' else 'production' end;
 r:=case when u.raw_app_meta_data->>'ff_role'='admin' then 'admin' else 'member' end;
 phone:=regexp_replace(coalesce(d->>'phone',''),'[ ()-]','','g');
 if phone like '+63%' then phone:='0'||substring(phone from 4); end if;
 insert into public.ff_profiles(id,workspace,role,name,email,phone,goal)
 values(u.id,w,r,trim(d->>'name'),lower(u.email),phone,left(coalesce(d->>'goal','Improve fitness'),100));
 if r='member' then perform ff_private.new_membership(w,u.id,d->>'plan',(d->>'start')::date); end if;
 return new;
end $$;
drop trigger ff_auth_user_created on auth.users;
create constraint trigger ff_auth_user_created after insert on auth.users deferrable initially deferred
 for each row execute function ff_private.register_auth_user();

-- Correct only this migration's clearly labeled, unpaid demo fixtures.
-- Abort instead of touching a matching account that acquired real financial records.
do $$ begin
 if exists(select 1 from public.ff_payments p join auth.users u on u.id=p.member_id where u.raw_app_meta_data->>'ff_seed'='form-fitness' and p.workspace='production') then
   raise exception 'Demo repair requires manual review: payments exist.';
 end if;
end $$;
do $$ declare c record; begin
 for c in select conrelid::regclass as tbl,conname from pg_constraint where contype='f' and connamespace='public'::regnamespace and conrelid::regclass::text like 'ff_%' loop
   execute format('alter table %s alter constraint %I deferrable initially immediate',c.tbl,c.conname);
 end loop;
end $$;
set constraints all deferred;
-- Remove only the erroneously created UNPAID sample admin cycle, not user records.
delete from public.ff_invoices i using auth.users u where i.member_id=u.id and u.email='form-fitness-demo-admin@example.invalid' and u.raw_app_meta_data->>'ff_seed'='form-fitness' and i.paid_cents=0;
delete from public.ff_memberships m using auth.users u where m.member_id=u.id and u.email='form-fitness-demo-admin@example.invalid' and u.raw_app_meta_data->>'ff_seed'='form-fitness';
update public.ff_profiles p set workspace='demo',role=case when u.raw_app_meta_data->>'ff_role'='admin' then 'admin' else 'member' end from auth.users u where p.id=u.id and u.raw_app_meta_data->>'ff_seed'='form-fitness' and u.raw_app_meta_data->>'ff_workspace'='demo' and u.email like 'form-fitness-demo-%@example.invalid';
update public.ff_memberships m set workspace='demo' from public.ff_profiles p where m.member_id=p.id and p.workspace='demo' and m.workspace='production';
update public.ff_invoices i set workspace='demo' from public.ff_profiles p where i.member_id=p.id and p.workspace='demo' and i.workspace='production';
update public.ff_notifications n set workspace='demo',status='suppressed' from public.ff_profiles p where n.member_id=p.id and p.workspace='demo' and n.workspace='production';
set constraints all immediate;
create index ff_invoices_membership_fk on public.ff_invoices(workspace,membership_id);
alter table public.ff_plans add constraint ff_plan_name_safe check(name !~ '[<>\r\n]');
