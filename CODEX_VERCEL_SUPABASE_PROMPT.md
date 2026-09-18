# Codex task: migrate my gym system to NACKY Vercel and Supabase

Work on the gym membership project opened in this workspace. Implement the changes, run meaningful tests, fix failures, and provide the finished source and deployment instructions. Preserve the existing polished design and working features.

## 1. Inspect first and choose the correct accounts

- Read the repository instructions and inspect the complete project, dependencies, routes, database code, and deployment configuration before editing.
- I want to use **NACKY's Vercel account/team**. Verify the authenticated account, team ID, and target project. Do not assume another connected account belongs to NACKY. If NACKY is not accessible or the target is ambiguous, ask me to select/connect it; continue safe local preparation meanwhile.
- Supabase is connected in ChatGPT, but verify whether this Codex session actually has access. Identify the intended project and inspect its existing schema before making changes. Do not create a duplicate database or overwrite unrelated tables. Ask for the intended project if ambiguous.
- Connecting an account to ChatGPT does not automatically configure this application's runtime environment.
- The existing version was built for Sites with a Cloudflare Worker, D1, Sites owner authentication, and Cloudflare SMTP sockets. Inspect the actual files and migrate these platform dependencies properly; adding configuration alone is insufficient.

## 2. Clean up safely

- Create a Git checkpoint or isolated migration branch and preserve uncommitted user work.
- Remove only files, packages, obsolete demo code, and old platform configuration proven unnecessary after migration. Check imports, build scripts, runtime usage, tests, and license requirements first.
- Preserve required assets, QR libraries and licenses, documentation, migrations, meaningful tests, and existing data.
- Do not delete databases, reset production data, or remove the existing private Sites deployment.
- Document each significant removal and why it is safe.

## 3. Add Vercel support

- Use the simplest suitable architecture for this repository; avoid an unnecessary framework rewrite.
- Add valid Vercel configuration where needed, working frontend/API routing, and compatible server functions.
- Replace Cloudflare-specific runtime APIs and the Sites identity-header admin login with supported equivalents. Never trust a client-supplied owner/admin header.
- Provide working npm install/build/dev scripts and a lockfile, appropriate to the chosen stack, so I can run it from VS Code on Windows.
- Add .env.example with placeholders and descriptions. Ignore real environment files. Keep secrets out of source, browser bundles, logs, screenshots, and downloadable ZIPs.
- Configure the selected Vercel project's environment and Supabase authentication URLs for the actual protected deployment and local development.

## 4. Integrate Supabase

- Use Supabase PostgreSQL for persistent application data and Supabase Auth for signup, login, logout, password recovery, and sessions.
- Use the existing appropriate schema where available; add versioned, non-destructive migrations for missing tables, relationships, indexes, constraints, and access policies.
- Support members/profiles, roles, plans, memberships, invoices, payments, payment submissions, check-ins, settings, and notification delivery records as needed by the current app.
- Enforce admin/customer permissions on the server and with Row Level Security. Customers must access only their own allowed records. Prevent self-assignment of administrator roles.
- Keep elevated Supabase credentials server-only and minimize their use. Store uploads in appropriately restricted Storage buckets with scoped or signed access.
- Enforce authoritative plan pricing, unique payment references, atomic payment approval, idempotency, and protection against overpayment and concurrent duplicate requests.
- Use integer centavos or an exact numeric money type, never floating-point accounting.
- If existing D1 data needs migration, provide and validate a safe transfer strategy; do not silently discard records. Plan existing-account transition without exposing or copying incompatible password hashes into Supabase Auth.

## 5. Preserve and complete the core workflows

