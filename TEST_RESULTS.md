# Verification results

Verified 18 September 2026 UTC (19 September in Manila for final checks) against the existing Supabase project `ivxbrhqqfgmhfpgpauzh` and NACKY's protected Vercel preview. Results below are observed, not inferred from a successful build.

## Passed

| Command/check | Actual result |
| --- | --- |
| `npm ci` | Clean lockfile installation succeeds; 0 vulnerabilities |
| `supabase db push --dry-run` | Remote database up to date; no pending migrations |
| `npm run check` | JavaScript syntax passes |
| `npm run build` | Static build succeeds; Vercel Node function deployment READY |
| `npm test` | 8 unit tests pass |
| Connected Supabase execution of `tests/database.sql` | 37 database assertions pass; transaction rolls back |
| `npm run test:integration` | Local API-to-live-Supabase suite passes |
| `node --env-file-if-exists=.env.local scripts/test-deployment.js` | Protected deployed API: 17 check groups; browser: 15 groups; temporary bypass revoked |
| `node --env-file-if-exists=.env.local scripts/test-deployment.js --browser-only` | Latest browser retake passes all 15 groups; zero unexpected console errors |
| `npm run test:auth` | 5 real Auth/API groups pass; both temporary accounts and related records removed |
| `npm run seed:demo` | Supported Auth seed succeeds for the three existing demo accounts |
| `node scripts/validate-d1-export.js .local/d1-export.json` | All seven business tables empty; totals 0; no account invitations needed |
| `node scripts/check-deployment.js` | READY, staging, all-deployment protection; anonymous HTTP 302 to Vercel sign-in |
| `npm audit` | 0 vulnerabilities |

Unit tests cover required contacts, Philippine mobile normalization, password/date rules, exact centavo parsing, image validation, CSRF/body/configuration failures, D1 integrity validation, missing/demo Gmail configuration and simulated SMTP state changes. The SMTP test uses a local fake database endpoint and injected fake transport: acceptance becomes sent, authentication failure becomes failed, uncertain timeout becomes needs_review, and a lost concurrent claim sends nothing. No live mail is sent.

Database tests cover RLS ownership and workspace isolation, user-metadata role spoofing, direct-write denial, authoritative prices, partial/idempotent payments, duplicate references, approval verification, overpayment, signed QR eligibility/expiry/tampering/replay, staff identity confirmation, renewal overlap and immediately revoked sessions. They use rollback-only SQL fixtures, not the real demo login accounts.

Deployed API tests authenticate the three real demo accounts, restore HttpOnly sessions, verify profile persistence, reject unauthorized and cross-customer access, upload/retrieve private signed images, submit/reject payments, race three concurrent approvals, complete balances idempotently, scan/check in and reject QR replay, verify RLS directly, suppress demo email and sign out. Uploaded payment-display test images were tiny synthetic non-payment images; the original empty payment settings were restored afterward.

Browser tests exercise desktop/mobile navigation, required registration contacts, recovery dialog, actual customer/admin login, persisted dashboard counts/revenue, member QR rendering, real QR image-upload decoding, mandatory identity checkbox, empty states, plan controls, onboarding with no permanent password field, notification configuration messages and logout. Mobile screenshots were retaken after the sidebar transition completed and visually inspected.

Auth tests use supported Supabase administration and the real Node API. Final trusted metadata correctly provisions an administrator; production signup rejects invalid details before email; an admin-created member uses a one-time invitation to set a password and log in; replay fails; recovery replaces the old password. Test-only `.invalid` accounts receive no emails and are removed after checks. This verifies token/setup behavior, not mailbox delivery.

## Failures found and resolved

- Auth provisioning initially read trusted metadata before Auth administration finished writing it. Deferred transaction-end provisioning fixes this and passed real createUser verification.
- Login error rendering selected the wrong form error element; field-scoped feedback now works.
- Owner/member API authorization now rejects prohibited admin routes before validating their payload.
- Vercel REST target omission unexpectedly selected production; all-deployment protection now precedes uploads and staging is explicit. See MIGRATION_NOTES.md for the exposure incident.
- Newly issued Vercel automation access reached API and static routes at different times. Tests now wait for valid API/JavaScript/CSS responses before opening the browser and obtain a protection cookie. Earlier retakes failed at this gate; the latest retake passes.
- Auth-test cleanup initially encountered deliberate financial foreign-key restrictions. Cleanup now removes only the generated test records in dependency order, then removes their Auth accounts. No real records were removed.

