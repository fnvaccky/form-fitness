# Branch reconciliation: `origin/main` and `clark-changes`

Prepared 10 October 2026 as a read-only analysis. Nothing was merged, rebased or pushed to `main`, and nothing was run against the hosted project. Paths without a prefix are files on `clark-changes`. Paths prefixed `main:` are files on `origin/main` at `939fe99`.

## The decision

The two branches split at `ac65ea2`, and each then built its own PayMongo integration. Both use the same webhook URL and the same file names, so they can't both stay. The owner has to pick one design before the branches are merged.

At a glance:

- **`main`** (3 commits, 12 files) adds a small checkout for members only. It supports GCash and QR Ph, and includes a path to live payments.
- **`clark-changes`** (8 commits) adds:
  - staff accounts, paid-first registration and walk-in renewals;
  - a test-mode-only checkout for GCash, Maya, GrabPay and card, with reconciliation tools;
  - the one-check-in-per-day rule and several fixes.
- **Merge conflicts:** a dry-run merge has 3 conflicting files. Three more files merge cleanly as text, but the result would not run (section 2).
- **Databases:** the two designs don't collide. In a throwaway rehearsal, clark-changes' migrations applied cleanly on top of main's (section 2).
- **Hosted project (per docs, unverified):** it already has main's PayMongo migrations, and the hosted app was running main's code when it was probed on 2 October (section 4).

## 1. Commits on each side since `ac65ea2`

`git log --oneline ac65ea2..origin/main`. All three are by fnvaccky, 29 September to 1 October 2026. The delete and restore cancel out, so only `939fe99` changes the app.

```
939fe99 Add PayMongo GCash and QR Ph checkout with verified settlement and setup guide
feb4177 Restore CODEX_VERCEL_SUPABASE_PROMPT.md
56c440f Delete CODEX_VERCEL_SUPABASE_PROMPT.md
```

`git log --oneline ac65ea2..clark-changes`. All eight are by Clxrk, 20 September to 10 October 2026. The list was captured before this document's own commit.

```
38bc773 Add read-only hosted pre-flight script
c1d5ee6 Reset PayMongo in-flight state on return and mark the submitting form
4ccd6df Record Batch 01 verification results in TEST_RESULTS.md
54694d2 Remove owner-login dead code and classroom demo wording
ddbe73c Limit check-ins to one per member per Manila day
adaab3f Redirect to PayMongo checkout directly and guard against double submission
c550f1c Fix RepReady PayMongo test checkout and verification flow
3848643 Verify Supabase Auth email links by token_hash for cross-device confirmation
```

`c550f1c` is the large commit. It adds five migrations: the staff role, paid-first registration and three for the PayMongo checkout.

## 2. Conflict dry run

I ran `git merge-tree --write-tree --name-only origin/main clark-changes` with Git 2.54. It writes only unreferenced Git objects; no branch, index or working file changed. It exited with status 1, meaning there are conflicts.

### Conflicting files

| File | Conflict | Cause |
| --- | --- | --- |
| `package.json` | content | Both branches changed the `test` script. `main` adds `tests/paymongo.test.js`; `clark-changes` adds `tests/paymongo-unit.test.js`. |
| `public/paymongo.js` | add/add | Each branch created its own browser PayMongo module. |
| `src/paymongo.js` | add/add | Each branch created its own server PayMongo module, with different exports. |

### Merged cleanly as text, but broken

These problems were read from the dry-run result tree, `81444b1`.

| File | Problem in the auto-merged version |
| --- | --- |
| `src/api.js` | **The whole API would fail to load.** Two `import … from './paymongo.js'` lines both bind `createCheckout`, which is a SyntaxError. The file also gets duplicate `/paymongo/webhook` and `/paymongo/checkout` handlers with different signatures; only the first of each would ever run. |
| `public/index.html` | `/paymongo.js` loads twice, once before `connected.js` and once after. The second load throws on the duplicate top-level `let`. |
| `.env.example` | `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` and `PAYMONGO_ALLOW_LIVE` each appear twice, with conflicting comments about which workspace test keys may use. |

`api/index.js` also merges cleanly: `main` adds `bodyParser:false`. That is probably harmless, because `clark-changes` reads raw request bodies itself and sends webhooks to `api/paymongo-webhook.js`. It still needs re-testing after any merge.

### Added on one side only

These files don't conflict as text, but each one depends on its own branch's design. `main` adds:

