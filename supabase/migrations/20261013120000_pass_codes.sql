-- Task 13B: a short manual pass code, for when the camera can't read the member's QR.
--
-- The member's pass shows an 8-character Crockford base32 code (no I, L, O or U) under the QR, as XXXX-XXXX.
-- It is the same pass: it shares the QR's nonce and 90-second life. A staff lookup of the code rebuilds the QR's
-- own signed token, so the scan and check-in that follow are exactly the QR's, unchanged. A check-in by either
-- records the pass nonce, which uses up both.
--
-- Only a keyed hash of the code is stored. Members can't read the table; it is written only by these
-- security-definer functions. Wrong codes are limited to 10 per staff account in 5 minutes. Code rows and attempt
-- records are removed a day after they expire: they are pass data, not payment or check-in history.

create table public.ff_pass_codes (
 id uuid primary key default gen_random_uuid(),
 workspace text not null,
 member_id uuid not null,
 code_hash text not null,
 nonce uuid not null unique,
 expires_at timestamptz not null,
 used_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (workspace,member_id) references public.ff_profiles(workspace,id) on delete cascade,
 unique (workspace,code_hash)
);
create index ff_pass_codes_expiry on public.ff_pass_codes(expires_at);

create table public.ff_pass_code_attempts (
 id bigint generated always as identity primary key,
 workspace text not null,
 staff_id uuid not null,
 attempted_at timestamptz not null default now(),
 foreign key (workspace,staff_id) references public.ff_profiles(workspace,id) on delete cascade
);
create index ff_pass_code_attempts_recent on public.ff_pass_code_attempts(staff_id,attempted_at);

-- No policies: nobody reads or writes these tables directly.
alter table public.ff_pass_codes enable row level security;
alter table public.ff_pass_code_attempts enable row level security;
revoke all on public.ff_pass_codes, public.ff_pass_code_attempts from public, anon, authenticated;

-- A typed code: any case, dashes and spaces dropped, and Crockford's O read as 0, I and L as 1.
create function ff_private.pass_code_normal(raw text) returns text
language sql immutable set search_path='' as $$
 select translate(upper(regexp_replace(coalesce(raw,''),'[[:space:]-]','','g')),'OIL','011')
$$;

-- The stored form: an HMAC with the pass secret, per workspace. Without the secret a stolen hash can't be reversed.
create function ff_private.pass_code_hash(w text, code text) returns text
language sql stable security definer set search_path='' as $$
 select encode(extensions.hmac(w||':'||code,(select value from ff_private.secrets where name='qr'),'sha256'),'hex')
$$;

