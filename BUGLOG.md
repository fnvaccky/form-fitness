# Bug log

Feature entries (`FEATURE-nnn`) record planned work, with status `built` until it is released and `released` after.

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

## BUG-003: Integration test will soon fail its renewal step   (status: fixed)
Noticed: 2026-10-10 by Claude, while running `npm run test:integration` (demo workspace). Not reported by Clark.
What happened: Nothing has failed yet. Each run that finds no unpaid invoice renews the second demo customer one cycle further ahead. That customer now has 7 memberships, the latest ending 2027-05-07.
Root cause: `tests/integration.js` (the renewal for the second account) always renews after the latest cycle. After about 5 more runs, the next start date passes the 365-day limit in `ff_private.new_membership` and the step fails.
Fix: none yet; needs a decision. Either the test stops renewing when a future cycle already exists, or the demo customer's future cycles are cleaned up periodically.
Test added: none.
Update 2026-10-10 (Task 06): one more run. The customer now has 8 memberships, the latest ending 2027-06-06, so about 4–5 runs remain at today's date.
Update 2026-10-13 (Task 13B): the step now fails locally. The isolation customer has 13 memberships, the latest ending 2027-11-03, so the next start is more than a year away: "/renew: Choose a valid start date within the next year." Run without that renewal section, the suite's other 11 checks pass. It still needs a decision. Cleaning up means deleting that local customer's future cycles, invoices and payments, so Claude hasn't done it.
Decision 2026-10-13 (Clark): change the test so it doesn't renew when a future cycle already exists, and don't delete the local data.
Fix (`tests/integration.js`):
- **Renewal:** the test renews the isolation customer only when that customer has no unpaid invoice and no future cycle.
- **Cross-customer check:** it now uses any of that customer's invoices, so it runs every time. Ownership is checked before any payment rule, so a paid invoice works too.
- **Payment steps:** without an unpaid invoice, the receipt, approval, overpayment, rejection and full-payment steps print a SKIP line instead.
- **Locally:** the steps stay skipped until the isolation customer's last future cycle starts (about October 2027). The database suite still checks those payment rules.
Verified locally: 12 checks pass and one SKIP line, and the customer still has 13 cycles afterwards.

## BUG-004: `.env.local` defines each DEMO_* email twice   (status: noticed)
Noticed: 2026-10-10 by Claude. Not reported by Clark.
What happened: `.env.local` has empty `DEMO_ADMIN_EMAIL`, `DEMO_CUSTOMER_EMAIL` and `DEMO_SECOND_CUSTOMER_EMAIL` lines (18–20) and filled copies further down (26–28). Node uses the last occurrence, so it works, but a reader or a tool that takes the first occurrence sees empty values.
Root cause: configuration file, not code.
Fix: config change Clark can make: delete the three empty lines 18–20 in `.env.local`. Nothing was changed by Claude.
Test added: none.

## BUG-005: Every online payment on the old live code went to review   (status: noticed)
Noticed: 2026-10-10 by Claude, during Task 06's read-only checks on live. Not reported by Clark.
What happened: All six live PayMongo checkouts (production workspace, created 2–9 October; one for a registration, five for invoices) are `needs_review` with reason `checkout_reference_mismatch`. None was bound to its PayMongo session or paid. An open checkout blocks its target (`ff_private.guard_open_checkout`), so that registration and those five invoices can't be paid online, in cash or by receipt until each checkout is resolved.
Root cause: the old Production code (`c550f1c`) ran the full check, including `reference_number`, on PayMongo's V2 create response, which omits that field, so every checkout failed right after creation. `adaab3f` (Batch 01) checks the reference only on GET and webhook, and is live since the `ed44803` release. Read-only GETs of the six sessions with the local test key (same PayMongo account) show each one `active`, in test mode, with 0 payments and `reference_number` equal to its checkout id. So nothing was paid, and each passes the released check.
Fix: code already fixed (`adaab3f`, live). Each leftover row needs an administrator on the live site: Payments → Online payments in progress → Open / check → Recover existing checkout (the session ID is prefilled). That rebinds the session and makes the checkout `pending` and payable online; it creates and credits nothing. A `pending` checkout still blocks cash until it is paid or its PayMongo session expires. These are live writes, so they are Clark's call. Nothing was changed by Claude.
Update 2026-10-11: FEATURE-003 adds Cancel checkout for exactly this. Once it is released, Clark closes these six from the admin screen (Payments → Online payments in progress → Cancel checkout); Claude does not.
Test added: none new. `npm run test:paymongo` already covers "minimal V2 create without reference binds pending" and "saved-ID recovery strictly verifies GET". In Task 06, a real test-mode checkout created locally with the released code stayed cleanly `pending` after PayMongo's real GET, and a real GCash test payment settled as `paid`.