## Remaining manual checks

- Successful public signup confirmation and recovery **email delivery** with an owner-controlled test mailbox and configured Supabase Auth sender. Token verification and password replacement are tested; inbox delivery is not.
- Live Gmail SMTP acceptance and actual inbox receipt, using configured owner credentials and an authorized recipient. No Gmail credential or live-send claim is included.
- Owner's actual GCash/bank QR images and a reconciled real payment. No real funds were tested.
- Physical camera permission, autofocus and scanning on the intended staff phones. Actual image decoding fallback was tested.
- [Supabase leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) remains disabled; review account support before enabling. The final security advisor reported only this warning.

Raw JSON evidence and screenshots are in ignored `test-results/` on the original workstation. They are excluded from the distributable archive. Demo records remain clearly labeled; production test fixtures are removed. The original private Sites deployment and D1 database remain untouched.

## Brevo / Supabase Auth email confirmation — 20 September 2026

Change: `GET /api/auth/callback` now verifies a Supabase `token_hash` with `verifyOtp` instead of exchanging a PKCE `code`; `POST /recovery` no longer appends `?next=recovery`.

| Command/check | Actual result |
| --- | --- |
| `npm run check` | JavaScript syntax passes |
| `npm test` | 10 unit tests pass (8 existing, 2 new) |
| `npm run test:auth` | **Not executed.** Fails at `tests/auth.js:33` with `AuthApiError: Invalid API key` (401) because `.env.local` still holds the placeholder `SUPABASE_SECRET_KEY`. No Supabase records were created or modified. |

Token type verified against the installed `@supabase/supabase-js` and `@supabase/auth-js` 2.116.0 rather than assumed: `VerifyTokenHashParams` is `{ token_hash, type: EmailOtpType }`, and `EmailOtpType` resolves to `'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' | (string & {})`. The trailing `(string & {})` means the union does not constrain the value at runtime and `verifyOtp` forwards `type` verbatim to GoTrue `/verify`, so the API keeps its own explicit allowlist. `signup` and `email` are both accepted because Supabase's own documented template uses `type=email` while the default template emits `type=signup`.

New unit coverage runs fully offline against a local fake GoTrue endpoint: malformed, unsupported and tokenless links return `400 text/html` rather than a JSON body; valid `signup`, `email`, `recovery` and `invite` hashes return `303` to the correct destination with an `HttpOnly` cookie; and the request sent to `/auth/v1/verify` is asserted to carry no `code_verifier`, which is the regression guard for the cross-device failure.

`tests/auth.js` gains three connected groups, still pending credentials: a recovery link followed as a real top-level `GET` with a cookie jar, its replay refused as HTML without echoing the token, and a `generateLink` signup confirmation landing on `/` with a live member session instead of the password setup form.

Not verified: live Brevo SMTP acceptance, inbox delivery, and the hosted click-through. Vercel all-deployment protection still gates `/api/*`, so a member clicking a confirmation link on the hosted app meets the Vercel sign-in wall unless they hold authorized Vercel access. Production deployment and the production workspace were not touched.

## Paid-first registration and walk-in renewals - 2 October 2026

Verified against the local RepReady Supabase stack and installed Edge browser. These results supersede the earlier public-signup and registration-time invitation checks.

| Check | Result |
| --- | --- |
| JavaScript syntax, build, diff whitespace | Pass |
| Unit suite | 16 tests pass |
| Auth suite | 8 groups pass, including paid account provisioning and emailed-link password setup |
| Browser onboarding suite | 5 groups pass: static privileges on desktop/mobile, cash collection, captured setup email, live paid pass, future walk-in renewal |
| Registration resilience | Pass: request replay, account collision preserves payment, completion retry, explicit email retry review, invalid retry does not record cash |
| Existing rollback database suite | 59 assertions pass |
| Paid-first rollback database suite | Pass: staff-only RPCs, no premature account, exact full cash, atomic paid provisioning, idempotent renewal, member isolation |
| Local database security advisors | No warnings or errors reported |
| Local Auth public signup | Disabled and verified through Auth settings |