- `PAYMONGO_SETUP.md`
- `supabase/migrations/20261001150133_paymongo_checkout.sql`
- `supabase/migrations/20261001150813_paymongo_notification_permission.sql`
- `tests/paymongo.sql`
- `tests/paymongo.test.js`

`main`'s tests import `paymentConfig`, `verifySignature`, `paidEvent` and `checkoutURL` from `src/paymongo.js`. `clark-changes`' module has no `paymentConfig`, `paidEvent` or `checkoutURL`, and its `verifySignature` takes `(raw, header, env)`.

### Database rehearsal

This ran locally on a throwaway shadow database. I replayed migrations in the order the hosted project would see them:

1. the three core migrations
2. `main`'s two PayMongo migrations
3. `clark-changes`' six migrations. The staff-role migration `20260921084500` was renamed so it runs after `main`'s, which is what `supabase db push --include-all` would do on hosted.

All 11 applied without error.

I then compared the result with `clark-changes`' own schema using `supabase db diff` (engine pg-delta, schemas `public` and `ff_private`). The only difference is `main`'s footprint:

- the table `ff_paymongo_attempts` and its policy `ff_paymongo_read`
- the functions `public.ff_paymongo_reserve(uuid,uuid,text,boolean,uuid)` and `public.ff_paymongo_settle(uuid,text,text,integer,text,boolean)`
- the column `ff_payments.provider_payment_id` (unique), the constraint `ff_payment_recorder`, and `ff_payments.recorded_by` made nullable
- `EXECUTE` on `ff_private.notify(text,uuid,text,text,text)` granted to `service_role`

So the two schemas can coexist without name collisions. `clark-changes`' `ff_paymongo_settle(jsonb)` is a separate overload of the same function name, and all of its grants name the `(jsonb)` signature, so nothing is ambiguous.

## 3. PayMongo design comparison

