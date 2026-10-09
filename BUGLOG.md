# Bug log

Bugs Clark reports while testing by hand, one entry per bug, numbered in report order. Statuses: `fixed`, `config`, `cannot-reproduce`, `needs-decision`, and `noticed` for things spotted along the way but not reported. The two noticed items were first logged as BUG-002 and BUG-003; they were renumbered so that BUG-002 matches the reset-link bug as Clark and the planner refer to it.

## BUG-001: "Request origin is not allowed" on Reset password   (status: config)
Reported: 2026-10-10 by Clark. Where: deployed Vercel site, sign-in screen → Reset your password → Send recovery link, role: signed out
What happened: The form showed "Request origin is not allowed." and the console showed `POST /api/recovery 403`. Any other form would fail the same way.
Root cause: `src/api.js:57` (`handle`) rejects every POST whose `Origin` header differs from `APP_ORIGIN`. That is correct CSRF protection and stays strict. On Vercel, `APP_ORIGIN` is unset or set to a different address. When it is unset, `src/supabase.js:8` (`configuration`) falls back to `https://$VERCEL_URL`, the per-deployment URL rather than the project domain people open, so every POST from the project domain fails. Reproduced locally on `clark-changes` by opening `http://127.0.0.1:4173` while `APP_ORIGIN=http://localhost:4173`. `origin/main`, which the deployed site may be running, has the identical check (`src/api.js:49`) and fallback, so both branches behave the same.
Fix: config change the project owner must make. In Vercel, set `APP_ORIGIN` to the exact URL testers open, with no trailing slash, and redeploy. Supabase Auth's redirect URLs must include `<that URL>/api/auth/callback`. Code improvements in `d735b69`: a clearer 403 that names the expected address, a local dev-server redirect to `APP_ORIGIN`, a startup hint with a port-mismatch warning, a one-time Vercel warning when the `VERCEL_URL` fallback is used, and a `DEPLOYMENT.md` troubleshooting entry. The deployed site only gets these after it is redeployed from this code.
Test added: `tests/unit.test.js`: "a mismatched origin is still refused with 403 and told which address to open" (also checks that a matching origin passes), "on Vercel without APP_ORIGIN, the VERCEL_URL fallback is logged once", and "the local dev server sends pages opened on another host to APP_ORIGIN, but never API calls".
Update 2026-10-10: Clark reports it resolved on Vercel after the configuration change. The live site turned out to run `clark-changes`-era code, not `main` (see BUG-002).

## BUG-002: Reset password link shows "This link is not valid"   (status: config)
Reported: 2026-10-10 by Clark. Where: deployed site https://repready-gym.vercel.app, the link in the password-reset email, role: signed out
What happened: Opening the reset link from the email showed a page saying "This link is not valid".
Root cause: The hosted Supabase "Reset password" email template is still Supabase's default. Its link goes through Supabase's `/auth/v1/verify` and returns to `/api/auth/callback?code=…` (PKCE), but the callback in `src/api.js` (`GET /api/auth/callback`, the `!tokenHash` check) only accepted our templates' `token_hash` + `type`, so a `?code=` link fell through to "This link is not valid". That page exists only on `clark-changes`; `origin/main`'s callback does a code exchange with a JSON error instead. So the live site runs `clark-changes`-era code. Reproduced against the real local GoTrue: the default template's link built from a Mailpit email came back with `?code=` and no `token_hash`.
Fix: config change Clark is making. Install `supabase/templates/recovery.html` as the hosted Reset password template (`DEPLOYMENT.md` lines 49–54); its links carry `token_hash` and work on any device. Code hardening in `98179ba`: when the callback gets `?code=` without `token_hash`, it tries `exchangeCodeForSession`. That succeeds in the browser that requested the email, because the verifier cookie is there, and redirects to `/#/set-password`. Otherwise it shows the "expired or already used" page with the added sentence "If you opened this on a different device, open it on the device where you requested it, or request a new link." The live site gets this on its next deployment.
Test added: `tests/unit.test.js`: "a ?code= reset link opened in the requesting browser signs in through the PKCE exchange" and "a ?code= link opened without the requesting browser's verifier fails with the expired page and a device hint". Also a one-off manual check against the real local GoTrue and Mailpit, using a temporary user that was then deleted: other device gave 400 with the hint, same browser gave 303 to `/#/set-password` with an HttpOnly session cookie.

## BUG-003: Integration test will soon fail its renewal step   (status: noticed)
Noticed: 2026-10-10 by Claude, while running `npm run test:integration` (demo workspace). Not reported by Clark.
What happened: Nothing has failed yet. Each run that finds no unpaid invoice renews the second demo customer one cycle further ahead. That customer now has 7 memberships, the latest ending 2027-05-07.
Root cause: `tests/integration.js` (the renewal for the second account) always renews after the latest cycle. After about 5 more runs, the next start date passes the 365-day limit in `ff_private.new_membership` and the step fails.
Fix: none yet; needs a decision. Either the test stops renewing when a future cycle already exists, or the demo customer's future cycles are cleaned up periodically.
Test added: none.

## BUG-004: `.env.local` defines each DEMO_* email twice   (status: noticed)
Noticed: 2026-10-10 by Claude. Not reported by Clark.
What happened: `.env.local` has empty `DEMO_ADMIN_EMAIL`, `DEMO_CUSTOMER_EMAIL` and `DEMO_SECOND_CUSTOMER_EMAIL` lines (18–20) and filled copies further down (26–28). Node uses the last occurrence, so it works, but a reader or a tool that takes the first occurrence sees empty values.
Root cause: configuration file, not code.
Fix: config change Clark can make: delete the three empty lines 18–20 in `.env.local`. Nothing was changed by Claude.
Test added: none.