Temporary test accounts and financial records were removed, including two fixtures from an earlier interrupted cleanup. Production data and hosted configuration were not changed. Browser evidence is in ignored `test-results/onboarding-paid-pass.png`.

Local setup emails are captured at http://localhost:54324. Real inbox delivery still requires hosted Supabase SMTP and the recovery template described in DEPLOYMENT.md. PayMongo checkout/webhooks and real money movement remain unimplemented and untested; existing online payment submissions still require administrator verification.

## PayMongo e-wallet and card integration - 2 October 2026

`npm run test:paymongo` passes against a mock provider, real local Supabase and Edge. Six groups cover first membership with setup email, card walk-in renewal, existing invoice payment, member self-payment, selectors/checkout QR on mobile, and actual record-payment/renewal form submission. Additional assertions reject forged service-only settlement, invalid/stale signatures, wrong amounts and cash payments while a checkout is open. Duplicate webhooks/status checks create one payment. An uncertain create response reuses the saved checkout and supports administrator recovery of its provider session. The dedicated hosted Web Handler was tested with the newer event envelope and raw signed bytes.

No PayMongo credentials are configured in `.env.local`. Provider requests in this suite are intercepted in memory; no real/test provider transaction or funds movement occurred. Hosted database/configuration and real inbox delivery remain unverified. The five-group cash onboarding regression, 16 unit tests, syntax/build checks, both rollback database suites and local security advisors also pass with the PayMongo schema. Temporary fixtures are removed after the suite. Screenshot: ignored `test-results/paymongo-first-methods.png`.

## PayMongo demo-only hardening - 2 October 2026

This section supersedes the earlier PayMongo configuration/results. Full architecture, file inventory, additive migration and manual dashboard steps are in [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md). PayMongo now requires the demo workspace and TEST resources. No deployment, Git push, hosted mutation, live payment or real money movement occurred.

Before edits, syntax/build/diff checks passed, npm test passed 16 tests, Auth passed eight groups and the earlier mock-provider suite passed six groups. General integration stopped at its demo-workspace guard; general browser tests stopped because the protected demo credential file was absent. Neither suite ran its intended checks or wrote records.

| Command/check actually run after hardening | Actual result |
| --- | --- |
| `npm run check` | PASS JavaScript syntax |
| `npm run build` | PASS static build |
| `npm test` | PASS 25 tests: 16 existing plus nine PayMongo groups |
| `npm run test:auth` | PASS eight groups against local Supabase and captured email |
| `npm run test:registration` | PASS paid-first replay, collision/payment preservation and explicit email retries |
| `npm run test:onboarding` | PASS five Edge groups including cash collection, setup link/password, paid pass and future renewal |
| `npm run test:paymongo` | PASS ten expanded groups: mock provider, temporary demo accounts, real local database and Edge UI |
| Local psql execution of `tests/database.sql` | PASS 59 assertions; all fixtures rolled back |
| Local psql execution of `tests/paid-first.sql` | PASS cash/provisioning/renewal checks; all fixtures rolled back |
| Local psql execution of `tests/paymongo-demo.sql` | PASS 21 checks; all fixtures rolled back |
| `supabase db advisors --local --type security --level warn --fail-on error` | PASS no issues found |
| `git diff --check` | PASS; existing CRLF conversion notice only |
| `npm run package:source` | PASS 73 source files; protected fixtures/build caches excluded, embedded secret patterns checked |
| `npm run test:integration` | NOT RUN: local app workspace is production; general demo setup unavailable |
| `npm run test:browser` | NOT RUN: protected general demo credentials absent; dedicated Edge suites above did run |

