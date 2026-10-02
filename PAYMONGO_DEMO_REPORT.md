# RepReady PayMongo demo integration and verification

Updated 2 October 2026 for the disabled-payment-method correction. The current local production-named workspace now enables PayMongo TEST MODE with its existing test key and webhook secret. `.env.local` and `APP_WORKSPACE` were not changed. The additive workspace correction was applied locally. The earlier implementation passes did not push or deploy; the branch handoff below records the current commit/push preparation. No genuine provider checkout, live payment or real money movement was performed.


## Current correction: disabled payment methods

The old configuration gate required `APP_WORKSPACE=demo`, and the frontend reused `recordOnlinePayment`, an administrator capability for recording manual transfers. Both incorrectly disabled test checkouts for the existing local accounts. TEST MODE now depends on PayMongo credentials and verified non-live resources, independently of the workspace name.

`initiateOnlinePayment` is distinct from recording or settling funds. Administrators and staff may initiate registration, walk-in renewal and authorized invoice payments. Members may initiate their own invoices and explicitly supported own renewals, but cannot initiate registration or another member's invoice. The frontend checks the transaction role/owner; the server and session-scoped database RPC remain authoritative. Financial writes still require the trusted service role.

The current correction changes exactly these files; the historical inventory below covers earlier work:

| File | Reason |
| --- | --- |
| `src/paymongo-config.js` | Accept valid test configuration independently of workspace; retain live-key rejection and supported-method filtering. |
| `src/paymongo.js` | Match checkout lookups and registration completion to the active workspace while requiring test resources. |
| `src/state.js` | Add `initiateOnlinePayment` for admin, staff and member without granting staff/member manual transfer authority. |
| `public/paymongo.js` | Enable each configured method for authorized registration, renewal and invoice flows; check member ownership rather than staff-only recording authority. |
| `supabase/migrations/20261002033541_paymongo_test_workspace.sql` | Correct the actual local demo-only constraint/RPCs additively, preserving RLS, role/ownership checks and atomic service-only settlement. |
| `tests/paymongo-unit.test.js` | Verify production-named test configuration, live-key rejection, method filtering and unchanged financial/security checks. |
| `tests/unit.test.js` | Verify initiation grants and continued default-deny administrative capabilities. |
| `tests/paymongo.js` | Exercise production-named local fixtures, staff registration/renewal/invoice flows, member own invoice, cross-member rejection, unsupported methods and enabled Edge dropdowns. |
| `.env.example` | Correct the PayMongo comment; its existing APP_WORKSPACE value is unchanged. |
| `README.md` | Explain workspace-independent TEST MODE and the production-named local test fixtures. |
| `DEPLOYMENT.md` | Document the additive correction and correct the previous demo-only deployment guidance. |
| `TEST_RESULTS.md` | Record this correction's actual checks and distinguish it from earlier hardening results. |
| `PAYMONGO_DEMO_REPORT.md` | Update current configuration, file inventory, migration instructions and verification limits. |

Current correction verification: `npm run check` and `npm run build` pass; `npm test` passes 25 tests; `npm run test:paymongo` passes ten groups against local Supabase with all provider calls intercepted and real headless Edge forms. The SQL compatibility suite passes 21 rollback checks; local security advisors report no issues. The payment suite explicitly verifies staff registration and all four enabled staff/member methods, member-owned invoice success, cross-member invoice denial before a provider call, unsupported-method denial, signature/event/amount/PHP/method checks, unique provider IDs, duplicate prevention and atomic settlement. No real SMTP mail or provider payment is claimed.

## Architecture and source of truth

The current local application uses browser JavaScript, the Vercel Node API, Supabase Auth/PostgreSQL/private Storage, and PayMongo Hosted Checkout. `ff_checkouts` is the sole checkout table. No `ff_paymongo_attempts` table or competing settlement architecture was added. The cached `origin/main` reference had no matching table reference; GitHub was not fetched, merged or changed.