- Dashboard: real member counts, revenue, balances, renewals, and recent activity.
- Registration: require name, valid email, valid Philippine mobile number, password, membership plan, and valid start date. Block progression until required contact information is complete. Validate on the server as well as in the browser.
- Memberships: validate actual plan IDs, availability, authoritative prices, dates, activation, expiry, and renewal behavior. Do not present a preview as a completed renewal.
- Admin: create member accounts securely, manage members and plans, and review payment submissions. Use invitations or password setup links instead of exposing permanent customer passwords.
- Payments: display the owner's actual configured GCash/bank QR images, accept transaction references and optional receipts, and let authorized staff approve after verifying funds. QR display/scanning and receipt submission must not automatically mark a payment paid. Do not invent payment QR codes.
- Member QR: retain short-lived signed passes, expiry and replay prevention, staff identity confirmation, camera scanning, and image-upload fallback. Reject inactive, unpaid, expired, or tampered passes.
- Gmail notifications: preserve registration, payment confirmation, and check-in notifications through a Vercel-compatible server-side sender. Protect sender credentials, show queued/sent/failed or uncertain states, and avoid duplicate sends. Distinguish SMTP acceptance from confirmed inbox delivery. Clearly report if Gmail setup is missing; do not claim live delivery was tested without evidence.
- Provide useful loading, empty, success, and error states; retain responsive desktop/mobile layouts.

## 6. Create real demo admin and customer accounts

- Seed one demo administrator and one demo customer in an isolated demo/test environment, using supported Supabase Auth administration methods and an idempotent seed script.
- These must be real working accounts, not frontend-only mock logins or authentication bypasses.
- Use configurable demo email addresses and strong generated passwords supplied via a secure local setup mechanism. Do not use another person's email or send invitations to invented addresses.
- Create clearly labeled sample membership/payment records sufficient to demonstrate the customer dashboard, an active QR pass, and a pending payment review. Disable real outbound notifications for sample data.
- Verify both accounts can sign in/out and enforce different permissions. Add a second test customer to prove data isolation if needed.
- Keep passwords out of Git, README files, ZIPs, and production logs. Explain how I retrieve/reset the credentials securely. Never enable a shared demo admin in a production environment containing real member data.

## 7. Verify before declaring success

Run build/type/lint checks applicable to the stack and meaningful API/database/browser tests. Test:

1. Missing/invalid contact information and invalid membership plans are rejected.
2. Signup, login, logout, session restoration, password recovery, and admin-created member onboarding.
3. Demo admin/customer login and server-side role enforcement, including direct unauthorized API requests and cross-customer access.
4. Persistence across reloads and sessions, and RLS enforcement.
5. GCash/bank QR display, submission, approval/rejection, partial payment, duplicate references, overpayment, and concurrent approval attempts.
6. Valid, expired, tampered, replayed, unpaid, and inactive member QR passes, plus staff identity confirmation and scanner fallback.
7. Gmail queue behavior and delivery status; live sending only to an authorized test recipient when configured.
8. Dashboard totals, mobile layout, navigation, empty/error states, and browser console errors.
9. The actual deployed frontend-to-API-to-Supabase flow, with protected access still enforced.

Report actual commands and results. Separate passed checks, failures, and checks blocked by missing configuration. Fix failures rather than claiming everything works because the build passed. Do not claim physical-camera testing unless performed.

## 8. Write Markdown documentation

Create or update:

- README.md: architecture, features, requirements, and Windows/VS Code setup.
- DEPLOYMENT.md: exact steps for NACKY's Vercel team, Supabase migrations/Auth/Storage, environment variables, protected deployment, Gmail setup, payment QR setup, and troubleshooting.
- DEMO_ACCOUNTS.md: safe account creation/reset and class demonstration steps, without passwords or secret keys.
- MIGRATION_NOTES.md: changed/removed files, schema changes, data/account transition, rollback, and any unresolved limitations.
- TEST_RESULTS.md: checks performed, results, and remaining manual checks.

## 9. Deploy privately and deliver

- Preserve my existing instruction: **do not publish publicly without my approval**.
- Verify deployment protection is available and enabled on the selected NACKY Vercel project before deployment. A preview URL or an application's login page alone does not prove the deployment is private.
- If private deployment is supported, deploy to the verified target, test it, and give me the working protected URL and access instructions.
- If protection requires a plan change, payment, or public exposure, finish the code, tests, and configuration first, then explain the specific blocker and ask for my decision. Do not change plans or expose the app automatically.
- Provide the final source ZIP without dependencies, build caches, secrets, or private member data. Summarize what changed, what was verified, how to use the demo accounts, and any remaining owner setup.
- Finish with a short prioritized list of useful improvements. Complete this migration before adding unrelated features.
