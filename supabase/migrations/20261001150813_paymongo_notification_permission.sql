-- Settlement runs as service_role, not the database owner.
grant execute on function ff_private.notify(text,uuid,text,text,text) to service_role;