1. A signed-in authorized staff/member selects registration, renewal or invoice payment.
2. The session-scoped `ff_paymongo_prepare` RPC checks workspace, actor, ownership, plan availability, unpaid balance and manual-payment conflicts. It locks the target and saves a durable checkout using authoritative integer centavos. Client amounts, totals and prices are discarded.
3. The backend creates a TEST hosted checkout, carrying the internal checkout UUID as `reference_number`. Only HTTPS URLs on exactly `checkout.paymongo.com` may reach the browser. RepReady collects no card or wallet credentials.
4. PayMongo sends `checkout_session.payment.paid` to the dedicated raw-stream endpoint. The backend verifies the original signed bytes and financial details. An authenticated status request can also retrieve and verify the provider session; return-query values themselves have no financial authority.
5. The service-only settlement RPC locks the business target and checkout, then commits provider ID, payment and invoice balance together. The provider payment/session IDs and open-target indexes enforce uniqueness.
6. First registrations become durably paid before supported Auth account creation. The Auth provisioning trigger creates profile, membership, fully paid invoice and payment in one transaction. Repeated completion creates no second account/cycle/payment. Setup email follows provisioning; failure leaves payment intact for explicit completion/retry.
7. A renewal may create an unpaid future cycle/invoice before checkout. It grants no paid access until the invoice is fully paid and the cycle dates apply. Repeated renewal requests reuse the same unpaid cycle. Existing paid cycles remain valid.

