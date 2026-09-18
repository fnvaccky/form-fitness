# FORM Fitness

Private gym membership management with the original responsive interface, a Node.js API on Vercel, and Supabase PostgreSQL, Auth and private Storage.

The protected demonstration is at https://form-fitness-1rrt0d886-achillespasuncion-2666.vercel.app . Sign into the authorized NACKY Vercel account first, then use a FORM demo account. See [DEMO_ACCOUNTS.md](DEMO_ACCOUNTS.md). This is a demo workspace; public signup, recovery email and outbound notifications are disabled there.

## Architecture

- `public/`: existing HTML, CSS, JavaScript and licensed QR libraries.
- `api/index.js` and `src/api.js`: Vercel Node function; local equivalent in `src/dev.js`.
- `src/supabase.js`: HttpOnly cookie sessions and separately scoped administrative client.
- `supabase/migrations/`: versioned PostgreSQL schema, RLS, atomic commands and Auth provisioning.
- `src/notifications.js`: server-only Gmail SMTP queue sender.
- `legacy/`: original Cloudflare Worker, socket sender and tests retained for migration review, excluded from deployment.

Persistent features include profiles, plans, membership cycles, invoices, partial payments, receipt review, signed member passes, check-ins, dashboards and notification records. Prices and payment balances use integer centavos. Staff must verify funds and identity; submitting a receipt or scanning a QR never pays an invoice automatically.

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

Do not overwrite an existing `.env.local`. Supply the existing project's publishable key, exact `APP_ORIGIN=http://localhost:4173`, and `APP_WORKSPACE=demo` for the prepared demo. Open http://localhost:4173 . The Supabase project is **form-fitness**, reference **ivxbrhqqfgmhfpgpauzh**. Do not create a replacement project.

A server-only Supabase secret is needed for production account invitations, demo seeding and Gmail queue processing. Normal member/admin application operations use session-scoped RLS. Never put server credentials in `public/`, Git or browser settings.

## Verification and delivery

```powershell
npm run test:integration
npm run test:auth
npx playwright install chromium
npm run test:browser
npm run package:source
```

Auth tests require the server secret and create/remove temporary clearly labeled Auth fixtures without sending email. Integration tests require `APP_WORKSPACE=demo` and the restricted local credential file. They write clearly labeled sample records. Database tests run inside a rollback transaction using `tests/database.sql`. See [TEST_RESULTS.md](TEST_RESULTS.md) for performed checks and limitations.

Deployment and owner setup: [DEPLOYMENT.md](DEPLOYMENT.md). Data preservation and rollback: [MIGRATION_NOTES.md](MIGRATION_NOTES.md). Source archive: `artifacts/form-fitness-source.zip`.
