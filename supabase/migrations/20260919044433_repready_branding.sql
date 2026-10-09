-- Change only inspected human-readable notification subjects in existing functions.
-- Keep function names, signatures, permissions, QR token formats, and historical records.
do $migration$
declare fn regprocedure; definition text;
begin
  foreach fn in array array[
    'ff_private.new_membership(text,uuid,text,date)'::regprocedure,
    'public.ff_command(text,jsonb)'::regprocedure
  ] loop
    select pg_get_functiondef(fn) into definition;
    execute replace(definition, 'FORM Fitness', 'RepReady');
  end loop;
end $migration$;