| Aspect | `main` | `clark-changes` |
| --- | --- | --- |
| **Tables** | `ff_paymongo_attempts`: invoice checkouts only. Statuses `pending`, `paid`, `review`, `closed`. One open attempt per invoice. Also adds `ff_payments.provider_payment_id` and makes `recorded_by` nullable. Source: `main:supabase/migrations/20261001150133_paymongo_checkout.sql`. | `ff_checkouts`: registrations, renewals and invoices. Statuses `creating`, `pending`, `paid`, `failed`, `needs_review`, `expired`. One open checkout per invoice or registration, plus review reason, details and log columns. Sources: `supabase/migrations/20261001201100_paymongo_checkout.sql`, `20261001213203_paymongo_demo_hardening.sql`. Depends on `ff_registrations` from `20261001184643_paid_first_registration.sql`. |
| **Migrations** | Two: `main:supabase/migrations/20261001150133_paymongo_checkout.sql` and `main:supabase/migrations/20261001150813_paymongo_notification_permission.sql`. | Three PayMongo migrations: `20261001201100`, `20261001213203`, `20261002033541`. Prerequisites: `20260921084500` (staff role) and `20261001184643` (paid-first). `20261009120000` (daily check-in limit) is unrelated to PayMongo. |
| **Methods** | GCash and QR Ph: `payment_method_types:['gcash','qrph']` in `main:src/paymongo.js`, and settle accepts only `gcash` or `qrph`. QR Ph payments are recorded with the method "Bank transfer". | GCash, Maya, GrabPay and card. Configurable with `PAYMONGO_METHODS` (`src/paymongo-config.js`). Enforced in the database by `ff_checkout_methods_allowlist` (`20261001213203`) and the widened `ff_payments_method_check` (`20261001201100`). No QR Ph. |
| **Live mode** | Supported, with explicit opt-in: a live key, plus `APP_WORKSPACE=production`, plus `PAYMONGO_ALLOW_LIVE=true` (`paymentConfig` in `main:src/paymongo.js`). Database check: `(live and workspace='production') or (not live and workspace='demo')`. | Forbidden by design. A live key, or `PAYMONGO_ALLOW_LIVE` set to anything but `false`, disables checkout (`src/paymongo-config.js`). Every provider resource must have `livemode:false` (`src/paymongo.js`). Database constraint `ff_checkout_test_only` (`20261002033541`). |
| **Workspace rules** | Test keys work only in `demo`; live keys only in `production`. Same sources as above. | Test mode works in either workspace (`20261002033541_paymongo_test_workspace.sql`). Each checkout must match `APP_WORKSPACE` (`testCheckout` in `src/paymongo.js`). |
| **Webhook route** | `POST /api/paymongo/webhook` is handled inside `main:src/api.js`, before the origin check. `main:api/index.js` turns off body parsing. | `vercel.json` rewrites `/api/paymongo/webhook` to a separate raw-stream function, `api/paymongo-webhook.js`, which calls `handleWebhook` in `src/paymongo.js`. |
| **Signature handling** | `paymongo-signature` header. Uses the `te` or `li` part depending on key mode. Timestamp within ±300 s. HMAC-SHA256 of `t.` plus the raw bytes, compared in constant time. 256 KB size cap. Failures return 400. Source: `verifySignature` and `receiveWebhook` in `main:src/paymongo.js`. | `paymongo-signature` header. Accepts only the `te` part and rejects any `li` part. Timestamp within ±300 s. HMAC-SHA256 of `t.` plus the raw bytes, compared in constant time. 1 MB size cap. Signature failures return 401. Source: `verifySignature` in `src/paymongo.js`. |
| **Settlement** | Webhook only. Exactly one paid payment per session, for exactly the attempt amount. Mismatches are kept as `review` without crediting the invoice (`ff_paymongo_settle` in `main`'s migration). Payment row: `recorded_by` null, `provider_payment_id` set, `reference_key 'paymongo:<id>'`. | By webhook or by a status check. Verifies session, reference, amount, currency, method and test mode (`validateSession` in `src/paymongo.js`), then settles through `ff_private.paymongo_settle` (`20261002033541`). Payment row: `recorded_by` is the checkout creator, `reference_key 'PAYMONGO:<id>'`. |
| **Reconciliation and recovery** | Reopening a payment reuses the existing attempt. A creation timeout leaves the attempt `pending`. There is no status-check or recovery endpoint. Closing an abandoned attempt is a manual database update by a "trusted server administrator" (`main:PAYMONGO_SETUP.md`). Users can view their attempts (`/paymongo/attempts` in `main:src/api.js`; history panel in `main:public/paymongo.js`). | `/paymongo/status` re-reads the provider session, then settles or expires it (`reconcileCheckout` in `src/paymongo.js`). `/paymongo/recover` lets an admin rebind a saved or entered session ID after full validation (`recoverCheckout`). Stale creation (over 120 s) and uncertain creation go to `needs_review`. Triggers block cash and manual payments while a checkout is open (`guard_open_checkout` in `20261001201100`). Returning from checkout triggers a status check (`public/paymongo.js`). |
| **Who can initiate** | Members only, for their own invoices (`createCheckout` requires `role==='member'` in `main:src/paymongo.js`; `ff_paymongo_reserve`). Admins can only read attempts, through the `ff_paymongo_read` policy. | Staff and admins can pay for a first registration, a walk-in renewal or any invoice. Members can pay only their own invoices (`ff_private.paymongo_prepare` in `20261002033541`; `canInitiatePaymongo` in `public/paymongo.js`). |
| **Tests** | 5 unit tests (`main:tests/paymongo.test.js`) and SQL checks with 11 `raise exception` assertions (`main:tests/paymongo.sql`). No browser test. | 11 unit tests (`tests/paymongo-unit.test.js`). 12 integration groups using a mock provider, local Supabase and headless Edge (`tests/paymongo.js`). 21 SQL checks (`tests/paymongo-demo.sql`). UI guard tests in `tests/unit.test.js`. |

## 4. Hosted state per docs (per docs, unverified)

Nothing below was checked against the hosted project.

- **Core migrations (per docs, unverified).** The docs both branches share say the three core migrations (`20260918150113`, `20260918150433`, `20260918151947`) were applied, and that `supabase db push --dry-run` showed nothing pending on 18 September. Sources: `DEPLOYMENT.md`, `MIGRATION_NOTES.md`, `TEST_RESULTS.md`.
- **`main`'s PayMongo migrations (per docs, unverified).** `main:PAYMONGO_SETUP.md` says both 1 October migrations, `20261001150133_paymongo_checkout` and `20261001150813_paymongo_notification_permission`, "have already been applied to the existing project `ivxbrhqqfgmhfpgpauzh`". It also says hosted PayMongo needs a separate `APP_WORKSPACE=demo` test deployment, and that production needs live keys plus `PAYMONGO_ALLOW_LIVE=true`.
- **Deployed code (per docs, unverified).** `TEST_RESULTS.md` records that on 2 October, `POST https://repready-gym.vercel.app/api/paymongo/webhook` answered `503 Payment webhook is not configured.`. That exact message exists only in `main:src/paymongo.js`, which suggests the hosted app was running `main`'s PayMongo code. The hosted schema, keys and workspace were not inspected.
- **What `clark-changes` still needs on hosted (per docs, unverified).** `clark-changes`' docs say its work never inspected or changed hosted (`PAYMONGO_DEMO_REPORT.md`, `TEST_RESULTS.md`). It needs six migrations there: `20260921084500` (staff role), `20261001184643` (paid-first), `20261001201100`, `20261001213203` and `20261002033541` (PayMongo), and `20261009120000` (daily check-in limit).
- **Migration history consequences (per docs, unverified).**
  - Hosted history would contain `main`'s two versions, which don't exist on `clark-changes`. `supabase db push` refuses to run until local and remote history agree.
  - The staff-role version is older than `main`'s, so pushing needs `--include-all`.
  - If hosted already has same-day duplicate check-ins, `20261009120000` fails on its unique constraint and rolls back.
- **How to verify.** `scripts/hosted-preflight.sql` checks every item above: history, tables, the `checkin_date` column, the role constraint, same-day duplicates, and row counts per table and workspace. The owner should run it, read-only, before any decision is carried out.

## 5. Options

### Option A: keep `clark-changes`' design and retire `main`'s

Steps, in order:

1. **Owner runs the pre-flight script on hosted.** Record which versions are in history, whether `ff_paymongo_attempts` has rows (especially `pending` or `review`), and whether any same-day duplicate check-ins exist.
2. **Reconcile open attempts while `main`'s code is still deployed.** If any `ff_paymongo_attempts` rows are `pending` or `review`, resolve them in PayMongo first: expire unpaid sessions, and settle or refund paid ones. Once `clark-changes`' code is deployed, a late webhook for one of `main`'s sessions gets 404 "Unknown PayMongo checkout. No payment was recorded." (or 409 if it is a live event). PayMongo would then hold money the app never recorded.
3. **Merge on a review branch.** Keep `clark-changes`' `src/paymongo.js` and `public/paymongo.js`. Remove `main`'s import and routes from `src/api.js`, the duplicate `<script>` in `public/index.html`, and the duplicate `PAYMONGO_*` block in `.env.example`. Use `clark-changes`' `test` script. Remove or rewrite `tests/paymongo.test.js` and `tests/paymongo.sql`, which test `main`'s module. Mark `PAYMONGO_SETUP.md` as superseded by `PAYMONGO_DEMO_REPORT.md`.
4. **Keep `main`'s two migration files unchanged.** They are already in hosted history, and removing them would block `db push`.
5. **Add one new migration that retires `main`'s design:**
   - Revoke `EXECUTE` on both `main` functions from `service_role`, or drop them once no deployment uses them.
   - Revoke `service_role` write access to `ff_paymongo_attempts`, but keep the admin read policy.
   - Optionally revoke `EXECUTE` on `ff_private.notify` from `service_role`. All of `clark-changes`' callers are `security definer`, so they don't need it.
   - Keep `ff_paymongo_attempts` and its rows, `ff_payments.provider_payment_id`, `ff_payment_recorder` and the nullable `recorded_by`. Payments that `main` settled have `recorded_by` null, so making it `not null` again would fail.
6. **Owner reviews `supabase db push --dry-run --include-all`, then pushes.** Same-day duplicates must be resolved first.
7. **Deploy `clark-changes`' code.** Point the PayMongo test webhook at the same URL, then run the verification checklist in `PAYMONGO_DEMO_REPORT.md`.

**Migrations needed:** `main`'s two files, kept as history; `clark-changes`' six pending migrations; and one new retirement migration.

**Risks:**

- Late webhooks for `main`'s sessions are orphaned if step 2 is skipped.
- `--include-all` applies migrations out of version order. The rehearsal in section 2 shows this order works.
- Live payments become impossible, because `clark-changes` is test-only. Going live later needs a separate, deliberate change.
- QR Ph is no longer available.
- `main`'s setup guide becomes wrong unless it is updated.

**Existing hosted `ff_paymongo_attempts` rows:** keep them as a read-only archive and never delete them. Don't migrate them into `ff_checkouts`: that table needs a `created_by`, only accepts test-mode rows (`ff_checkout_test_only`), and models registrations as well as invoices, so a migration would lose information or fail.

### Option B: keep `main`'s design and port staff role and paid-first registration onto it

Steps, in order:

1. Branch from `origin/main`.
2. **Port the non-PayMongo work from `clark-changes`:**
   - the token_hash email callback (`3848643`)
   - the staff role: migration `20260921084500`, plus the staff API, UI and permission changes inside `c550f1c`
   - paid-first registration, with cash only (`20261001184643`)
   - the daily check-in limit (`ddbe73c`). Its migration copies the staff-role version of `ff_private.command`, so it must follow the staff role.
   - the owner-login and wording cleanup (`54694d2`)
   - `c550f1c` mixes staff, registration and PayMongo changes in one commit, so it has to be split by hand.
3. **Bring `main`'s PayMongo to parity, with new migrations.** Each item is a schema change or new code:
   - Let staff and admins initiate: today `createCheckout` requires a member, and `ff_paymongo_read` uses `is_admin`.
   - Support online paid-first registration: attempts currently require both `invoice_id` and `member_id`.
   - Support walk-in renewal.
   - Add status-check and recovery endpoints, which don't exist today.
   - Add more methods if wanted.
4. Leave out `clark-changes`' three PayMongo migrations. Per its docs they were never applied to hosted.
5. Re-create browser and integration coverage for `main`'s flow. `tests/paymongo.js` targets `clark-changes`' design.
6. **Owner reviews `db push --dry-run --include-all`, then pushes:** staff role, paid-first, daily check-in, and the parity migrations.

**Migrations needed:** `main`'s two (already on hosted per docs); `20260921084500`; `20261001184643`; `20261009120000`; and the new parity migrations.

**Risks:**

- This is the most work. Every flow staff use at the desk needs new code.
- It loses the tested recovery paths and the 12-group browser coverage.
- Test keys stop working in the production-named workspace (`main` ties test keys to `demo`), so the current local test setup must change.
- Attempts stuck in `pending` after provider errors still need manual database edits.

**Existing hosted `ff_paymongo_attempts` rows:** they stay as live data in the active table. Never delete them.

### Option C (optional): hybrid

Keep `clark-changes`' checkout flow and the `ff_checkouts` data model, and do all of Option A's retirement steps. Then adopt the two things `main` has that `clark-changes` lacks, each as a separately approved change:

1. **QR Ph as a fifth method.** Add `qrph` to `PAYMONGO_METHODS`, to `ff_checkout_methods_allowlist` and to `ff_payments_method_check`, in one new migration.
2. **`main`'s live-mode activation rule** (live key, plus `production`, plus explicit opt-in), when the owner decides to accept real payments. This needs a new migration that replaces `ff_checkout_test_only` with a mode-and-workspace rule, `li` signature support, and a separate live webhook. It needs its own review and a small owner-approved real transaction.

**Risks:** live mode is the biggest design change. Until the owner signs off, the test-only protections must not be weakened.

**Existing hosted `ff_paymongo_attempts` rows:** the same as Option A. Keep them as a read-only archive.

## 6. Recommendation (my opinion)

In my opinion, the owner should choose **Option A now**, and treat Option C's QR Ph and live-mode items as later, separately approved changes.

- **Coverage:** `clark-changes` already handles every flow `main` does except QR Ph and live payments.
- **Front-desk flows:** it adds staff registration, walk-in renewal and staff-initiated checkout, which `main` lacks entirely.
- **Failure handling:** creation timeouts, stale claims and mismatched sessions go through recovery and status checks, where `main` relies on manual database edits.
- **Tests:** 11 unit tests, 12 browser and integration groups and 21 SQL checks, against `main`'s 5 unit tests and 11 SQL assertions.
- **Migrations:** they apply cleanly on top of `main`'s schema in the rehearsal above.

The main argument for `main` is that it can take real payments today, with explicit opt-in. If live payments are needed before Option C's live-mode work could be reviewed, that trade-off should be weighed honestly. Whichever option is chosen, the owner should first run `scripts/hosted-preflight.sql`, reconcile any open `ff_paymongo_attempts` rows while `main`'s webhook is still deployed, and decide what to do with any same-day duplicate check-ins. All three steps come before any merge or `db push`.