create function ff_private.pass_code(action text, body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.ff_profiles; r public.ff_pass_codes; key text; token text; payload text; claims jsonb;
 expiry bigint; pass_nonce uuid; bytes bytea; code text; item_id uuid;
 alphabet constant text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
begin
 a:=ff_private.actor();
 if a.id is null then raise exception 'Please sign in to continue.' using errcode='42501'; end if;
 select value into key from ff_private.secrets where name='qr';

 if action='issue' then
  -- The member's own fresh pass, exactly as ff_command('qr') issued it.
  if a.role<>'member' then raise exception 'Sign in as a member.' using errcode='42501'; end if;
  token:=body->>'token';
  if token is null or length(token)>1000 or split_part(token,'.',1)<>'FORM2' or array_length(string_to_array(token,'.'),1)<>3 then raise exception 'Invalid member pass.'; end if;
  payload:=split_part(token,'.',2);
  if encode(extensions.hmac(payload,key,'sha256'),'hex')<>split_part(token,'.',3) then raise exception 'Invalid member pass signature.'; end if;
  claims:=convert_from(decode(payload,'base64'),'UTF8')::jsonb;
  if claims->>'memberId' is distinct from a.id::text or claims->>'workspace' is distinct from a.workspace then raise exception 'This pass belongs to another member.'; end if;
  expiry:=(claims->>'exp')::bigint; pass_nonce:=(claims->>'nonce')::uuid;
  if expiry<=extract(epoch from now())::bigint or expiry>extract(epoch from now())::bigint+95 then raise exception 'This pass has expired. Refresh it to get a new one.'; end if;
  -- Housekeeping: code rows and attempt records go a day after they expire.
  delete from public.ff_pass_codes where expires_at<now()-interval '1 day';
  delete from public.ff_pass_code_attempts where attempted_at<now()-interval '1 day';
  for attempt in 1..5 loop
   bytes:=extensions.gen_random_bytes(8);code:='';
   for i in 0..7 loop code:=code||substr(alphabet,get_byte(bytes,i)%32+1,1); end loop;
   insert into public.ff_pass_codes(workspace,member_id,code_hash,nonce,expires_at)
    values(a.workspace,a.id,ff_private.pass_code_hash(a.workspace,code),pass_nonce,to_timestamp(expiry))
    on conflict do nothing returning id into item_id;
   exit when item_id is not null;
   if exists(select 1 from public.ff_pass_codes where nonce=pass_nonce) then raise exception 'This pass already has a code.'; end if;
   -- Otherwise the code collided with a stored one in this workspace: draw another.
  end loop;
  if item_id is null then raise exception 'The pass code could not be made. Refresh the pass.'; end if;
  return jsonb_build_object('code',left(code,4)||'-'||right(code,4),'expires',expiry);
 end if;

 if action='lookup' then
  -- Refusals are returned, not raised, so that a wrong attempt stays recorded.
  if a.role not in ('admin','staff') then raise exception 'Gym staff access is required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ff_pass_code:'||a.id::text,0));
  if (select count(*) from public.ff_pass_code_attempts where staff_id=a.id and attempted_at>now()-interval '5 minutes')>=10 then
   return jsonb_build_object('error','Too many attempts — wait a few minutes.','status',429);
  end if;
  code:=ff_private.pass_code_normal(body->>'code');
  if code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then return jsonb_build_object('error','Enter the 8-character pass code, for example 7KQ2-M9XD.','status',400); end if;
  select * into r from public.ff_pass_codes where workspace=a.workspace and code_hash=ff_private.pass_code_hash(a.workspace,code);
  if not found then
   insert into public.ff_pass_code_attempts(workspace,staff_id) values(a.workspace,a.id);
   return jsonb_build_object('error','Pass code not recognised. Check it with the member.','status',400);
  end if;
  if r.used_at is not null or exists(select 1 from public.ff_checkins where nonce=r.nonce) then return jsonb_build_object('error','This pass code was already used.','status',400); end if;
  if r.expires_at<=now() then return jsonb_build_object('error','Code expired — ask the member to refresh their pass.','status',400); end if;
  -- The member's own signed pass, as in their QR: the scan and check-in that follow are unchanged.
  payload:=replace(encode(convert_to(jsonb_build_object('memberId',r.member_id,'workspace',r.workspace,'exp',extract(epoch from r.expires_at)::bigint,'nonce',r.nonce)::text,'UTF8'),'base64'),E'\n','');
  return jsonb_build_object('token','FORM2.'||payload||'.'||encode(extensions.hmac(payload,key,'sha256'),'hex'));
 end if;

 raise exception 'Unknown pass code action.';
end $$;

create function public.ff_pass_code(action text, body jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select ff_private.pass_code(action,body) $$;

-- A check-in by QR or by code records the pass nonce; mark the pass's code used.
create function ff_private.pass_code_used() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update public.ff_pass_codes set used_at=now() where nonce=new.nonce and used_at is null;
 return null;
end $$;
create trigger ff_checkins_pass_code_used after insert on public.ff_checkins for each row execute function ff_private.pass_code_used();

revoke all on function ff_private.pass_code_normal(text), ff_private.pass_code_hash(text,text), ff_private.pass_code(text,jsonb), ff_private.pass_code_used() from public, anon, authenticated;
grant execute on function ff_private.pass_code(text,jsonb) to authenticated;
revoke all on function public.ff_pass_code(text,jsonb) from public, anon;
grant execute on function public.ff_pass_code(text,jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
