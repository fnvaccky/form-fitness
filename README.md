# FORM Fitness

Private gym membership management with the original responsive interface, a Node.js API on Vercel, and Supabase PostgreSQL, Auth and private Storage.

The demo domain supplied for payment setup is https://repready-gym.vercel.app. An earlier probe found its webhook reachable but unconfigured; this local correction has not been deployed or rechecked there. The current local production-named workspace reports PayMongo TEST MODE configured with all four default methods. See [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md) for setup and verified results. Public signup and public demo recovery remain disabled; staff-assisted paid-first registration sends an account setup link. Demo Gmail notifications remain suppressed. The older protected FORM preview described in DEPLOYMENT.md is a separate historical deployment.

## Architecture

- `public/`: existing HTML, CSS, JavaScript and licensed QR libraries.
- `api/index.js` and `src/api.js`: Vercel Node function; local equivalent in `src/dev.js`.
- `src/supabase.js`: HttpOnly cookie sessions and separately scoped administrative client.
- `supabase/migrations/`: versioned PostgreSQL schema, RLS, atomic commands and Auth provisioning.
- `src/notifications.js`: server-only Gmail SMTP queue sender.
- `src/paymongo.js`, `src/paymongo-config.js` and `api/paymongo-webhook.js`: test-only hosted checkout, raw signed webhooks and provider reconciliation using the existing `ff_checkouts` table. PayMongo test mode is independent of the application's workspace name.
- `legacy/`: original Cloudflare Worker, socket sender and tests retained for migration review, excluded from deployment.

Persistent features include profiles, plans, membership cycles, invoices, partial payments, receipt review, signed member passes, check-ins, dashboards and notification records. Prices and balances use integer centavos. Staff verify cash and identity; administrators review manual transfer submissions. PayMongo test payments settle automatically after signed provider verification. A receipt, QR scan or checkout return URL never proves payment by itself.

Administrators manage staff accounts in **Members & plans → Staff**: add (a password setup email follows), edit name and mobile, disable or enable, and resend the setup link. See `DEPLOYMENT.md` → Staff accounts. `scripts/create-staff.js` is only for converting an existing Auth account on the hosted project.

## Windows and VS Code

Install Node.js 24 LTS and open this folder in VS Code. Run in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env.local
code .env.local
npm run check
npm run build
npm test
npm run dev
```

Do not overwrite an existing `.env.local` or change its workspace to enable PayMongo. Supply the existing project's publishable key and exact `APP_ORIGIN=http://localhost:4173`; keep the workspace matching the existing accounts. Prepared sample accounts use the demo workspace, while the current local project uses the production-named workspace with PayMongo TEST credentials. Open http://localhost:4173 . The Supabase project is **form-fitness**, reference **ivxbrhqqfgmhfpgpauzh**. Do not create a replacement project.

A server-only Supabase secret is needed for production account invitations, demo seeding and Gmail queue processing. Normal member/admin application operations use session-scoped RLS. Never put server credentials in `public/`, Git or browser settings.

## Verification and delivery

```powershell
npm run test:integration
npm run test:auth
npm run test:paymongo
npx playwright install chromium
npm run test:browser
npm run package:source
```

Auth/onboarding tests require local Supabase and use captured local email, not a real inbox. PayMongo tests generate temporary accounts in the production-named local workspace, intercept all provider calls, and verify local database behavior plus Edge forms; they never contact PayMongo. General integration/browser suites require demo configuration and the protected local demo credential file. Database tests run in rollback transactions using `tests/database.sql`, `tests/paid-first.sql` and `tests/paymongo-demo.sql`. See [TEST_RESULTS.md](TEST_RESULTS.md) for performed checks and limitations.

Deployment and owner setup: [DEPLOYMENT.md](DEPLOYMENT.md). Data preservation and rollback: [MIGRATION_NOTES.md](MIGRATION_NOTES.md). Source archive: `artifacts/form-fitness-source.zip`.