The expanded suite covers GCash/Maya/GrabPay/card sources; production/live key/request/resource rejection; raw-byte signature verification; unsupported methods; DB price despite client amount tampering; invalid/paid invoices; RLS and service-only settlement; concurrent open-checkout reuse; manual/cash conflicts; wrong currency/amount/method/reference persisted for review; unknown/live events; unique session/payment IDs; transaction rollback and repeated/concurrent webhooks; early webhook binding; exactly-once paid-first provisioning; uncertain-create recovery; unpaid renewal access; return/failed/cancelled non-settlement; enabled-method selectors and retained member manual payment UI.

Intermediate suite runs corrected API-conflict expectations, fixture cleanup order and browser-context setup; the final runs exited successfully. Four exact suite-created UUIDs from an interrupted cleanup were verified and removed. Local inspection found no checkout rows or remaining PayMongo fixture profiles. The four original pending registrations remained, and an additional non-fixture pending registration that appeared during the work was preserved.

Anonymous requests to the supplied https://repready-gym.vercel.app returned 200 for the page and 503 `Payment webhook is not configured.` for POST /api/paymongo/webhook, without a Vercel sign-in redirect. This is reachability evidence, not proof of valid delivery/configuration. The deployed code was not updated and its workspace/schema/keys were not inspected.

NOT RUN: actual PayMongo TEST hosted checkout/authorization, merchant-enabled wallet/card methods, PayMongo-to-Vercel webhook delivery, hosted migration/RLS validation and real inbox delivery. New test credentials must be installed manually; no previously exposed secret was used. Actual `.env.local` remains unchanged with production workspace and no PayMongo credentials. Local setup messages were captured rather than delivered to real inboxes. Demo Gmail notifications remain intentionally suppressed; Auth setup email uses the existing separate path.


## PayMongo TEST MODE workspace and dropdown correction - 2 October 2026

This supersedes the earlier demo-only requirement. The current local production-named workspace works with its existing PayMongo test key and signing secret. `.env.local` is byte-for-byte unchanged; APP_WORKSPACE was not changed. The additive `20261002033541_paymongo_test_workspace.sql` was applied transactionally to local Supabase; hosted schema and deployment were not changed.

| Check | Result |
| --- | --- |
| `npm run check` | PASS JavaScript syntax |
| `npm run build` | PASS static build |
| `npm test` | PASS 25 tests, including workspace-independent test-key configuration, live-key rejection and explicit initiation capabilities |
| `npm run test:paymongo` | PASS ten groups with production-named local fixtures, intercepted provider calls and headless Edge |
| `tests/paymongo-demo.sql` via local psql | PASS 21 rollback-only compatibility/security checks |
| `supabase db advisors --local --type security --level warn --fail-on error` | PASS, no issues |
| Running local authenticated `/api/state` | PASS production workspace, configured=true, testMode=true, all four default methods and staff initiation capability |

Staff registration, walk-in renewal and invoice checkout remain authorized; members can initiate their own invoice but not another member's. Unsupported methods remain rejected. Edge assertions confirm four enabled GCash/Maya/GrabPay/card choices for staff registration and member invoice payment, without granting either role administrator-only manual recording permissions. Webhook signatures, paid-event verification, exact amount/PHP/method verification, provider-ID uniqueness, replay prevention and atomic settlement continue to pass.

The dedicated suite deletes only its generated fixtures and suppresses real SMTP. Final read-only SQL found zero remaining PayMongo fixture profiles, registrations or Auth accounts, confirmed the non-live checkout constraint, and verified that authenticated users cannot bind, review or settle payments while service_role can. No genuine PayMongo checkout or hosted webhook delivery was attempted; these results prove local behavior with a simulated provider, not merchant channel activation or external payment delivery. See [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md) for the exact current file inventory and remaining hosted setup.


## clark-changes pre-push verification - 2 October 2026

The current intended working tree passed all requested checks before staging: `npm run check`, `npm run build`, `npm test` (25/25) and `npm run test:paymongo` (ten groups, successful exit and fixture cleanup). Checkout tests required no further fixes. Local Supabase security advisors reported no issues. Source scanning found no embedded PayMongo/webhook/Supabase service credentials in the 76 reviewed files; protected `.env.local` remained unchanged and private paths remained ignored. The exact 43-file inventory, Preview environment requirements and migration order are recorded in [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md). The requested Git operation is a commit and push on `clark-changes` only; main, hosted schema and Production deployment are excluded.

