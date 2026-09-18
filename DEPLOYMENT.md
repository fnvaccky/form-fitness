# Private deployment and owner setup

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

Auth URL configuration has been applied and verified, and Supabase now enforces a 12-character minimum password. For future changes, in Supabase Authentication > URL Configuration, set the Site URL to the exact protected deployment used for real accounts. Add exact callback URLs (avoid wildcard domains):

- `http://localhost:4173/api/auth/callback`
- `http://localhost:4173/api/auth/callback?next=recovery`
- `https://form-fitness-1rrt0d886-achillespasuncion-2666.vercel.app/api/auth/callback`
- `https://form-fitness-1rrt0d886-achillespasuncion-2666.vercel.app/api/auth/callback?next=recovery`

Configure Supabase's own Auth email provider for confirmation/recovery. This is separate from the application's Gmail notification sender. Confirm email confirmation and recovery on an address you control. Enable leaked-password protection if available on the account; the security advisor currently reports it disabled. New deployment hostnames require new exact callback allowlist entries. A recipient also needs authorized Vercel access while protection is enabled.

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
- Setup link expired: generate a new one; never weaken Auth or RLS.
- Demo registration/recovery denied: intentional; reset through the seed script.
- Camera unavailable: HTTPS and browser permission are required; use the image-upload fallback.
- Notification unconfigured: configure server environment, not client-side Gmail fields.