## BUG-006: No PayMongo webhook points at the live site   (status: fixed — config)
Noticed: 2026-10-10 by Claude, during Task 06's read-only checks. Not reported by Clark.
What happened: Nothing visible yet. A paid checkout is confirmed when the payer returns to the app while signed in, or when staff use Check payment status, but never on its own. A customer who pays on their own phone, or closes the tab before returning, stays `pending` until someone checks.
Root cause: configuration. The PayMongo account Production uses (the same account as the local test key, which can read the live checkout sessions) has one test webhook, created 31 August for a Supabase Edge Function on another project (`joffopwzqmlqpsrbivfq.supabase.co/functions/v1/paymongo-webhook`). None points at `https://repready-gym.vercel.app/api/paymongo/webhook`. Webhooks apply account-wide, so that other function also receives RepReady's payment events.
Fix: config change for whoever manages the PayMongo account. In the PayMongo dashboard, in test mode, add a webhook with the URL `https://repready-gym.vercel.app/api/paymongo/webhook` (the alias; per-deployment URLs require a Vercel login) and the event `checkout_session.payment.paid`. Put its secret key in Vercel's `PAYMONGO_WEBHOOK_SECRET` for Production (Sensitive), then redeploy Production so the new value is used. Disabling the old webhook is the owner's decision. Nothing was changed by Claude.
Test added: none. After the change, Claude can confirm it without writing anything: an event of an unknown type, signed with the new webhook's secret, should get 200 "ignored" from live (it returns before any database access), and a wrong secret gets 401.
Fixed 2026-10-12, with Clark's authorisation (PAYMONGO-WEBHOOK):
- **Key check:** the local test key is Production's PayMongo account. It read all 8 of Production's checkout sessions, each with our checkout id as `reference_number`, in test mode.
- **Webhook created:** test webhook `hook_g8r4iDzs3qYBDxt4NcBvx4z8`, for `https://repready-gym.vercel.app/api/paymongo/webhook` and `checkout_session.payment.paid`. The old webhook `hook_TWxEtwmnY4yNKcpPMMUyL4jo` (the other project's Supabase function) is unchanged.
- **Secret:** the new webhook's secret went straight from PayMongo's response into Vercel's Production `PAYMONGO_WEBHOOK_SECRET` (Sensitive), replacing the old value. It was never printed or saved.
- **Redeploy:** `vercel redeploy` worked this time, giving `dpl_DjpqLj7FCQtfR5i2yGT9VrspVvx1`, READY. `main` is unchanged.
- **Verified on live:** an unknown event type signed with the new secret gets 200 `{"ok":true,"ignored":true}`. Unsigned and wrong-secret posts get 401. Smoke tests pass, 17 of 17.
- **Tab-closed test: passed (2026-10-12).** Clark paid John Garcia's Momentum invoice with GCash (test) and closed the tab before returning.
  - Vercel's request log shows the checkout created at 14:15:02 UTC and PayMongo's `POST /api/paymongo/webhook` → 200 at 14:16:07. There was no `/api/paymongo/status` call at all.
  - The payment row (₱1,499, GCash, `reference_key` `PAYMONGO:pay_…`) was created at 14:16:09.706 UTC, the same instant the checkout became `paid`, inside that webhook request. The invoice is paid in full.
  - So the webhook alone recorded it.

## FEATURE-001: Staff management in the admin portal   (status: released)
Requested: 2026-10-10 by the planner (Task 08). Where: Members & plans → Staff, role: admin.
Why: The staff role existed, but the only way to make a staff account was `scripts/create-staff.js`, a command-line script that runs only against the hosted project and only converts an existing Auth account.
What changed: Administrators see every admin and staff profile in their workspace. They can add staff (a password setup email follows; the account stays if the email fails), edit name and mobile, disable or enable (disabling ends every session at once), and resend the setup link once per minute. Promotion, demotion and deletion are out of scope and not shown. Authorization lives in `ff_private.staff_admin` (migration `20261010140000_staff_management.sql`, with the `ff_staff_audit` trail) and is repeated with `admin()` in `src/api.js`. Accounts are created through the Auth admin API by `src/staff.js`, and the UI is `public/staff.js`. `supabase/templates/recovery.html` gained a branch for staff emails.
Test added: `tests/database.sql` (48 assertions), `tests/unit.test.js` (8 tests), new `tests/staff.js` (`npm run test:staff`, 6 groups), and a browser pass with screenshots in `test-results/`.
Live dependencies: the hosted Reset password template (reinstall the updated `recovery.html`) and custom SMTP. Without them, the account is still created and the app says "Account created; setup email needs a resend".
Released: 2026-10-10. The migration was pushed to live after Clark's "go", `main` was fast-forwarded to `ebd1c9c`, and Production deployment `dpl_BG7Jaj4DKAEkdBhkGZ8Qx3P8pexk` is READY. Smoke tests pass.

## BUG-007: The app's main font is Inter   (status: noticed — cosmetic, out of scope)
Noticed: 2026-10-10 by Claude, from a design-quality hook during Task 08. Not reported by Clark.
What happened: Nothing breaks. The hook flags Inter as an overused typeface that makes the interface feel generic.
Root cause: a design choice that predates Task 08. `--sans` in `public/styles.css` lists Inter first. No web font is loaded, so devices without Inter use the system UI font.
Fix: none, by Clark's decision. Changing the typeface is a visible design change that needs its own task.
Test added: none.

## BUG-008: The account setup email sets no type sizes   (status: noticed — cosmetic, out of scope)
Noticed: 2026-10-10 by Claude, from a design-quality hook during Task 08. Not reported by Clark.
What happened: Nothing breaks. The hook reports a flat type hierarchy in `supabase/templates/recovery.html`, with no clear size step between the headings and the body text.
Root cause: the template is plain HTML with no font sizes, so each email client decides. That predates Task 08, which only added the staff branch.
Fix: none, by Clark's decision. Styling it would need checks across email clients, plus another reinstall of the hosted template.
Test added: none.

## BUG-009: Reset email link showed the login page instead of password setup   (status: config)
Reported: 2026-10-10 by Clark. Where: the link in a password-reset email, role: signed out
What happened: The link opened `https://form-fitness-achillespasuncion-2666.vercel.app/?token_hash=…&type=recovery`, which is the wrong host and the root path, and the app just showed the login page. The email also greeted "Hello ," because the account had no name.
Root cause: Supabase Auth fell back to the Site URL instead of the requested redirect `https://repready-gym.vercel.app/api/auth/callback`, so `{{ .RedirectTo }}` became the old project domain's root. The app verified query tokens only at `/api/auth/callback`, so a root-path token was ignored. A callback on another host would also have set the session cookie on the wrong domain. The template printed `{{ .Data.name }}` without checking it.
Fix: config change Clark is making. Set Site URL to `https://repready-gym.vercel.app`; Redirect URLs must include `https://repready-gym.vercel.app/api/auth/callback`. Code hardening in `19cb899`:
- `public/auth-link.js` runs first. It forwards a `token_hash` link with an allowed type (recovery, invite, signup, email) from any path to `/api/auth/callback` before the sign-in page renders, and strips the token from history.
- `GET /api/auth/callback` on any host other than `APP_ORIGIN`'s answers 302 to `APP_ORIGIN` + `/api/auth/callback` + the same query, before verifying. The target is fixed, never taken from the request.
- The template greets "Hello," when there is no name. Re-paste `supabase/templates/recovery.html` into the hosted Reset password template.
Test added: `tests/unit.test.js`:
- "a token link on any path is forwarded to the callback and kept out of history";
- "the sign-in page never renders while a token link is being forwarded";
- "a callback opened on another host is redirected to APP_ORIGIN before any verification";
- "a callback on the APP_ORIGIN host still verifies as before";
- "the setup email greets an account without a name properly".
Also checked by hand locally:
- in a browser, a root-path token ends on the callback page with no sign-in form;
- `127.0.0.1` to `localhost` gives a 302;
- in Mailpit, a nameless account's email reads "Hello,".

## BUG-010: The same email could be added again as a member   (status: fixed)
Reported: 2026-10-10 by Clark. Where: Members & plans → Add member, and every other path that creates an account, role: admin or staff
What happened: Clark registered a real email, then added the same email again as a member, and the app allowed it. Clark's rule: one email, one account, across every role and every path.
Live data (read-only): today no email on live is used by more than one account, profile or registration in any letter case, and none would collide if Gmail dots and `+tags` were ignored. So the record behind the report couldn't be traced. The production Add member path already refused existing accounts and same-workspace registrations.
Root cause: the rule was spread across paths and incomplete.
- `ff_private.registration` (`20261001213203_paymongo_demo_hardening.sql:31`) refused a registration only in the same workspace, and its advisory lock (line 24) was per workspace. Reproduced locally: an email pending in production was accepted again in the demo workspace (201).
- Accounts created outside registrations never looked at pending registrations. That includes the Auth trigger `register_auth_user`, used by provisioning, `create-admin.js` and the seed scripts. Staff creation had its own check, in a separate transaction from `createUser` and without a lock.
- Nothing in the database backed the rule up. `ff_profiles` was unique only per workspace.
Fix: `9e100d0`, migration `20261010150000_email_uniqueness.sql`.
- `ff_private.claim_email` is the one shared rule. It refuses an email any Auth user, profile or registration uses, in any workspace, for any role and in any letter case, with "An account already uses this email."
- It is serialized by an advisory lock on the lower-cased email.
- Member registration, staff creation and the Auth trigger, which every new app account passes through, all call it.
- Backstops: a global unique index on `lower(email)` for `ff_profiles`, and a partial unique index on `lower(email)` for open registrations.
- Gmail dots and `+tags` are not normalized; they are different addresses, so that stays an option.
- Released 2026-10-10. After Clark's "go", the migration was pushed (live and local match in all 13 post-push checks), `main` was fast-forwarded to `6da0a63`, and Production deployment `dpl_5G3g2f2tjHqS6Ws2d9nVpuR63DKa` is READY. Smoke tests pass.
Test added: `tests/database.sql` (11 assertions) and the new `tests/email-uniqueness.js` (`npm run test:emails`).
- They cover every path, mixed case, the other workspace, the Auth trigger and both indexes, and confirm that normal registration and identical retries still work.
- Two simultaneous registrations, in one workspace or across both, create exactly one.
- Mutation checks: the old registration function, the old trigger and missing indexes each fail the matching assertion.

## BUG-011: Staff setup link said "This link expired or was already used" on first click   (status: fixed)
Reported: 2026-10-11 by Clark. Where: the link in a staff setup email (Supabase recovery email), role: new staff, signed out. At the same time, Google Safe Browsing started flagging `repready-gym.vercel.app` as phishing.
What happened: The first click on the setup link showed "This link expired or was already used".
Root cause: `GET /api/auth/callback` called `verifyOtp` on every GET (`src/api.js:102` before the fix), which uses up the one-time token. Link scanners (Google Safe Browsing, Gmail, Brave) open email links before the person does. So the scanner used the link and also received a valid recovery session for the account. Reproduced locally against the real GoTrue: a cookie-less "scanner" GET got 303 with a session cookie, and the person's click then got 400 "This link expired or was already used". The set-password screen (`passwordSetup` in `public/connected.js`) also verified a fragment token as soon as it opened, so a scanner that runs scripts would have used it up too.
Fix: `c9df15a`.
- `GET /api/auth/callback?token_hash&type` only redirects (303) to `/#/set-password?token_hash=…&type=…`. Browsers never send the fragment to a server or put it in a referrer. `?code=` still works in the browser that asked; a scanner without that browser's verifier cookie can't use the code up (checked against the real GoTrue).
- `public/auth-link.js` reads the fragment token once, before any other script, keeps it in memory and strips it from the address bar and history. The root-path forwarder still goes through the callback, so BUG-009's APP_ORIGIN forwarding still applies.
- **Save password** sends one `POST /api/auth/verify` with the token and the new password. The password rules are checked first, so a refused password leaves the link usable. Then the token is verified, the account passes the same gate as `/set-password`, the password is set and other sessions end.
- A used or expired link gets 410 "This link expired or was already used — request a new one." The screen shows that message with a **Forgot password** button. If the link worked but Auth refuses the password, the session is kept so the person can save again.
- Unchanged: the origin check on every POST, APP_ORIGIN host forwarding, no token in any HTML, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Released 2026-10-11. `main` was fast-forwarded to `292011f`, and Production deployment `dpl_4QaLSu3DG9agV5uSjcjCpV8VhHD5` is READY. Smoke tests pass, including a live browser run with a fake token through both the direct link and the old host's root path.
- The google-site-verification tag had not arrived, and Clark chose to release without it. It follows in a small release.
Test added: `tests/unit.test.js`:
- "the callback never verifies on GET: every token link moves to the set-password screen with the token in the fragment";
- "a scanned setup link still works: Save password verifies it and sets the password in one POST, once";
- "Save password refuses a bad request before the link is checked, so the link stays usable";
- "if the link worked but the password is refused, the person is signed in and can save again";
- "Save password reports a busy or unreachable Auth server as retryable, not as an expired link";
- "a callback on the APP_ORIGIN host moves to the set-password screen without verifying" (replaces BUG-009's "still verifies as before");
- "the set-password token is read from the fragment once, kept in memory and removed from the address bar";
- "the set-password screen checks the link only when Save password is pressed".
Also `tests/auth.js` (`npm run test:auth`, real local GoTrue):
- scanner GETs leave the link valid, and Save password then succeeds once;
- a second POST gets 410, no session and no password change;
- `?code=` still works in the browser that asked, even after a scanner tried the code;
- a Forgot password link (a PKCE token) works on another device.
And the new `tests/auth-links.js` (`npm run test:links`, Edge):
- a fetch scanner and two script-running scanners (on the link and on the root-path fallback) only reach the form;
- the person then saves a password and is signed in;
- the token appears in no address bar and no page, and in no request except the link itself and the Save password POST;
- the used link shows the expired message, and its button opens Forgot password.
Mutation checks: verifying on GET again, checking the password after verifying, 400 instead of 410, leaving the token in the address bar and verifying when the screen opens each fail a test.
Phishing check of the sign-in and set-password screens (no design changes):
- No form has an `action` or an external target. Every form posts with `fetch` to the same origin. Every script and stylesheet is first-party, and nothing loads from another site.
- No other brand is imitated. Both screens name RepReady (the tab reads "RepReady · Sign in").
- Two leftovers from the old FORM name: the favicon draws an "F" while the logo is an "R", and staff screens still say "FORM" in the scanner text and in export file names.
- `public/connected.js`, which every page loads, still contains an unused "Connect Gmail" form with a "Google app password" field and a link to `myaccount.google.com`. It is overridden and never rendered.
- At phone width the sign-in headline reads "chapterstarts here." because `public/connected.css:3` hides the line break.
Update 2026-10-11 (Task 09 Part A): all four leftovers are fixed, and the old-host redirect no longer carries Vercel's `__path`/`path`. Released 2026-10-11: `main` `fa106e1`, deployment `dpl_4kidicr36C18krzv4BHsZ9CCe7fY`.
- The favicon is the RepReady "R" mark, and there is an apple-touch-icon.
- The user-visible "FORM" strings are gone.
- The unused Gmail form and its Google link are gone.
- The phone headline has its space.
Follow-up released 2026-10-12: Clark's `google-site-verification` tag is in `public/index.html` exactly as given (commit `2db00c8`, with a unit test).
- The push deployment and one redeploy failed with Vercel's intermittent `git_info_fail`, which leaves no build log. The same commit built fine as a Preview at the same minute.
- A retried redeploy of `2db00c8` gave Production deployment `dpl_ENiwZ8bwsCKj3Q9rdu6GKwz5xuPJ`, READY.
- The live page carries the tag once, inside `<head>`. Smoke tests pass, 17 of 17.

## FEATURE-002: Password rule and show-password toggle   (status: released)
Requested: 2026-10-11 by Clark. Where: every screen that sets a password (Set your password from a setup or reset link, Change password, and the unused registration "Create password" field), plus the sign-in form, role: everyone.
Why: one clear password rule everywhere, guidance while typing, and a way to check what was typed.
What changed:
- **The rule:** 8–72 characters, with an uppercase letter (A–Z), a lowercase letter (a–z), a number and a keyboard symbol.
  - It is defined once, in `public/password-rule.js`. The server enforces it in `src/validation.js` (`password()`) with "Use at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol." The screens take their checklist from the same file.
  - The request said 8–128 characters, with any non-letter, non-digit character counting as a symbol. Checked against the real Supabase Auth: it refuses passwords over 72 characters (bytes). Its "symbols" setting counts only keyboard symbols (not a space, ₱ or ¡), and only A–Z counts as uppercase. Clark chose to match Supabase, so the checklist never approves a password Supabase refuses.
- **The eye button:** `public/password-fields.js`, one shared helper loaded on every page, puts an eye button in every password input.
  - The button is `type="button"`, reachable by keyboard, and its `aria-label` switches between "Show password" and "Hide password", with `aria-pressed`.
  - Showing or hiding keeps focus, the caret position and `autocomplete`.
  - Submitting a form hides its passwords again. A closed dialog takes its fields with it.
  - Edge's own reveal button is hidden, so each field shows one eye.
- **The checklist:** new-password inputs (marked `data-password-rule`) get a checklist under the field: 8+ characters, uppercase letter, lowercase letter, number, symbol.
  - Each item has an icon and says "met" or "not met" to screen readers.
  - The browser won't submit until the rule is met, and shows the server's message; the server checks again.
  - The sign-in form has no checklist.
- **Old limits removed:** the 12-character `minlength` and the "12 characters" hints are gone. New-password inputs have `maxlength="72"`.
- **Local Supabase:** in `supabase/config.toml`, `minimum_password_length` went from 6 to 8, and `password_requirements` from "" to "lower_upper_letters_digits_symbols". The local stack was restarted. Server-generated passwords (staff, members, the admin and seed scripts) already meet the rule.
Test added: `tests/unit.test.js`:
- "the password rule: 8–72 characters with an uppercase letter, a lowercase letter, a number and a keyboard symbol". It accepts valid examples and all 32 keyboard symbols. It rejects each missing kind, 7, 73 and 129 characters, 74 bytes, and a space, ₱ or É used for the required kind.
- "the API refuses a weak password even when the browser check is bypassed". `/set-password`, `/password` and `/auth/verify` answer 400 with the message, and Supabase Auth is never asked; the setup link stays usable.
And the new `tests/password-fields.js` (`npm run test:passwords`, Edge):
- the eye button works by mouse and keyboard, never submits, keeps focus, caret and `autocomplete`, and the sign-in form has no checklist;
- the checklist ticks as the person types, and a weak password is stopped in the browser;
- passwords are hidden after a submit, after a successful change and after the dialog closes;
- Set your password has the same button and checklist.
Also updated test passwords in `tests/staff.js`, `tests/auth-links.js` and the BUG-011 unit tests to meet the rule.
Mutation checks: removing the helper, the focus guard, hide-on-submit, the browser check, live updates or the spoken state each fail a browser test. The caret restore guards browsers that move the caret when a field changes type. Edge keeps the caret anyway, so no test here fails without it.
Live dependency: the hosted Supabase password settings must match, with a minimum of 8 and "Lowercase, uppercase letters, digits and symbols". Until then, Supabase's old 12-character minimum still refuses 8–11 character passwords.
Released: 2026-10-11. `main` was fast-forwarded to `882833e`, and Production deployment `dpl_FGh61nEvxhBiui3ijR92hN4vkLiD` is READY. Smoke tests pass, including a live browser check of the sign-in eye button and the Set your password checklist.

## FEATURE-003: Admin "Cancel checkout"   (status: released)
Requested: 2026-10-11 by Clark (Task 09 Part B). Where: Payments → Online payments in progress, role: admin.
Why: six live checkouts are stuck in `needs_review` (`checkout_reference_mismatch`, BUG-005), with active PayMongo sessions and 0 payments. While open they block online, cash and receipt payments on 5 invoices and 1 registration. Recover existing checkout only rebinds a checkout to `pending`, so it stays open and still blocks cash.
What changed:
- **The button:** administrators see Cancel checkout on open rows, behind the confirmation "This closes the PayMongo checkout so the member can pay another way. Only use it if the member has not paid." Staff and members never see it.
- **Two checks:** `POST /api/paymongo/cancel` is gated with `admin()`. Migration `20261011120000_paymongo_cancel.sql` adds `ff_paymongo_cancel` (security definer). Its `check` step verifies the administrator and the open checkout before PayMongo is contacted. Its `expire` step records the cancel only after PayMongo confirms it, accepts only the checkout's own session, and appends a `review_log` entry: who, when, PayMongo's response status and the session id.
- **PayMongo decides:** `cancelCheckout` in `src/paymongo.js` re-reads the session and checks test mode and that `reference_number` equals the checkout id.
  - A paid session is settled through the normal path instead, never cancelled.
  - A session PayMongo already expired is only closed here.
  - Otherwise it calls `POST /v1/checkout_sessions/{id}/expire` (PayMongo's documented endpoint), then reads the session again.
  - A failure or an uncertain result changes nothing, and the error is shown.
- **The race:** PayMongo refuses (400) to expire a session that is paid or has a payment in progress, and the server then reads it again and settles. `paymongo_settle` does not refuse an expired checkout, so a payment confirmed after a cancel (webhook or Check payment status) is still recorded, and no settle change was needed. The cancel binds a never-bound checkout to its verified session so that this works for the stuck rows too.
- **Admin message:** when a cancel turns into a settlement, the admin sees the settlement's own message too, for example whether the member's account and setup email are done.
Test added:
- `tests/paymongo-demo.sql` (17 new checks): staff and members are refused with 42501; an admin cannot cancel another workspace's checkout; another session, a missing status and an unknown outcome are refused; the audit entry; no second cancel; the stuck shape; cash blocked before and allowed after; a verified payment after the cancel is still recorded.
- `tests/unit.test.js` (5 tests): staff and members are refused before PayMongo; the bodyless expire call followed by a confirming read; already expired; failures leave the checkout unchanged; a session for another checkout is never expired. The capability test now includes `cancelCheckout`.
- `tests/paymongo.js` (4 new groups): unpaid becomes expired at PayMongo and here, then is paid in cash; a paid session is settled instead; both sides of the race; already expired; the live stuck shape; an outage changes nothing; and the admin screen.
- A real PayMongo test-mode run locally: create a checkout, cancel it from the admin screen, PayMongo shows `expired`, then pay the registration in cash.
- Mutation checks: removing the admin gate, the confirming read, the no-change-on-failure rule, the 400 re-read or the paid check, and in the database the admin check, the session check, the closed-checkout check or the audit entry, each fail a test.
- The mocked suite's cleanup now also removes accounts provisioned before a failed assertion. One interrupted run had left a local test payment behind.
Live steps after "go": push the migration, release, smoke-test. Then Clark cancels the six live checkouts from the admin screen; Claude does not.
Released 2026-10-12 after Clark's "go". The migration was pushed (16 versions match; all 19 post-push checks match local), `main` was fast-forwarded to `7ea3758`, and Production deployment `dpl_HmwpePzBHU2t4EoGNvNUVPSkHUnS` is READY. Smoke tests pass, and no live checkout was changed by the release. Clark has yet to cancel the six stuck checkouts and to run Check payment status on `4cbb49ad…`, which PayMongo shows as paid.

## BUG-012: "Password couldn't be saved" hid the real reason   (status: fixed)
Reported: 2026-10-12 by Clark. Where: Set your password from a setup or reset link (and its retry), role: new staff or member.
What happened: The passwords met the app's rule (all five checklist items ticked) but were 9 and 11 characters long. `/api/auth/verify` answered 422 "Your link worked, but this password couldn't be saved. Choose a different one and save again.", and the retry through `/api/set-password` answered 400 "The password could not be updated. Reauthenticate and try again."
Root cause: the hosted Supabase Auth settings still differ from the app rule (FEATURE-002, 8 characters and four character kinds). They were read with the Management API (`GET /v1/projects/ivxbrhqqfgmhfpgpauzh/config/auth`, using the existing CLI login; read-only, no token printed):
- `password_min_length` **12**, and `password_required_characters` **none**;
- secure password change and leaked-password protection are both off.
So Supabase refused the passwords in `client.auth.updateUser` with `weak_password` ("Password should be at least 12 characters."), and `src/api.js` threw that reason away.
Fix: `passwordRefusal` in `src/validation.js` maps Supabase's refusal to a clear message, and `src/api.js` uses it on `/auth/verify`, `/set-password` and `/password`.
- `weak_password` gets Supabase's own reasons, for example "The account server needs at least 12 characters.", "…a lowercase letter, an uppercase letter, a number and a symbol." or a breached-password message.
- `same_password` gets "Choose a password different from your current one."
- An expired session (`session_not_found`, `reauthentication_needed` and the like) gets "Your link expired. Request a new one." with 410, and the screen shows it with its Forgot password button, after the link save or its retry. On Change password, where there is no link, it reads "Your sign-in expired. Sign in again, then change your password." (401).
- The link save keeps its 422-then-retry behaviour, with the same message on both. Unknown errors keep the generic messages, and nothing echoes the password.
- `DEPLOYMENT.md` says the hosted password settings must match the app rule.
- Config change Clark is making, in the dashboard: minimum password length **8**, password requirements **Lowercase, uppercase letters, digits and symbols**. Until then, 8–11 character passwords are refused, now with that reason shown.
- Released 2026-10-12. `main` was fast-forwarded to `6f0f3f1`, and Production deployment `dpl_FyeRkHz6agQh1cgiUUcDoK9r6WTX` is READY. Smoke tests pass. No migration.
Test added: `tests/unit.test.js`:
- "Save password from a link says why the account server refused the password";
- "the retry and Change password give the same reasons" (both cover weak length, weak character kinds, both together, breached, same password, a missing session and reauthentication; nothing echoes the password);
- "an unknown account-server refusal keeps the generic message";
- "the app password rule is 8 characters plus all four character kinds, and the local Auth settings match it";
- "the set-password screen shows an expired link, with Forgot password, after the link or its retry".
BUG-011's refusal test now expects the specific reason. Also checked against the real local Supabase Auth: reusing the current password gives "Choose a password different from your current one." on the link save (422), the retry (400) and Change password (400).
Mutation checks: hiding refusals again, dropping the same-password or expired-session mapping, ignoring Supabase's length, the retry's missing expired screen, and Change password saying "link" each fail a test.

## FEATURE-004: Account-first registration and unpaid-account clean-up   (status: released)
Requested: 2026-10-12 by Clark (Task 10). Where: Add member, the member's home, Members → Unpaid accounts; roles: staff, admin, member.
Why: paid-first registration made a login account only after the first full payment, so a member could not choose a plan or pay online themselves. Accounts that never pay now need a safe, logged way to be removed.
What changed:
- **Add member** creates the account at once (Auth admin API, role member, random password, the same setup email staff get), after `ff_member_admin` checks the role and the one-email rule in the database. A plan at the desk is optional and becomes an unpaid invoice through the renew path. Public sign-up stays off.
- **Limited home:** a member with no plan chooses one; an unpaid member gets Pay now (PayMongo) or pays cash at the desk, with no member pass. The database already refused a pass, scan or check-in without a fully paid cycle covering today; now tested, including a validly signed pass.
- **Activation:** online only from PayMongo's verified signal; cash when staff record it.
- **Clean-up, in the database** (migration `20261012090000_account_first.sql`): only never-paid member accounts can be deleted (42501 otherwise). Payments, paid invoices, check-ins and the staff audit log are never deleted, and their presence refuses the delete. Closed checkouts stay as detached history. Every delete writes an append-only `ff_account_cleanup_log` row with an email hash.
- **PayMongo first:** open checkouts are checked with the Cancel checkout logic. A late payment is settled and the delete refused; an unpaid session is expired first.
- **By hand:** administrators get Members → Unpaid accounts with each account's age and Delete unpaid account, behind the confirmation text. Staff get neither.
- **Daily job:** Vercel Cron, `GET /api/cron/account-cleanup` with `CRON_SECRET`, deletes never-paid accounts older than 7 days. It ships switched off (`ACCOUNT_CLEANUP_ENABLED` unset).
- **Older registrations** still finish through the first-payment paths; Add member no longer creates them.
- **Fix found by the tests:** when two Add member requests race for one email, the loser now gets 409 "An account already uses this email." instead of a 502.
Test added:
- `tests/account-cleanup.sql` (57 checks): account creation with and without a plan; no pass, scan or check-in while unpaid; cash activates; staff can create accounts but can't list, delete or force a clean-up; every refusal and its message, including one artificial account per never-deleted record; malformed PayMongo confirmations; open checkouts; detached history; notifications; the log row; the email re-registers; the 7-day rule; grants; the append-only log.
- `tests/accounts.js` (15 groups, `npm run test:accounts`): no-plan creation; no pass while unpaid; plan + cash and plan + mocked PayMongo activate (a forged webhook changes nothing); staff refused; admin delete and the log row; the email re-registers; paid-then-expired, staff and admin accounts can't be deleted; an open checkout that turns out paid is settled and refused; an unpaid one is expired then deleted; an older registration still finishes; the daily job switched off and on; the unpaid member home and the Unpaid accounts tab in the browser.
- `tests/unit.test.js` (4 new): Add member through the Auth admin API with no plan; a desk plan becomes an unpaid invoice; the race message; admin-only delete and the job's secret and switch.
- Rewritten for account first: `tests/onboarding.js`, `tests/email-uniqueness.js`, `tests/auth.js`. `tests/registration-resilience.js` and the first-payment scenarios in `tests/paymongo.js` now use registrations made the old way (`tests/legacy-registration.js`).
- A real PayMongo test-mode run locally, all in the browser: Add member, the setup email, choose a plan, Pay now with GCash test, back in the app with the plan active and a member pass.
- Mutation checks: 24 of 24 are caught (database rules, server gates, the job's secret and switch, and the screens).
Live steps after "go": push the migration, release, smoke-test. Clark sets `CRON_SECRET` in Vercel. The job stays off until Clark approves the first run's list and sets `ACCOUNT_CLEANUP_ENABLED=true`.
Released 2026-10-12 after Clark's "go". The migration was pushed (17 versions match; all 289 post-push values match local), `main` was fast-forwarded to `f22dd6e`, and Production deployment `dpl_48J1TaAe8EtfnwchqF13tgG9NvBV` is READY. Smoke tests pass (17 of 17). No live account was created, paid or deleted; live has 0 never-paid accounts. The daily job is registered but inert: the `form-fitness` project has no `CRON_SECRET` yet, so Vercel's call (triggered once with `vercel crons run`) got 401. `ACCOUNT_CLEANUP_ENABLED` is unset.
Later on 12 October, with Clark's authorisation: `CRON_SECRET` was added to the `form-fitness` project (Production, Sensitive), from a random value piped straight into `vercel env add` and never shown; no other variable changed. `vercel redeploy` failed with `git_info_fail` (Production untouched), so `main` was fast-forwarded to `6105657` (BUGLOG only) and Production deployment `dpl_B6M4gLL3gYCnnx921gGLhLBhvD71` is READY; smoke tests pass. Vercel's cron call now gets 200: counting only, 0 due, nothing deleted. `ACCOUNT_CLEANUP_ENABLED` stays unset.

## BUG-013: A deleted account's sent notifications keep its email address   (status: follow-up)
Reported: 2026-10-12 by Clark (Task 10 "go"). Where: the notification records of an account removed by Delete unpaid account or the daily clean-up; administrators see them in Settings → Notifications.
What happens: the delete removes the account's unsent notifications. Its sent ones stay as the delivery record with `member_id` cleared, but their `recipient` still holds the deleted account's plain email address, although the clean-up log keeps only a hash and the email is otherwise free.
Follow-up:
- In `ff_private.delete_never_paid`, blank the `recipient` of those sent rows. The column is `text not null` with no format check, so an empty string works.
- Make the administrators' notification list show a blank recipient sensibly, for example "Deleted account".
- Add a database test that a deleted account leaves no plain email in `ff_notifications`.
- It needs a migration, so it goes through Gate 1.

## RESET-001: Fresh live database for testing   (status: done)
Requested: 2026-10-12 by Clark. Where: live (`ivxbrhqqfgmhfpgpauzh`), production workspace. Clark authorised deleting all member data, payment history included, for this one reset only, because it was all test data.
What changed:
- **Backup first:** every public `ff_` table and the members' Auth users (id, email and creation time), in `.local/backups/reset-test-data-linked-20261012T095936Z.json` (30.9 KB, gitignored).
- **PayMongo first:** the six stuck `needs_review` checkouts' sessions were expired at PayMongo and confirmed. `4cbb49ad…` was already paid at PayMongo (₱1,499, GCash test, 10 Oct) and was wiped without being recorded.
- **Deleted, in one transaction:** 2 member accounts and their Auth users, 3 payments, 8 checkouts, 12 notifications, 9 invoices, 9 cycles, 3 first registrations, and 1 member file.
- **Kept:** the administrator and staff accounts (both enabled), plans, settings, the staff audit log and the clean-up log.
- **Consequences:**
  - The six stuck checkouts and `4cbb49ad…` from FEATURE-003 are gone.
  - No paid-first registration remains, so the old first-payment paths (FEATURE-004) can now be removed in a later release.
  - BUG-013's leftover emails went with the reset, but the follow-up still stands.
- **Tools, for next time:** `scripts/reset-test-data.sql` (a SQL Editor preview and a guarded one-transaction delete) and `npm run reset:test-data` (backup, PayMongo expiry and storage clean-up; `--confirm "DELETE ALL MEMBERS"` or `--dry-run`). See DEPLOYMENT.md → Resetting test data.
Verification:
- 0 members and 0 member rows.
- Admin and staff profiles enabled, with their Auth users.
- Plans and settings unchanged.
- The live smoke tests pass (17 of 17).
- The administrator's `/api/state` reads succeed under RLS, simulated as the administrator in a rolled-back transaction.

## BUG-014: Another business's PayMongo events got 404 from our webhook   (status: fixed)
Reported: 2026-10-12 by Clark. Where: `POST /api/paymongo/webhook`, on the shared PayMongo test account.
What happened: The PayMongo account is shared with JMAC, whose webhook is `hook_TWxE…`. Webhooks are account-wide, so JMAC's paid checkouts also reach our webhook, correctly signed with our secret. The handler answered 404 "Unknown PayMongo checkout". That makes PayMongo keep retrying, and it can eventually get our webhook disabled.
Fix (`handleWebhook` in `src/paymongo.js`):
- **Not ours:** for a verified `checkout_session.payment.paid` event whose checkout isn't ours, the webhook answers 200 `{"ok":true,"ignored":"not_ours"}` and records nothing. "Not ours" means no checkout has that `session_id`, and no checkout's id is the `reference_number`.
- **Bad signatures stay 401,** checked before anything else.
- **A RepReady checkout is never "not ours":** it still matches by session, or by reference number when the event arrives before the session is bound.
- **Another workspace:** a RepReady checkout of another workspace gets `"ignored":"other_workspace"` instead, and is left for that workspace's deployment.
Test added:
- `tests/unit.test.js`: a JMAC-style reference; a foreign UUID; another workspace; a bad signature, refused with 401 before any database request; our unbound checkout goes on to bind. With the old 404, the test fails.
- `tests/paymongo.js`: two foreign signed events get `not_ours`, with payment and checkout counts unchanged; a bad signature stays 401; the old 404 assertion now expects `not_ours`. The early-webhook scenario still settles our unbound checkout.
Released 2026-10-12: `main` was fast-forwarded to `f9787a1`, and Production deployment `dpl_3iRXwgD8z6SDEZDLvT2vB5V7qSVm` is READY. It queued for about 6 minutes behind the Preview builds. Smoke tests pass, 17 of 17. No migration.

## FEATURE-005: Attendance report, My visits and Visits today   (status: released)
Requested: 2026-10-12 by Clark (Task 13). Where: Members → Attendance and the dashboard (staff, admin); the member's home (member).
Why: check-ins were recorded, but nobody could see them afterwards. The gym had no attendance report, members had no visit history, and the dashboard had no count for today.
What changed:
- **Attendance report:** `GET /api/reports/attendance?from&to&plan` for staff and administrators. Members get 403, and signed-out callers get 401.
  - It reads through the caller's own session, so RLS keeps it to their workspace.
  - Dates must be real, From must be on or before To, the range is at most 366 days, and To can't be later than today (Manila). The plan is `all` or one of the workspace's plans; anything else gets 400.
  - Rows are read 1,000 at a time, up to 10,000, with `truncated` set when there are more.
  - Each visit has the date, the Manila time, the member, the plan and the staff member who confirmed it. The totals are visits, unique members, days and the daily average to one decimal.
- **Attendance tab** (Members; staff and administrators):
  - From and To default to the last 7 days, with a plan filter and Apply.
  - Three totals cards, then the visits, newest first.
  - Export CSV, named `RepReady-attendance-<from>-to-<to>.csv`, through the app's `csv()` helper, which also neutralises cells that start with `=`.
  - An empty state, and a note when the list is truncated.
  - On phones the Members tab bar now scrolls sideways, because administrators have five tabs.
- **My visits** (members): "This month: N visits" and the member's own last 30 visits.
  - `/api/state` carries them, so there is no new endpoint.
  - The member's check-in query now asks for their own 50 latest by member id.
- **Visits today** (staff and administrators): a dashboard card, returned as `stats.visitsToday`.
  - It is an exact count of today's check-ins with no rows fetched (`count: 'exact', head: true`).
  - It is the only new query on each refresh.
- **No migration.** The existing check-in indexes cover these reads. Passes and check-ins work as before.
- **Found while testing:**
  - The existing browser suite caught the administrator's five Members tabs widening the page at 390 px. The tab bar now scrolls on phones, and the open tab stays in view.
  - The screenshots showed the report's filters and cards touching the panel border. They now sit inside the panel's padding.
Test added:
- `tests/attendance.test.js` (4 tests):
  - the date and plan rules;
  - the totals;
  - Manila times;
  - paging: 1,000 rows at a time, stopping at 10,000, and `truncated` only when more exist;
  - the plan filter;
  - an unknown plan refused before any check-in is read.
- `tests/attendance.js` (7 groups, `npm run test:attendance`):
  - 401 signed out, 403 for a member, 200 for staff and administrators;
  - the plan filter, and 400 for bad ranges and plans;
  - workspace isolation;
  - My visits stays correct with 55 newer visits by others;
  - Visits today, per workspace;
  - in the browser: the Attendance tab, the CSV file, and the phone layouts, including an administrator's five tabs;
  - My visits in the browser.
- Every existing suite still passes:
  - the unit tests (91);
  - the four database suites;
  - the twelve server suites;
  - the demo integration and browser suites.
First release attempt: `main` was fast-forwarded to `f4240c7` and pushed on 2026-10-12 at 15:12 UTC, but no deployment was ever created. Vercel's incident "Increased build and deployment failures" (13:35 to 20:11 UTC, with Git Integrations partly down) dropped the push event, and Production stayed on `dpl_3iRXwgD8z6SDEZDLvT2vB5V7qSVm`. So `main` is fast-forwarded again, to the BUGLOG-only commit that adds this note, to trigger the build.
Released 2026-10-13 with BUG-015, after Vercel's incident was resolved. `main` was fast-forwarded to `41b1201`, and Production deployment `dpl_Fw1ezbaLKFRab1UMLk7H7TFz53CK` is READY; it built in about 30 seconds. Smoke tests pass, 22 of 22. They include `GET /api/reports/attendance` answering 401 when signed out and with a forged session cookie. The attendance and pass scripts served are identical to the commit. No migration, and no live data was created.
13 October (Task 13 v2, 13A): My visits also shows "Last visit", and member-facing times (My visits and the pass) use the 12-hour clock, for example "10:15 AM". The staff report keeps 24-hour times. See BUG-016.

## BUG-015: The member pass stopped at "Pass expired" instead of refreshing   (status: fixed)
Found: 2026-10-12 while checking the QR pass end to end (Task 13, Part 4). Where: the member's QR pass screen.
What happened:
- **No refresh:** when the 90-second countdown ended, the QR faded and the screen said "Pass expired. Refresh to get a new QR." It stayed that way until the member tapped Refresh pass, so a member waiting at the desk could be holding a dead QR.
- **Phone clock:** the countdown measured the pass's expiry against the phone's own clock. If that clock was more than about 90 seconds wrong, a valid pass could show as expired straight away. Or, with the clock behind, the screen counted past the point where the server stops accepting the pass.
Fix (`memberQR` in `public/connected.js`):
- **Countdown:** it now runs from when the pass arrived, on the device's own timer, so the phone's clock setting doesn't matter.
- **Self-refresh:** when the countdown ends, the screen fetches a fresh pass by itself, up to 10 times (about 15 more minutes). After that it shows "Pass expired" and Refresh pass, as before.
- **No writes:** issuing a pass only signs a token, so each refresh is one read-only call.
- **Late refreshes are ignored:** a refresh still in flight when the screen closes, or when Refresh pass is tapped, can't draw over the new pass or stop its timer.
Test added:
- `tests/pass-check.js` (`npm run test:pass`): with the browser clock fast-forwarded, the pass refreshes itself 10 times and then shows "Pass expired". Without the fix, the test fails at the first refresh.
- The same suite covers the rest of Part 4. It checks pasted text, image upload and camera scans, the already-used and already-recorded passes, refusing unpaid and disabled members, the back camera, and the blocked-camera fallbacks.
Released 2026-10-13 with FEATURE-005, in Production deployment `dpl_Fw1ezbaLKFRab1UMLk7H7TFz53CK`.

## BUG-016: The member got no check-in confirmation   (status: fixed)
Reported: 2026-10-13 by Clark (Task 13 v2, testing live). Where: staff Confirm check-in, and the member's pass screen.
What happened: staff confirmed John Garcia's check-in, and the toast said "Check-in confirmed. Member notification queued." John saw nothing.
Root cause (read-only checks on live):
- **The toast is fixed text.** The browser shows it after every check-in, whatever happens next.
- **Each check-in queues an email.** `ff_private.command('check-in')` calls `ff_private.notify`, which inserts a `queued` row into `ff_notifications`: "RepReady check-in confirmed", to the member's email address.
- **Nothing on live sends it.** Only `flushEmails` (Gmail SMTP, `src/notifications.js`) sends queued rows. It runs after some API calls, and only when `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` are set; Production has neither. No cron sends them (the only cron is the account clean-up), and members have no in-app inbox.
- **So every production notification is still queued.** That's 3 rows, none ever sent: a membership notice, the GCash payment confirmation, and John's check-in (13 Oct, 00:05 Manila).
Fix (no migration):
- **Confirmation on the pass:** while the member's pass screen is open and the tab is visible, it asks `GET /api/checkin-status` about every 3 seconds. That endpoint is for members only and reads just the caller's own row for today.
- When the check-in appears, the QR becomes "✓ Checked in — 10:15 AM" and "Have a good workout!", with the date and plan. My visits refreshes behind it.
- **Reopening** the pass later that day shows "Already checked in today at 10:15 AM" instead of a new QR.
- **Checks stop** when the screen closes or the tab is hidden, and resume as soon as the tab is visible again.
- **The staff toast** now says "Check-in confirmed. The member sees it on their pass and in My visits."
- **No email per check-in.** It would use up the email quota.
Still open (a recommendation, not done): if a Gmail sender is ever configured, every queued check-in email would go out at once, and each new check-in would send one more. Recommended: stop queueing check-in notifications, and mark the queued ones `suppressed` (in-app only), keeping every row. That needs a migration, so it goes through Gate 1.
Follow-up, 2026-10-13: Clark agreed. Migration `20261013150000_checkin_emails_off.sql` makes `ff_private.notify` skip check-in events and marks queued check-in emails `suppressed`, keeping every row. Tested in `tests/checkin-emails.sql` (6 checks). Waiting at Gate 1.
Follow-up released 2026-10-13 after Clark's "go" (this migration only). The pre-flight matched Gate 1, and `supabase db push --linked` applied it (with the same harmless CLI cache warning). Then 19 of 19 migrations matched. Post-push, `notify` matches local, grants are unchanged, John's check-in email is `suppressed` (kept), no check-in email is queued, and the other notifications are untouched. `main` was fast-forwarded to `23c2e37`, and Production deployment `dpl_8LHe1hPsXuagMotcymNJ16xMVFN7` is READY. Smoke tests pass, 29 of 29.
Test added:
- `tests/attendance.test.js`: 12-hour Manila times; the status reads only the caller's own row for today.
- `tests/attendance.js`:
  - the status shows the member's own check-in, with its time, date and plan;
  - other members' check-ins today don't count;
  - staff get 403, and signed-out callers get 401;
  - Last visit, and 12-hour times in My visits.
- `tests/pass-check.js`:
  - on desktop and on a phone, the open pass turns into the confirmation about 2.5 seconds after staff confirm (the test allows 5);
  - My visits has the visit;
  - reopening shows "Already checked in today";
  - the screen checks about every 3 seconds, and not at all while the tab is hidden or after it closes;
  - the self-refresh test now uses a member who hasn't checked in.
- `tests/browser.js`: the demo customer's pass shows today's check-in once the integration suite has checked them in.
Released 2026-10-13: `main` was fast-forwarded to `77f9c6a`, and Production deployment `dpl_FNPPzBUsqFBGhihe4Md4T86bGzr4` is READY (built in about 20 seconds). Smoke tests pass, 25 of 25. They include `GET /api/checkin-status` and `GET /api/reports/attendance` answering 401 when signed out and with a forged session cookie, and the served pass and attendance scripts are identical to the commit. No migration, and no live data was created.

## FEATURE-006: Short manual pass code   (status: released)
Requested: 2026-10-13 by Clark (Task 13 v2, 13B). Where: the member's pass and the staff scanner; roles: member, staff, admin.
Why: manual entry expected the long signed QR text, which nobody can type. Clark pasted a member id and got "Invalid member pass". When the camera fails, staff need a short code instead.
What changed:
- **On the member's pass:** an 8-character Crockford base32 code under the QR, shown as XXXX-XXXX. It has no I, L, O or U, so there are no 0/O or 1/I mix-ups. It is the same pass: it shares the QR's nonce and 90-second life, and refreshes with it.
- **In the scanner:** "Type the pass code instead" opens a "Pass code" field (e.g. 7KQ2-M9XD). Any case works, with or without the dash or spaces, and O, I and L are read as 0, 1 and 1. Pasted QR text still works in the same field, and image upload is unchanged.
- **How it checks:** the database looks the code up and returns the member's own signed pass. The scan and check-in that follow are the QR's, unchanged, and the photo-ID tick is still required. A check-in by either the code or the QR uses up both.
- **Refusals:**
  - an unknown code: "Pass code not recognised. Check it with the member.";
  - an expired code: "Code expired — ask the member to refresh their pass";
  - a used code: "This pass code was already used.";
  - already checked in today: "Already recorded";
  - unpaid: no pass, so no code;
  - disabled: "This membership is inactive."
- **Brute force:** after 10 wrong codes in 5 minutes, that staff account gets "Too many attempts — wait a few minutes" (429).
- **Storage** (migration `20261013120000_pass_codes.sql`):
  - `ff_pass_codes` stores only an HMAC of the code, never the plain code, keyed with the existing pass secret. `ff_pass_code_attempts` records wrong attempts.
  - Both tables have RLS with no policies and no grants.
  - `ff_pass_code('issue'|'lookup')` is a security-definer function.
  - A trigger marks a code used when a check-in records its pass.
  - Rows are removed a day after they expire.
Test added:
- `tests/pass-codes.sql` (39 checks):
  - members can't read, write or look up codes;
  - one code per pass, paired with the QR's nonce and expiry; only the hash is stored;
  - a code for someone else's pass, or a forged pass, is refused;
  - normalising, and Crockford O/I/L;
  - another workspace's code isn't recognised;
  - a code fails after its QR checked the member in, and the QR fails after its code did;
  - "Already recorded", expired, disabled and unpaid;
  - the rate limit, and that it's per account and lasts 5 minutes;
  - housekeeping, uniqueness and grants.
- `tests/pass-check.js`:
  - the code is readable under the QR on a phone and changes with each refresh;
  - staff type it in lower case with a space for the dash, still tick the photo ID, and check the member in;
  - a wrong code and a used code are refused;
  - 10 wrong codes through the API, then 429.
- `tests/unit.test.js`: a typed code goes to the server as a code, and the check-in uses the pass it returns.
Live steps after "go": push the migration first, then release (fast-forward `main`), then smoke-test.
Released 2026-10-13 after Clark's "go" (this migration only). The pre-flight dry run and read-only checks matched Gate 1. `supabase db push --linked` applied `20261013120000_pass_codes.sql`; its only warning was the CLI failing to cache its local pg-delta catalog. Then 18 of 18 migrations matched, and the post-push checks found 0 differences from local: tables, constraints, indexes, RLS without policies, grants, function fingerprints and the trigger. Live data was unchanged. `main` was fast-forwarded to `b5649bd`, and Production deployment `dpl_8bVRf7K9cPKB2obXauTCLKfdVqTP` is READY. Smoke tests pass, 29 of 29. No live data was created.
A minute later, the repo owner merged PR #1 (Vercel Web Analytics) into `main` (`5316dd8`). Production is now `dpl_5wyCGB5VgnFouHnPAnHjn6iYkrk6`, which includes this release, and the smoke tests pass against it too, 29 of 29. `main` was merged into `clark-changes` (`d04d097`) so that releases can stay fast-forwards.

## FEATURE-007: Member fitness survey, required at first login   (status: built)
Requested: 2026-10-13 by Clark (Task 11). Where: the member's first sign-in, My membership, Add member, and the staff's member overview; roles: member, staff, admin. (The task file says FEATURE-004, but Task 10 took that number first.)
Credit: built on a classmate's survey work (`fitness-survey-update.zip`, made against `main` `ed44803`). It included:
- the `ff_member_surveys` table and its RLS, and `ff_save_member_survey`;
- the checks in `src/survey.js`;
- `public/member-survey.js` and `.css`: the form, its error summary and focus handling, edit and cancel, and the staff's read-only view;
- a boot fix that restores a reloaded page's address;
- database, unit and browser tests.

Their full copies of the shared files were not used, because they would have undone later work. Only the survey parts were ported by hand. The zip stays out of git (`_incoming/` is in `.gitignore`).
What changed:
- **Four questions:** main goal (the existing profile goal), training experience, exercise preferences and usual days. No medical data.
- **Required at first login:**
  - A member without a survey sees only the survey after signing in, with a short welcome and Sign out, and no skip.
  - The API refuses a member's plan selection (`/api/renew`) and online checkout (`/api/paymongo/checkout`) with 403 "Complete your fitness survey first." until it is saved.
  - Staff and administrators are never asked.
- **At the desk:** Add member has an optional, collapsible "Fitness survey (optional — the member can do it at first login)" section with the same questions, replacing the free-text goal field. Filled in, it is saved with the account in the same transaction (`register_auth_user`). Afterwards only the member changes it.
- **Later:** My membership → "Your fitness profile", with Edit and Cancel.
- **Staff view:** the answers, read-only, in the member overview.
- **After the first save:** "Thanks! Choose your plan next." and plan selection. `recommendPlans(survey, plans)` is the hook for Task 12, and suggests nothing yet.
- **Clean-up:** a survey goes with its profile (`on delete cascade`), so Task 10's clean-up of a never-paid account removes it, and so does the test-data reset.
- **Migration** `20261013180000_member_survey.sql`:
  - the table, RLS and read policy;
  - `ff_private.survey_answers` (the shared checks);
  - `ff_save_member_survey`;
  - `register_auth_user`, which is Task 10's version plus the desk survey.
Test added:
- `tests/survey-database.sql` (47 checks):
  - the classmate's checks on the current schema;
  - the desk survey saved with the account, while an invalid one stops the account;
  - only members get one;
  - staff and administrators can't save;
  - the clean-up removes the survey.
- `tests/survey-browser.js` (`npm run test:survey`, offline): the first-login screen, the checks, failed-save recovery, double submit, thanks and plan selection, editing and cancelling, 390 and 320 px layouts, the staff view, and the desk section.
- `tests/survey.js` (`npm run test:survey-flow`, real stack, desktop and phone):
  - the 403s, while staff aren't blocked;
  - survey, thanks, plan selection and the first invoice;
  - a desk survey means no prompt;
  - staff can't edit;
  - members read only their own;
  - the clean-up removes the survey.
- `tests/unit.test.js`: the classmate's three tests, plus the gate and the desk survey.
- Existing suites:
  - Fixture members come with a survey, as if filled in at the desk.
  - The onboarding test fills in the desk survey.
  - The demo suites save their customers' surveys.