Hosted checkout creation uses `/v2/checkout_sessions`; reconciliation uses `/v1/checkout_sessions/{id}`. Fees are absorbed rather than added to the expected amount. This follows the [PayMongo Hosted Checkout guide](https://docs.paymongo.com/docs/payment-channels-hosted-checkout).

Cash at the desk remains staff-authorized. Manual GCash/bank transfers still use submission, pending review and administrator verification; they are not PayMongo payments. Members retain the manual transfer UI. An open online checkout blocks conflicting manual settlement, and a pending manual submission blocks online creation.

## Verification rules

| Check | Implementation |
| --- | --- |
| Configuration | Requires a test secret, signing secret, at least one supported method and live permission set to false. Workspace naming does not determine PayMongo test mode. Live keys and live requests fail before a provider call. Public configuration exposes only availability, method names, test flag and a safe disabled reason. |
| Signature | Raw bytes; HMAC-SHA256 over timestamp + period + original body; `te` required, nonempty `li` rejected; timing-safe comparison; timestamp within five minutes. Duplicate/malformed header fields fail. Parsed JSON objects are rejected at the raw handler. |
| Event | Accepts both existing and current event envelopes. Only checkout payment-paid events may settle. Other correctly signed test events return 200 ignored. Live events/resources fail closed. |
| Checkout/reference | Known non-live row in the active application workspace, saved session ID and exact internal UUID reference. Early webhooks can bind an unbound durable row only after these checks. Unknown references do not create business records. A bound session cannot be changed. |
| Financial fields | Exactly one payment with status paid, explicit test mode, integer amount equal to the stored snapshot, PHP currency, and a provider source allowed by both saved checkout methods and current server configuration. Failed/pending/cancelled attempts do not settle. |
| Provider identifiers | Valid provider ID formats; unique session/payment constraints; same paid reference replays successfully; another paid reference is held for review. |
| Atomicity | Target lock followed by checkout lock; a failed constraint/business check rolls back checkout status, ledger insert and invoice update. Only service-role RPCs can bind, review or settle. Browser financial writes remain forbidden. |
| Review/history | Safe observed session/payment IDs, amount, currency, source, mode and category are saved in review details/log. No entire provider payload, authorization header, card data or secret is retained. An already paid ledger is preserved if a later contradictory reference arrives. |
| Return UI | Displays checking/waiting text and invokes authenticated provider reconciliation. Opening a success URL alone cannot pay an invoice. Ambiguous/reviewed checkouts cannot offer a replacement payment. |

Signature handling follows [PayMongo webhook setup and security](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management). Database checks independently repeat critical financial validation rather than trusting the browser or a caller's payment-method label.

Creation errors that definitively reject the provider request are recorded as failed. Network timeouts, unreadable responses and uncertain outcomes are retained for review, with no automatic replacement session. Administrators recover an existing session by internal reference. Provider-confirmed expiry with no paid payment releases a target; closing a modal or returning from checkout does not expire it. Automatic refunds and manual financial overrides are not introduced.

## Earlier hardening file inventory (historical)

| File | Change |
| --- | --- |
| `.env.example` | Demo default, explicit live prohibition and server-only test placeholders. |
| `src/paymongo-config.js` | Demo/test-only configuration gate and configurable four-method allowlist. |
| `src/paymongo.js` | Hosted checkout, strict URL/resource validation, signatures, verification, safe review, binding/recovery and idempotent settlement. |
| `src/api.js` | Allows authorized staff-assisted paid-first registration in demo; public signup remains disabled. |
| `public/paymongo.js` | Separate GCash/Maya/GrabPay/card options from backend configuration, manual option, test notices, review states and return-status messaging. |
| `supabase/migrations/20261001213203_paymongo_demo_hardening.sql` | New additive schema/RPC hardening described below. |
| `tests/paymongo.js` | Temporary demo fixtures, in-memory provider simulation, financial/concurrency/RLS checks and actual Edge forms. |
| `tests/paymongo-unit.test.js` | New offline configuration, signature, URL, resource/event and payment validation tests. |
| `tests/paymongo-demo.sql` | New rollback-only database role/constraint/atomicity checks. |
| `package.json` | Includes the new offline suite in npm test. |
| `scripts/package-source.js` | Includes this report in the source archive; rejects embedded PayMongo key patterns. |
| `README.md` | Current demo status, payment architecture and verification commands. |
| `DEPLOYMENT.md` | Current demo guidance and removal of obsolete manual-link/future-payment instructions; labels the older private deployment as historical. |
| `TEST_RESULTS.md` | Actual baseline and final verification evidence with external limitations. |
| `PAYMONGO_DEMO_REPORT.md` | This architecture, setup and handoff report. |

The checkout already had uncommitted onboarding/payment work before this pass. Those files were preserved. The earlier integration's other files are `api/paymongo-webhook.js`, `src/onboarding.js`, `src/dev.js`, `src/notifications.js`, `src/state.js`, `src/supabase.js`, `public/app.js`, `public/connected.js`, `public/connected.css`, `public/index.html`, `scripts/create-staff.js`, `scripts/seed-local.js`, `tests/auth.js`, `tests/browser.js`, `tests/database.sql`, `tests/unit.test.js`, `tests/onboarding.js`, `tests/registration-resilience.js`, `tests/paid-first.sql`, `vercel.json`, `supabase/.gitignore`, `supabase/config.toml`, `supabase/templates/invite.html`, `supabase/templates/recovery.html`, and the three newer prerequisite migrations below. Generated build files, browser screenshots and temporary local fixtures are ignored artifacts, not committed application source.

## Database migrations

The earlier hardening created `20261001213203_paymongo_demo_hardening.sql`. This correction adds `20261002033541_paymongo_test_workspace.sql`; earlier migrations were not rewritten.

| Migration | Role |
| --- | --- |
| `20260918150113_form_fitness_core.sql` | Existing core business tables, RLS, integer accounting and commands. |
| `20260918150433_form_fitness_hardening.sql` | Existing private helpers, security and storage hardening. |
| `20260918151947_form_fitness_auth_provisioning.sql` | Existing trusted Auth provisioning/deferred trigger. |
| `20260921084500_form_fitness_staff_role.sql` | Existing staff permissions and member/administrator boundaries. |
| `20261001184643_paid_first_registration.sql` | Existing registration snapshots, paid-first provisioning and cash walk-in renewal. |
| `20261001201100_paymongo_checkout.sql` | Existing checkout table, unique provider/open-target indexes, settlement wrapper and cash-conflict guards. Its original production-only configuration is superseded by the next migration. |
| `20261001213203_paymongo_demo_hardening.sql` | Earlier review fields, canonical request details and hardened preparation/provisioning/settlement/binding. Its demo-only workspace restriction is superseded below. |
| `20261002033541_paymongo_test_workspace.sql` | Removes demo-only workspace enforcement from preparation, binding, review and settlement; retains test-only rows, authenticated preparation, ownership checks and service-only settlement. |

The correction replaces `ff_checkout_demo_only` with `ff_checkout_test_only CHECK (livemode IS FALSE) NOT VALID`. New/updated checkouts may belong to production or demo, but must be non-live. Runtime and database settlement checks also reject live resources; historical live rows remain unusable for automatic settlement. Workspace isolation, the four-method constraint, unique provider IDs, target locks and atomic financial validation are preserved. No tables or payment history were dropped, truncated, relabeled or cleared.

Added checkout fields: `request_details`, `review_reason`, `review_details`, `review_log`, `verified_at`. Existing amount, session/payment ID, mode, status and timestamps remain authoritative. Existing unique constraints/indexes are retained.

Replaced private functions: `registration`, `paymongo_prepare`, `register_auth_user`, `paymongo_settle`. Added private `paymongo_bind` and `paymongo_review`, with public invoker wrappers `ff_paymongo_bind`/`ff_paymongo_review`. Binding/review/settlement execute privileges are revoked from public, anonymous and authenticated roles and granted only to service_role. Existing checkout RLS still limits members to their own rows and staff to their workspace.

The migration was applied transactionally to local Supabase, with final function refinements applied transactionally as well. Hosted Supabase was not changed. Local direct SQL does not automatically record a migration version: verify the actual schema and align migration history before any subsequent db push. Do not replay already-present schema objects or use db reset to make history fit.

## Environment variable names

Application and PayMongo environment names (keep the existing workspace):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `APP_WORKSPACE`
- `APP_ORIGIN`
- `PAYMONGO_SECRET_KEY`
- `PAYMONGO_WEBHOOK_SECRET`
- `PAYMONGO_ALLOW_LIVE`
- `PAYMONGO_METHODS`

Optional existing notification variables: `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `OWNER_EMAIL`. Optional protected seed inputs: `DEMO_ADMIN_EMAIL`, `DEMO_CUSTOMER_EMAIL`, `DEMO_SECOND_CUSTOMER_EMAIL`. No PayMongo publishable key is required. No full API credential is contained in this report, source or tests. Synthetic signing/configuration values are generated only in memory during tests.

The existing `.env.local` was left byte-for-byte unchanged. It selects the production-named workspace and already contains a test key and webhook secret. An authenticated request to the running local server verified `paymongo.configured=true`, `paymongo.testMode=true` and methods `["gcash","paymaya","grab_pay","card"]`. Staff has `initiateOnlinePayment=true` without gaining manual transfer-recording authority. Workspace isolation for account login is unchanged.

## Payment methods

The server defaults to GCash (`gcash`), Maya (`paymaya`), GrabPay (`grab_pay`) and card (`card`). Each can be removed from the configuration; the frontend displays only configured methods and disables online checkout when integration configuration is incomplete. The older grouped e-wallet request is accepted for compatibility, but new selectors expose individual methods.

QR Ph, arbitrary bank methods, live payments, recurring billing and custom card fields are intentionally not enabled. Actual merchant test-mode channel availability still requires a genuine provider test checkout; the local availability flag verifies configuration, not merchant activation. Do not use a real banking app to pay any test code; the RepReady checkout QR only opens the hosted URL.

## Earlier verification commands (historical baseline)

| Command/check | Baseline | Final result |
| --- | --- | --- |
| `npm run check` | PASS | PASS JavaScript syntax. |
| `npm run build` | PASS | PASS static build. |
| `npm test` | PASS 16 tests | PASS 25 tests, including nine new PayMongo groups. |
| `npm run test:auth` | PASS eight groups | PASS eight groups with local Auth and captured email. |
| `npm run test:paymongo` | PASS six earlier mock groups | PASS ten expanded groups using local Supabase, mocked provider and headless Edge. |
| `npm run test:registration` | Earlier baseline evidence retained | PASS paid-first account collision/payment/email retry. |
| `npm run test:onboarding` | Earlier baseline evidence retained | PASS five groups: privileges, cash collection, captured setup link, password/pass and renewal. |
| Local psql run of `tests/database.sql` | Earlier baseline evidence retained | PASS 59 rollback-only assertions. |
| Local psql run of `tests/paid-first.sql` | Earlier baseline evidence retained | PASS rollback-only cash/provisioning/renewal checks. |
| Local psql run of `tests/paymongo-demo.sql` | New suite | PASS 21 rollback-only checks. |
| `supabase db advisors --local --type security --level warn --fail-on error` | Earlier baseline evidence retained | PASS, no issues found. |
| `git diff --check` | PASS | PASS; existing CRLF conversion notice only. |
| `npm run package:source` | Not part of baseline | PASS 73 source files, private artifacts excluded and secret patterns checked. |
| `npm run test:integration` | Guard stopped: APP_WORKSPACE not demo | NOT RUN: local general demo configuration unavailable. No integration writes occurred. |
| `npm run test:browser` | Guard stopped: protected demo credentials absent | NOT RUN: general demo credentials unavailable. The dedicated PayMongo/onboarding Edge suites did run successfully. |

Database invocation was `Get-Content -Raw tests/<suite>.sql | docker exec -i supabase_db_RepReady psql -U postgres -d postgres -v ON_ERROR_STOP=1`; output-only quiet/tail flags were used on later runs. Every SQL suite rolls back its synthetic fixtures. The mock-provider suite deletes only its generated UUIDs; verification found zero checkout rows and zero remaining PayMongo fixture profiles. All four original pending registrations were preserved. An additional non-fixture pending registration appeared during the work and was also preserved.

Intermediate suite runs corrected API-conflict expectations, reviewer-before-submission cleanup order and browser-context setup. The final suite exited successfully. Four exact generated fixture UUIDs from the interrupted cleanup were verified and removed. No user records were removed.

The ten expanded groups exercise all payment entry points; all four provider sources; raw hosted handler; missing/invalid/stale/live signatures; production-workspace acceptance and live/request/method gates; authoritative amounts despite frontend tampering; paid/missing invoice denial; RLS/service-only writes; manual/cash conflict; concurrent checkout reuse; wrong currency/amount/method/reference review; unknown session/reference; duplicate provider IDs and atomic rollback; concurrent webhook replay; early webhook binding; exactly-once account provisioning; uncertain-response recovery; desktop/mobile forms; manual transfer availability; enabled-method filtering; and return/failure non-settlement.

## Manual setup still required

1. **PayMongo Dashboard:** use protected TEST credentials and confirm which of the four payment methods are enabled for this merchant's test account. Developers → Webhooks → Add endpoint: set `https://repready-gym.vercel.app/api/paymongo/webhook`, subscribe to `checkout_session.payment.paid`, save and enable the TEST endpoint. Put its signing secret into protected server environment configuration. Do not create a live endpoint. These steps follow [PayMongo's setup guide](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management).
2. **Supabase:** confirm the existing target project and migration history; apply only missing reviewed dependencies and the new additive migration. Configure Authentication → URL Configuration for the demo origin and exact `https://repready-gym.vercel.app/api/auth/callback`. Install `supabase/templates/recovery.html` as Reset password mail, configure a verified SMTP sender and keep public signup disabled. Keep authorized accounts in their existing workspace using supported Auth administration and protected workspace/role claims. TEST MODE does not require demo accounts. Do not modify user_metadata to assign authority.
3. **Vercel Dashboard:** open the project serving the supplied domain → Settings → Environment Variables. Add/update the required names above for the environment serving this alias: the existing account workspace, exact application origin, test-only credentials, live permission false and enabled method identifiers. Keep all secrets server-only. Deploy the reviewed local version when the developer chooses; no deployment was made by this task. Recheck the webhook response after deployment/configuration.
4. **Deployment Protection:** the earlier anonymous POST probe on the supplied domain reached the app and returns 503 `Payment webhook is not configured.`, with no Vercel sign-in redirect. No protection setting was changed, and dashboard settings were not inspected. If protection later blocks delivery, retain it and use Settings → Deployment Protection → Protection Bypass for Automation → create a dedicated secret. Configure only the private webhook URL with its `x-vercel-protection-bypass` query parameter when a custom header is unavailable. The bypass secret is project-wide, so protect the full URL, do not place it in browser code/logs/chat, and revoke/rotate if exposed. The PayMongo signature remains required. An OPTIONS allowlist does not permit POST. See [Vercel automation bypass documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
5. **Hosted acceptance test:** simulate successful, failed and cancelled GCash/Maya/GrabPay/card payments using PayMongo's test flows. Check signed webhook delivery and retries, one ledger entry, exact paid balance, first-registration account/setup email, renewal dates and member pass. Return without paying and verify no new credit. Review webhook delivery logs using sanitized IDs/categories; do not capture entire payloads containing billing/card information.

For local provider tests, localhost is not a public webhook target. A Vercel webhook settles only the database configured in Vercel, not an unrelated local stack. Use one consistent database, application workspace and origin across checkout, webhook and status verification. Local mock tests need no PayMongo credential or public tunnel.

## Remaining limits

- No genuine PayMongo test checkout, hosted wallet/card authorization, card authentication or PayMongo-to-Vercel delivery ran. Local configuration was verified without sending its credentials to the provider.
- The earlier deployed-domain probe reported an unconfigured payment webhook; that observation was not refreshed for this local correction. Code and migrations remain local; hosted environment/workspace, schema and merchant-enabled methods were not verified.
- Local email capture and actual password setup passed; real SMTP/inbox delivery was not tested. Demo Gmail payment notifications intentionally remain suppressed and auditable. Paid-first Auth setup mail is a separate supported path. Failed account/email completion is retried through existing staff completion actions or verified reconciliation, not an added background worker.
- Webhooks perform required paid-first Auth completion synchronously after the financial commit and do not flush Gmail. There is no new durable provisioning job runner; an account/email failure leaves a paid retryable registration.
- Historical checkout attempts are retained. Only non-live checkouts in the active application workspace can be reconciled or settled; never delete or relabel history to unblock payment.
- Equipment privileges are database descriptions displayed consistently; actual gym equipment access hardware is outside this payment change. Refund automation, recurring debits and prorated mid-cycle changes remain outside scope.

The external acceptance flow remains unverified until the developer completes the protected dashboard setup and PayMongo test simulation. Local automated success is not a claim of hosted payment or inbox delivery.


## clark-changes branch handoff - 2 October 2026

The working tree was inspected on `clark-changes` at base commit `384864367410034a24459ad2f581823acdd627b0`. The intended commit message is `Fix RepReady PayMongo test checkout and verification flow`. The authorized push target is `origin clark-changes` only. No merge to main, remote database migration, Production deployment or promotion is part of this handoff. The existing Production alias currently points to a main-branch deployment; project settings were not changed.

All four requested commands passed immediately before commit preparation: `npm run check`, `npm run build`, `npm test` (25 tests) and `npm run test:paymongo` (ten local database/mock-provider/Edge groups). No failing checkout test required a new code fix. Supabase local security advisors reported no issues, and `git diff --check` passed. The full PayMongo verification still uses an intercepted provider and captured local Auth mail; genuine provider delivery and real inbox delivery are unverified.

Git ignores `.env`, `.env.local` and `.local/`; none is tracked or included in the commit candidates. The credential scan reviewed all 76 tracked or intended source files for PayMongo keys, webhook tokens, Supabase secrets/service-role JWTs, private keys and exact credential values from the protected local environment. It found no embedded credentials. The existing `.env.local` remained byte-for-byte unchanged. Only `.env.example`, with blank secret placeholders, belongs in Git.

The complete intended changes include the earlier uncommitted RepReady branding, staff roles, plan privileges, paid-first onboarding/setup emails and renewal workflow, together with the PayMongo fixes. Exact changed files (43):

- `.env.example`
- `DEPLOYMENT.md`
- `PAYMONGO_DEMO_REPORT.md`
- `README.md`
- `TEST_RESULTS.md`
- `api/paymongo-webhook.js`
- `package.json`
- `public/app.js`
- `public/connected.css`
- `public/connected.js`
- `public/index.html`
- `public/paymongo.js`
- `scripts/create-staff.js`
- `scripts/package-source.js`
- `scripts/seed-local.js`
- `src/api.js`
- `src/dev.js`
- `src/notifications.js`
- `src/onboarding.js`
- `src/paymongo-config.js`
- `src/paymongo.js`
- `src/state.js`
- `src/supabase.js`
- `supabase/.gitignore`
- `supabase/config.toml`
- `supabase/migrations/20260921084500_form_fitness_staff_role.sql`
- `supabase/migrations/20261001184643_paid_first_registration.sql`
- `supabase/migrations/20261001201100_paymongo_checkout.sql`
- `supabase/migrations/20261001213203_paymongo_demo_hardening.sql`
- `supabase/migrations/20261002033541_paymongo_test_workspace.sql`
- `supabase/templates/invite.html`
- `supabase/templates/recovery.html`
- `tests/auth.js`
- `tests/browser.js`
- `tests/database.sql`
- `tests/onboarding.js`
- `tests/paid-first.sql`
- `tests/paymongo-demo.sql`
- `tests/paymongo-unit.test.js`
- `tests/paymongo.js`
- `tests/registration-resilience.js`
- `tests/unit.test.js`
- `vercel.json`

### Vercel Preview environment requirements

Scope these variables to Preview, preferably to `clark-changes`; keep secrets server-only. Do not copy the local file into the repository or deployment assets. The variables below are application requirements from the current source, not a claim that they are already configured remotely. Vercel supports branch-specific Preview variables as documented at https://vercel.com/docs/environment-variables.

| Variable | Required value or purpose |
| --- | --- |
| `SUPABASE_URL` | HTTPS endpoint of the intended Preview database; do not use localhost. |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key matching that database. |
| `SUPABASE_SECRET_KEY` | Matching server-only secret/service-role key for trusted settlement and paid-first Auth provisioning. |
| `APP_WORKSPACE` | `production`, matching the current accounts/workspace. This is an application label; PayMongo still uses TEST MODE. |
| `APP_ORIGIN` | Exact HTTPS Preview origin, without a trailing slash; a stable branch alias simplifies callbacks/webhook configuration. |
| `PAYMONGO_SECRET_KEY` | Protected TEST secret only; live keys remain disabled. |
| `PAYMONGO_WEBHOOK_SECRET` | Signing secret for the TEST webhook targeting the same Preview origin and database. |
| `PAYMONGO_ALLOW_LIVE` | `false`. |
| `PAYMONGO_METHODS` | `gcash,paymaya,grab_pay,card`, or only the supported methods actually enabled for the merchant's TEST account. |

`GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD` and `OWNER_EMAIL` are optional for application notification delivery. Account/password setup mail uses Supabase Auth's configured email provider instead. No PayMongo publishable key is needed. `PORT`, local seed account credentials and local-stack variables are not Preview requirements.

Register `<exact-preview-origin>/api/auth/callback` in Supabase Auth's redirect allowlist and install the recovery template with a working Auth SMTP sender. Point the PayMongo TEST webhook at `<exact-preview-origin>/api/paymongo/webhook` and subscribe to `checkout_session.payment.paid`. Webhook delivery must reach the app through any Preview deployment protection; keep signature verification enabled. No hosted configuration was edited by this handoff.

### Required Supabase migrations

Review the target database's existing schema/history, then apply only missing migrations in chronological order. The first three are existing core prerequisites; the next five are part of this commit:

1. `supabase/migrations/20260918150113_form_fitness_core.sql`
2. `supabase/migrations/20260918150433_form_fitness_hardening.sql`
3. `supabase/migrations/20260918151947_form_fitness_auth_provisioning.sql`
4. `supabase/migrations/20260921084500_form_fitness_staff_role.sql`
5. `supabase/migrations/20261001184643_paid_first_registration.sql`
6. `supabase/migrations/20261001201100_paymongo_checkout.sql`
7. `supabase/migrations/20261001213203_paymongo_demo_hardening.sql`
8. `supabase/migrations/20261002033541_paymongo_test_workspace.sql`

The final migration supersedes the old demo-only checkout restriction while preserving test-only resources, ownership checks and service-only settlement. The current local schema already contains these changes; `supabase migration list --local` records the first four versions, while the four later versions were applied using transactional SQL and are not yet recorded in local migration history. Align history after verifying schema equality; do not reset the database or blindly replay manually applied changes. Hosted migration state was not inspected or changed.
