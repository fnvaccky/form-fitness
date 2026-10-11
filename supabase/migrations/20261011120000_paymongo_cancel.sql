-- Task 09 Part B: administrators cancel an unpaid PayMongo checkout so its invoice or registration can be
-- paid another way. The server re-reads the session from PayMongo, expires it there, and only then calls
-- 'expire'. It calls 'check' first, so the database decides who may cancel before PayMongo is contacted.
create function ff_private.paymongo_cancel(action text,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ff_checkouts; v_session text:=body->>'sessionId'; v_status integer;
begin
 if not ff_private.is_admin() then raise exception using errcode='42501',message='Administrator access is required.'; end if;
 if action is null or action not in ('check','expire') then raise exception 'Unknown cancel action.'; end if;
 select * into c from public.ff_checkouts where id=(body->>'id')::uuid and workspace=ff_private.workspace() for update;
 if not found or c.livemode then raise exception 'Checkout not found.'; end if;
 if c.status not in ('creating','pending','needs_review') then raise exception 'This checkout is already closed. Refresh the page.'; end if;
 if action='check' then return to_jsonb(c); end if;
 -- Only the checkout's own session: the bound one, or for a never-bound checkout the one saved at review.
 if v_session is null or v_session !~ '^cs_[a-zA-Z0-9]+$' then raise exception 'Invalid provider session.'; end if;
 if v_session is distinct from coalesce(c.session_id,c.review_details->>'sessionId') then raise exception 'Checkout is bound to another session.'; end if;
 if jsonb_typeof(body->'providerStatus') is distinct from 'number' or (body->>'providerStatus')::numeric not between 100 and 599
  or (body->>'providerStatus')::numeric<>trunc((body->>'providerStatus')::numeric) then raise exception 'PayMongo response status is required.'; end if;
 v_status:=(body->>'providerStatus')::integer;
 if body->>'via' is null or body->>'via' not in ('expire','already_expired') then raise exception 'Unknown cancel outcome.'; end if;
 update public.ff_checkouts set status='expired',session_id=coalesce(session_id,v_session),review_reason=null,
  review_log=review_log||jsonb_build_array(jsonb_build_object('action','cancel','by',auth.uid(),'at',now(),'sessionId',v_session,
   'providerStatus',v_status,'sessionStatus','expired','via',body->>'via'))
 where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
revoke all on function ff_private.paymongo_cancel(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function ff_private.paymongo_cancel(text,jsonb) to authenticated;
create function public.ff_paymongo_cancel(action text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ff_private.paymongo_cancel(action,body) $$;
revoke all on function public.ff_paymongo_cancel(text,jsonb) from public,anon,service_role;
grant execute on function public.ff_paymongo_cancel(text,jsonb) to authenticated;
NOTIFY pgrst, 'reload schema';
