-- RepReady hosted pre-flight: read-only checks to run before any clark-changes migration is pushed
-- to the hosted project.
--
-- DO NOT RUN AGAINST PRODUCTION WITHOUT THE OWNER.
--
-- Every statement below is a SELECT inside one read-only transaction that ends in ROLLBACK, so the
-- script cannot change data or schema. Counts in section 6 run through query_to_xml so that only
-- tables that actually exist are queried.
--
-- How to run (owner only):
--   psql "<hosted connection string>" -f scripts/hosted-preflight.sql   prints every section.
--   The Supabase SQL editor shows only one result set per run. Highlight a single section's SELECT
--   and run the selection, one section at a time.
--
-- What each section answers:
--   1. Migration history: which migration versions (and names) has the hosted project recorded?
--   2. Tables: which of ff_profiles, ff_registrations, ff_checkouts, ff_paymongo_attempts and
--      ff_checkins exist? ff_checkouts belongs to the clark-changes PayMongo design and
--      ff_paymongo_attempts to main's.
--   3. Daily check-in column: does ff_checkins.checkin_date exist yet (migration 20261009120000)?
--   4. Staff role: what is the ff_profiles role check constraint, and does it allow 'staff'
--      (migration 20260921084500)?
--   5. Same-day duplicate check-ins: members checked in more than once on one Manila day. Any row
--      here makes migration 20261009120000 fail on its unique constraint and roll back, so the owner
--      must decide what to do with these rows first. This script deletes nothing.
--   6. Row counts: rows per ff_ table (6a), and per workspace for ff_ tables that have a workspace
--      column (6b).

begin;
set transaction read only;

-- 1. Migration history recorded on this project. Reading name through to_jsonb keeps this working if an
--    older CLI created the table without a name column. If this section errors, the project has no CLI
--    migration history at all; run the remaining sections individually.
select version, to_jsonb(m) ->> 'name' as name
from supabase_migrations.schema_migrations as m
order by version;

-- 2. Which RepReady tables exist.
select t.table_name, to_regclass('public.' || t.table_name) is not null as table_exists
from unnest(array['ff_profiles', 'ff_registrations', 'ff_checkouts', 'ff_paymongo_attempts', 'ff_checkins']) as t(table_name);

-- 3. Whether ff_checkins.checkin_date exists.
select exists(
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'ff_checkins' and column_name = 'checkin_date'
) as checkin_date_exists;

-- 4. The ff_profiles role check constraint, and whether it allows staff.
select conname, pg_get_constraintdef(oid) as definition, pg_get_constraintdef(oid) like '%''staff''%' as allows_staff
from pg_constraint
where conrelid = to_regclass('public.ff_profiles') and contype = 'c' and pg_get_constraintdef(oid) like '%role%';

-- 5. Same-day duplicate check-ins by workspace, member and Manila date (query from the Batch 01 report).
select workspace, member_id, (created_at at time zone 'Asia/Manila')::date as manila_day, count(*)
from public.ff_checkins group by 1, 2, 3 having count(*) > 1;

-- 6a. Row count per ff_ table.
select table_name,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint as row_count
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'ff\_%'
order by table_name;

-- 6b. Row count per workspace, for ff_ tables with a workspace column.
select c.table_name, x.workspace, x.row_count
from information_schema.columns c
cross join lateral xmltable('/table/row'
  passing query_to_xml(format('select workspace, count(*) as n from public.%I group by workspace', c.table_name), false, false, '')
  columns workspace text path 'workspace', row_count bigint path 'n') as x
where c.table_schema = 'public' and c.table_name like 'ff\_%' and c.column_name = 'workspace'
order by c.table_name, x.workspace;

rollback;
