# Migration notes

## Inspection and checkpoint

The original project used a Cloudflare Worker, D1 JSON records, Sites owner headers, and SMTP sockets. A Git checkpoint (`d7a910e`) and branch `migration/vercel-supabase` preserve the original implementation. Existing assets, QR licenses and private Sites deployment were retained.

Read-only inspection of the actual Sites D1 database found zero members, invoices, payments, submissions, check-ins, settings, outbox records and accounts. No business records or passwords required transfer. The existing Supabase project had an empty public schema and no Auth users before this work. No new Supabase project was created.

## Runtime and file changes

- Cloudflare `src/worker.js` and `src/mail.js` were moved to `legacy/sites/`; original platform tests to `legacy/tests/`. They are preserved for review but excluded from active runtime and deployment.
- Node API, Supabase cookie sessions, RLS-backed commands and Nodemailer replace D1, owner-header login and Cloudflare socket APIs.
- Removed active frontend demo seed/payment simulation bodies; retained the existing visual design and QR assets/licenses.
- Build script now copies static files and validates the exact build directory before cleaning it. Vercel routes `/api/*` to the Node function.
- `.openai` remains for the untouched legacy deployment and is excluded from the Vercel/source distribution.
- The temporarily installed Vercel CLI was removed from application dependencies after it introduced dependency advisories. Deployment scripts use the authenticated REST API. Current npm dependency audit is clean.

## Database and account transition

Local migration versions were aligned with the authoritative timestamps assigned by the connected migration tool; `supabase db push --dry-run` confirms no pending migrations. No remote migration history was rewritten.

Three migrations create namespaced `ff_` records, private security functions, RLS, foreign keys, exact centavo accounting, private Storage policies, and deferred Auth provisioning. Permissions derive from protected database records, never user-editable metadata. Mutations validate sessions and roles, and serialize payment approval/reference use. Existing sessions can be revoked immediately.

Auth administration was observed setting trusted metadata after its initial INSERT. Provisioning therefore runs at transaction completion and reads the final user row. A narrowly scoped repair moved only the three newly generated demo fixtures into demo and removed the erroneous unpaid demo administrator invoice. No real customer data was deleted. A temporary tightly scoped seed Edge Function was retired to a 410 response immediately after creating the three supported Auth accounts; no elevated credential was returned or stored in source.

If a later D1 export contains records, do not assume this empty-source result still applies: freeze writes, export business tables to a restricted local file, run `node scripts/validate-d1-export.js <file>`, reconcile counts/centavo totals and references, map legacy IDs to supported Auth invitations in a staging transaction, and verify before cutover. The validator is non-mutating; it is not an automatic importer. Do not copy legacy password hashes, sessions or owner headers. Preserve the source and rollback mapping until reconciliation is accepted.

## Privacy incident and current protection

The first REST deployment omitted `target`, which unexpectedly selected production. The initial Standard Protection setting did not cover its production aliases. Cancellation arrived after READY. Within approximately a minute, protection was changed to **all deployments**, and all known URLs were checked anonymously and redirected to Vercel sign-in. During that interval the static shell may have been accessible; production runtime credentials were absent, so the API was unconfigured. Visitor access during that interval has not been established. This was an unintended exposure risk, not an authorized public release.

The replacement deployment explicitly targets `staging`. Scripts now require all-deployment protection before uploading. Production aliases remain protected. Temporary verification access is revoked after tests; no share token is distributed. The original Sites deployment was never altered or deleted.

## Rollback and limitations

Keep the original private Sites deployment as the rollback reference. Do not delete Supabase records during rollback. Once real data exists, reconcile any post-cutover changes before returning traffic to an older backend. Vercel can restore a previous protected deployment, but database changes require a reviewed forward repair or backup restoration, never `db reset`.

Real Auth invitation setup and password recovery have been tested without sending mail. Live signup/recovery email, owner Gmail delivery and actual payment QR images require owner configuration. The current app deployment is an isolated demo. Physical camera hardware has not been tested. Supabase leaked-password protection is disabled. See TEST_RESULTS.md for precise verification status.
