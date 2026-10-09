-- Retires main's PayMongo design (ff_paymongo_attempts, from 20261001150133 and 20261001150813) in favour
-- of clark-changes' ff_checkouts flow: Option A in docs/BRANCH_RECONCILIATION.md. Nothing in the
-- application calls ff_paymongo_reserve or the 6-argument ff_paymongo_settle, and nothing writes
-- ff_paymongo_attempts.
--
-- Kept on purpose: the ff_paymongo_attempts table, its rows, SELECT and the ff_paymongo_read policy;
-- ff_payments.provider_payment_id, the ff_payment_recorder check and the nullable recorded_by (payments
-- that main settled have recorded_by null); and the ff_private.notify grant. The two functions are
-- revoked, not dropped. Historical rows are retained; never delete payment history.
--
-- Signatures are fully qualified, so clark-changes' public.ff_paymongo_settle(jsonb) overload keeps
-- EXECUTE for service_role.
revoke execute on function public.ff_paymongo_reserve(uuid,uuid,text,boolean,uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ff_paymongo_settle(uuid,text,text,integer,text,boolean) from public, anon, authenticated, service_role;
-- TRUNCATE is revoked too: it would erase the history as surely as DELETE.
revoke insert, update, delete, truncate on table public.ff_paymongo_attempts from public, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