## Batch 01 stabilization on clark-changes - 10 October 2026

Three commits: direct PayMongo checkout redirect with a double-submit guard; one check-in per member per Manila day (new migration `20261009120000_checkin_daily_limit.sql`); removal of the owner-login dead code and classroom wording that could still reach the connected app. Before the fix, a scratch copy of `tests/database.sql` reproduced the bug: a fresh pass (new nonce) recorded a second same-day check-in. Local `ff_checkins` held no rows, so there were no same-day duplicates to preserve. The migration was applied only to local Supabase, with psql in a single transaction. It is not recorded in local migration history, which records 4 of the 9 versions.

| Check | Result |
| --- | --- |
| `npm run check` | PASS JavaScript syntax |
| `npm run build` | PASS static build |
| `npm test` | PASS 32 tests, including 5 new: 409 mapping for a repeat check-in, the "Already recorded" scan modal, owner-login removal, connected.js patch-order guard, classroom wording |
| `npm run test:paymongo` | PASS 12 groups; provider calls intercepted, local Supabase, headless Edge |
| `npm run test:registration` | PASS |
| `tests/database.sql` via local psql | PASS 67 assertions (8 new for the daily limit); rolled back |
| `tests/paid-first.sql` via local psql | PASS 8 assertion blocks; rolled back |
| `tests/paymongo-demo.sql` via local psql | PASS 21 checks; rolled back |
| `supabase db advisors --local --type security --level warn` | PASS no issues found |
| `npm run test:auth` (additional) | PASS 8 groups |
| `npm run test:onboarding` (additional, local dev server) | PASS 5 groups |

Not verified: the "Already recorded" scan modal in a live browser (covered by the unit render test and the database assertions), the migration on the hosted project, and `tests/integration.js` / `tests/browser.js`, which need the demo workspace and credentials. No PayMongo provider request, hosted schema change or deployment occurred. Two pre-existing local checkouts from 2 October in `needs_review` were left untouched.

## Batch 02 clean-up on clark-changes - 10 October 2026

Three commits:

- **PayMongo fixes:** returning from checkout (pageshow, including bfcache) and a ~10 s visible-page safety timer now reset the in-flight state; checkout marks the form that was actually submitted; and "Already recorded" uses the amber badge.
- **Hosted pre-flight script:** a read-only `scripts/hosted-preflight.sql`, validated against local Supabase only.
- **`docs/BRANCH_RECONCILIATION.md`.**

Local migration history was repaired:

- `supabase db diff --local --schema public,ff_private` reported no schema changes.
- The five unrecorded versions were then marked applied with `supabase migration repair --status applied <version> --local`.
- All 9 versions are now recorded, and `supabase migration up --local` applied nothing.

`tests/integration.js` was not changed. It needs `APP_WORKSPACE=demo` and `.local/demo-credentials.json`, and that file is absent.

| Check | Result |
| --- | --- |
| `npm run check` | PASS JavaScript syntax |
| `npm run build` | PASS static build |
| `npm test` | PASS 37 tests, including 5 new: pageshow re-arm, visible-only safety reset, submitted form marked, amber badge, pre-flight script shape |
| `npm run test:paymongo` | PASS 12 groups; provider calls intercepted, local Supabase, headless Edge |
| `npm run test:registration` | PASS |
| `npm run test:integration` | NOT RUN: stops at its guard `Integration writes are restricted to APP_WORKSPACE=demo.`; demo credentials absent |
| `tests/database.sql` via local psql | PASS 67 assertions; rolled back |
| `tests/paid-first.sql` via local psql | PASS 8 assertion blocks; rolled back |
| `tests/paymongo-demo.sql` via local psql | PASS 21 checks; rolled back |
| `supabase db advisors --local --type security --level warn` | PASS no issues found |

Not verified:

- The Back/bfcache path in a real browser. Unit tests cover it by running `public/paymongo.js` in a sandbox, and the Edge PayMongo suite passes.
- The pre-flight script on the hosted project, where it was never run.

No hosted change, deployment or PayMongo provider request occurred.
