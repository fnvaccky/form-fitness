# Deployment and owner setup

Current PayMongo demo instructions and verification are in [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md), using https://repready-gym.vercel.app. The historical private FORM deployment evidence below describes a different deployment and must not be assumed to describe the current demo domain. No hosted settings were changed during the payment hardening pass.

## Verified target

- Vercel user: `achillespasuncion-2666`, NACKY, `achillespasuncion@gmail.com`.
- Team: `team_E73K426NyjwlO1fFqAckGqki`.
- Project: `form-fitness`, `prj_E5NUGSqg1pLaOSjLcbHO3EkV6Mkj`.
- Supabase: existing `form-fitness`, `ivxbrhqqfgmhfpgpauzh` (Singapore).
- Protected preview: https://form-fitness-1rrt0d886-achillespasuncion-2666.vercel.app .

Vercel Authentication is configured for **all deployments**, including production aliases. A preview URL and FORM login alone are not protection. Anonymous requests must redirect to Vercel sign-in or return 401/403. No plan upgrade was made. See the initial deployment incident in MIGRATION_NOTES.md.

The source repository is [fnvaccky/form-fitness](https://github.com/fnvaccky/form-fitness), verified private. Source is uploaded there; deployment currently uses the explicit protected REST workflow below. Automatic Git deployments are not enabled.

## Reproduce the private preview

Authenticate the Vercel CLI as NACKY (`npx vercel@59.23.1 login`) or supply `VERCEL_TOKEN` securely. The scripts verify the exact account and team before writes. CLI dependencies are not part of the app.

```powershell
node scripts/prepare-vercel.js
node --env-file-if-exists=.env.local scripts/deploy-private.js
node scripts/check-deployment.js
node --env-file-if-exists=.env.local scripts/test-deployment.js
```

The deployment script requires demo mode, installs encrypted preview variables, uploads an explicit source allowlist, sets target `staging`, and refuses deployment without all-deployment protection. Run the status check until READY. The test runner creates temporary automation access, uses Vercel's bypass cookie, and revokes access in `finally`. Do not share a bypass token. If execution is forcibly terminated, revoke any remaining temporary bypass under Vercel Settings > Deployment Protection before continuing.

## Supabase migrations and Auth

The three checked-in migrations have already been applied. Do not reset the database or replay applied migrations blindly. For a future change, run `supabase login`, `supabase link --project-ref ivxbrhqqfgmhfpgpauzh`, review `supabase db push --dry-run`, then apply only pending reviewed migrations. The `ff_` tables and private functions belong to this application; unrelated tables must remain untouched.

Auth URL configuration has been applied and verified, and Supabase now enforces a 12-character minimum password. For future changes, in Supabase Authentication > URL Configuration, set the Site URL to the exact protected deployment used for real accounts. Add one exact callback URL per environment (avoid wildcard domains):

- `http://localhost:4173/api/auth/callback`
- `https://<preview-or-production-host>/api/auth/callback`

Only the `redirectTo` value the API sends is matched against this allowlist, so the bare callback URL is sufficient; the token query is appended later by the email template. The earlier `?next=recovery` entries are obsolete and can be removed — the callback now derives its destination from the link's `type`.

Configure Supabase's own Auth email provider for confirmation/recovery. This is separate from the application's Gmail notification sender. Confirm email confirmation and recovery on an address you control. Enable leaked-password protection if available on the account; the security advisor currently reports it disabled. New deployment hostnames require new exact callback allowlist entries. A recipient also needs authorized Vercel access while protection is enabled.

### Email confirmation links

`GET /api/auth/callback` verifies a Supabase `token_hash` with `verifyOtp` and accepts the types `signup`, `email`, `recovery` and `invite`. It redirects a confirmed signup to `/` (already signed in, password chosen at registration) and recovery or invite to `/#/set-password`. Anything invalid, expired or replayed renders an HTML page, because these URLs are opened directly by a mail client.

This replaces the previous PKCE `code` exchange. `@supabase/ssr` forces `flowType: 'pkce'` on the server client, and the PKCE code verifier lives in a cookie belonging to the browser that started the flow, so a code link failed whenever a member opened their email on a different device. `verifyOtp` carries no verifier and works across devices.

Both email templates must therefore use `{{ .TokenHash }}`, not `{{ .ConfirmationURL }}`. In Supabase Authentication > Email Templates:

- **Confirm signup** — `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`
- **Reset password** — `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`

Use `{{ .RedirectTo }}`, never `{{ .SiteURL }}`. `RedirectTo` carries the per-environment `APP_ORIGIN` the API supplied, so one template serves localhost, preview and production. `SiteURL` is a single fixed value and would send every environment's mail to the same host. Updating these templates is a prerequisite for the callback, not an optional step: a template still emitting `{{ .ConfirmationURL }}` produces a link the callback rejects.

Current staff registration saves a pending record. After full verified payment, supported Auth account creation and Supabase recovery mail deliver the password setup link. No setup token is returned to staff. Public signup is disabled.

### Brevo SMTP

Supabase Auth sends all confirmation and recovery mail. Brevo is configured only inside Supabase, in Project Settings > Authentication > SMTP Settings:

| Field | Value |
| --- | --- |
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| Username | Brevo SMTP login (the `…@smtp-brevo.com` identifier, not the account email) |
| Password | Brevo **SMTP key** (not the account password, not a v3 API key) |
| Sender email | An address verified in Brevo under Senders, Domains & Dedicated IPs |
| Sender name | `FORM Fitness` |

These credentials belong in the Supabase Dashboard only. They are never added to `public/`, to `.env*`, to Vercel environment variables, or to Git — the application never speaks to Brevo directly. Verify the sender domain in Brevo and publish its SPF and DKIM records before real use, or confirmations will be spam-filtered. Brevo's free tier caps daily sends.

After enabling custom SMTP, raise the email limit in Authentication > Rate Limits. The built-in default is roughly two messages per hour and will reject real registrations; `POST /signup` surfaces that as a 429 with a retry message.

Brevo here is unrelated to `src/notifications.js`, which still delivers member notifications over the owner's Gmail sender. Authentication does not depend on that queue.

The `form-fitness-private` bucket is private. Do not make it public. Migrations provide policies for member photos/receipts and staff payment images. The API returns short-lived signed image URLs.

## Runtime variables

Set these separately for preview and production in Vercel Settings > Environment Variables, then redeploy:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | `https://ivxbrhqqfgmhfpgpauzh.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Existing project's publishable key |
| `SUPABASE_SECRET_KEY` | Server-only secret or service-role key; invitations and mail worker |
| `APP_WORKSPACE` | `demo` for sample accounts; `production` for real members |
| `APP_ORIGIN` | Exact HTTPS origin, no trailing slash; omitted previews use `VERCEL_URL` |
| `GMAIL_ADDRESS` | Owner's authorized sender address |
| `GMAIL_APP_PASSWORD` | Google app password; never a regular password |
| `OWNER_EMAIL` | Owner contact for operational configuration |

Do not enable shared demo credentials in a production workspace. The current deployed demo intentionally has no elevated key or Gmail credentials. The production environment already has encrypted Supabase URL, publishable key, server secret, production workspace and the exact protected production alias origin; these variables take effect on the next production deployment. To prepare real use, retain all-deployment protection, configure a separate production environment with `APP_WORKSPACE=production`, provision the owner administrator with the local script, verify real onboarding/recovery, and deploy only after configuration is complete.

## Owner administrator

With the server credential available locally, set `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PHONE`, `APP_WORKSPACE=production`, and the intended protected `APP_ORIGIN`, then run:

```powershell
node --env-file-if-exists=.env.local scripts/create-admin.js
```

This refuses existing accounts, creates a trusted admin via supported Auth administration, verifies its database role, and stores a one-time password setup link in restricted `.local/admin-setup.json`. It sends no email and prints no password or token. Open the file privately, use the link, and remove it after setup. Do not put it in screenshots or share it in a public chat.

## Gmail and payment QR configuration

Enable Google 2-Step Verification and obtain an eligible account's [app password](https://support.google.com/mail/answer/185833). Add Gmail variables and the server secret in Vercel; redeploy. The sender uses TLS on port 465. Queue rows show queued, sending, sent, failed, needs_review or suppressed. Sent means SMTP accepted the recipient; it does not prove inbox delivery. Before retrying an uncertain send, inspect Gmail Sent. Demo records never send mail. A live test must use an explicitly authorized recipient and inspect both queue status and mailbox receipt.

In FORM admin Settings > Payment QR codes, upload the owner's actual GCash and bank QR images and verify recipient details. They are intentionally unconfigured. No invented payment QR is supplied. Confirm funds in the real bank/GCash account before approving a submission.

## Troubleshooting

- Vercel sign-in: expected privacy gate; use an authorized NACKY account.
- API 503: missing runtime variables or administrative key for invitations/mail.
- API 403: wrong workspace/role or request origin; use the exact deployment hostname.
- "This page was opened from a different address than the app expects" (formerly "Request origin is not allowed"): every form POST must come from exactly `APP_ORIGIN`. On Vercel, set `APP_ORIGIN` in each deployment's environment to the exact URL users open (for example the project domain, `https://<project>.vercel.app`, with no trailing slash), then redeploy. Opening a different alias of the same deployment, such as the per-deployment URL instead of the project domain, gives this error. If `APP_ORIGIN` is unset, the app falls back to `https://$VERCEL_URL`, the per-deployment URL, so visitors on the project domain always fail; the function log warns once when this happens. Supabase Auth's redirect allowlist must also include `<APP_ORIGIN>/api/auth/callback`. Locally, `npm start` prints the address to open and redirects pages opened on another host or port to it.
- Setup link expired: generate a new one; never weaken Auth or RLS.
- Public demo signup/recovery denied: intentional; existing demo recovery uses the seed workflow. Staff-assisted paid-first registration is supported.
- Camera unavailable: HTTPS and browser permission are required; use the image-upload fallback.
- Notification unconfigured: configure server environment, not client-side Gmail fields.


## RepReady automatic invitations and plan privileges

The paid-first flow below supersedes registration-time invitations and manual setup-link handoff. The current setup mail uses `supabase/templates/recovery.html`, with selected plan, database privileges, dates and a set-password button. Setup tokens are never returned to staff or written to notification tables. Configure Supabase Auth SMTP and the exact APP_ORIGIN + `/api/auth/callback`; a successful provider request does not guarantee inbox delivery. No hosted configuration is automatically changed by editing this checkout.

Local invitations use the configured template after `supabase stop` / `supabase start` (never use --no-backup or db reset to reload settings). Local emails are captured at http://localhost:54324, not delivered to real inboxes. The local callback is http://localhost:4173/api/auth/callback.

Payment emails still use the server-side Gmail notification queue. They now include membership dates, plan privileges, a member-pass page link and payment instructions. Partial payments explicitly explain that full payment is required. Gmail sender configuration is independent of Supabase Auth SMTP. Demo PayMongo confirmation is implemented as described below; demo Gmail sends remain suppressed.

Plan privileges come from ff_plans.features, which already exists in the database. Both registration and My membership use these values. Existing feature lists are the initial content; no machine-specific entitlements have been invented. Feature descriptions communicate entitlements, rather than enforcing physical equipment access.

Verification: `npm run test:onboarding` uses the installed Edge browser and local Supabase only. It checks always-visible plan privileges, captured invitation content, the real setup link, password creation and unpaid-pass denial; its temporary member records are removed afterward. `npm run test:auth` now also refuses hosted projects because it sends invitation emails.


## Paid-first onboarding (supersedes registration-time invitations)

Apply `supabase/migrations/20261001184643_paid_first_registration.sql` to the target database before deploying this version. It adds `ff_registrations`, RLS-protected staff RPCs and a paid-registration branch in Auth provisioning. Existing members, invoices and payments are retained. The local database was updated using transactional SQL; the hosted project has not been changed. Review migration history before a local db push; do not replay this manually applied schema migration over existing objects.

First registration is staff-assisted. POST /members saves pending details and a plan-price snapshot, with no Auth user or email. POST /registration-payment records the full verified cash amount in the pending registration, then creates a member account whose provisioning trigger atomically creates the paid cycle, invoice and one payment. Staff must verify the email address before cash confirmation. Cash payment is preserved if account creation fails; use the pending-registration completion action to retry without charging again. The completed account is emailed a password-setup link through Supabase Auth recovery mail. No permanent password or setup token is returned to staff. An uncertain email send requires delivery review before a manual retry.

Install `supabase/templates/recovery.html` as the hosted Supabase Reset password template, configure Auth SMTP, and allow the exact APP_ORIGIN + `/api/auth/callback`. Disable public Auth signup in the hosted dashboard, matching local `[auth].enable_signup = false`. The app's public /signup endpoint is disabled, and the provisioning trigger rejects member data without a trusted workspace claim. Account setup uses the existing recovery callback without PKCE. Existing members can still recover passwords and sign in. Local recovery mail is captured at http://localhost:54324.

Staff Renewals & payments offers Walk-in renewal: select an existing enabled member, select the next plan/start date, verify full cash, then atomically create and pay one cycle. Idempotent retries do not create another cycle or payment. The current cycle is preserved, overlapping dates are rejected, and the UI defaults to after the last cycle. Existing unpaid invoices can still be settled separately. Member My membership continues to create the next cycle/plan-change invoice for self-payment. Demo PayMongo uses automatic verified settlement; existing manual GCash/bank submissions still require administrator verification. Neither recurring charges nor prorated mid-cycle upgrades are introduced.

Run `npm run test:onboarding`, `npm run test:registration` and `npm run test:auth` against the local stack. They use temporary fixture accounts/registrations and captured email, and clean up their fixtures. The first suite covers cash collection through the actual staff UI, emailed password setup, a paid live pass and future walk-in renewal; the resilience suite covers account collisions, durable payment and explicit email retries.

## PayMongo demo e-wallet and card payments

Use [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md) as the current setup and verification guide. Apply missing dependencies in order, including `20261001213203_paymongo_demo_hardening.sql` and then the additive correction `20261002033541_paymongo_test_workspace.sql`. The correction removes the old demo-workspace restriction while retaining non-live checkout enforcement and all financial checks. Earlier migrations are unchanged. Only the local schema was updated; review and align migration history before a database push because local transactional SQL does not record migration versions automatically.

PayMongo requires a test key, a webhook secret, at least one supported method and `PAYMONGO_ALLOW_LIVE=false`. TEST MODE means `sk_test_`; it works in either the production-named or demo workspace. Keep `APP_WORKSPACE` matching the existing accounts; do not change it to enable payments. Live keys, live requests and live resources are rejected. GCash, Maya, GrabPay and cards are rendered from the backend allowlist. The separate `initiateOnlinePayment` capability allows staff to start registration, walk-in renewal and invoice checkouts, and members to start their own invoice checkouts. Database role and ownership checks still authorize each transaction; settlement remains service-only. Cash and manual transfer submissions retain their existing workflow. No public PayMongo key is needed for hosted checkout.

The supplied demo webhook is https://repready-gym.vercel.app/api/paymongo/webhook. An anonymous POST currently reaches the application and returns 503 with missing webhook configuration; it does not redirect to Vercel Authentication. The new local code is not deployed. Configure a TEST `checkout_session.payment.paid` webhook, server-only environment variables, Supabase recovery template and Auth callback before the developer deploys. Keep existing Deployment Protection settings; the report documents a private automation bypass only if protection later blocks POST requests.

The integration uses one durable `ff_checkouts` record per open target, raw-body HMAC verification, exact test-mode PHP amount/source checks, unique provider IDs and atomic service-only database settlement. Browser returns never prove payment. Creation timeouts remain reviewable; administrators recover the existing session by its internal reference instead of creating another charge opportunity. Notifications follow successful settlement, and delivery failure never erases payment. Real provider checkout, webhook delivery and inbox receipt remain manual test steps.
