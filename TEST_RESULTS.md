# Verification results

Verified 18 September 2026 against the existing Supabase project `ivxbrhqqfgmhfpgpauzh` and NACKY's protected Vercel preview. Results below are observed, not inferred from a successful build.

## Passed

| Command/check | Actual result |
| --- | --- |
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
- Supabase leaked-password protection remains disabled; review account support before enabling.

Raw JSON evidence and screenshots are in ignored `test-results/` on the original workstation. They are excluded from the distributable archive. Demo records remain clearly labeled; production test fixtures are removed. The original private Sites deployment and D1 database remain untouched.
