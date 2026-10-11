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

## BUG-003: Integration test will soon fail its renewal step   (status: noticed)
Noticed: 2026-10-10 by Claude, while running `npm run test:integration` (demo workspace). Not reported by Clark.
What happened: Nothing has failed yet. Each run that finds no unpaid invoice renews the second demo customer one cycle further ahead. That customer now has 7 memberships, the latest ending 2027-05-07.
Root cause: `tests/integration.js` (the renewal for the second account) always renews after the latest cycle. After about 5 more runs, the next start date passes the 365-day limit in `ff_private.new_membership` and the step fails.
Fix: none yet; needs a decision. Either the test stops renewing when a future cycle already exists, or the demo customer's future cycles are cleaned up periodically.
Test added: none.
Update 2026-10-10 (Task 06): one more run. The customer now has 8 memberships, the latest ending 2027-06-06, so about 4–5 runs remain at today's date.

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

## BUG-006: No PayMongo webhook points at the live site   (status: noticed)
Noticed: 2026-10-10 by Claude, during Task 06's read-only checks. Not reported by Clark.
What happened: Nothing visible yet. A paid checkout is confirmed when the payer returns to the app while signed in, or when staff use Check payment status, but never on its own. A customer who pays on their own phone, or closes the tab before returning, stays `pending` until someone checks.
Root cause: configuration. The PayMongo account Production uses (the same account as the local test key, which can read the live checkout sessions) has one test webhook, created 31 August for a Supabase Edge Function on another project (`joffopwzqmlqpsrbivfq.supabase.co/functions/v1/paymongo-webhook`). None points at `https://repready-gym.vercel.app/api/paymongo/webhook`. Webhooks apply account-wide, so that other function also receives RepReady's payment events.
Fix: config change for whoever manages the PayMongo account. In the PayMongo dashboard, in test mode, add a webhook with the URL `https://repready-gym.vercel.app/api/paymongo/webhook` (the alias; per-deployment URLs require a Vercel login) and the event `checkout_session.payment.paid`. Put its secret key in Vercel's `PAYMONGO_WEBHOOK_SECRET` for Production (Sensitive), then redeploy Production so the new value is used. Disabling the old webhook is the owner's decision. Nothing was changed by Claude.
Test added: none. After the change, Claude can confirm it without writing anything: an event of an unknown type, signed with the new webhook's secret, should get 200 "ignored" from live (it returns before any database access), and a wrong secret gets 401.

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
Test added: `tests/unit.test.js`:
- "Save password from a link says why the account server refused the password";
- "the retry and Change password give the same reasons" (both cover weak length, weak character kinds, both together, breached, same password, a missing session and reauthentication; nothing echoes the password);
- "an unknown account-server refusal keeps the generic message";
- "the app password rule is 8 characters plus all four character kinds, and the local Auth settings match it";
- "the set-password screen shows an expired link, with Forgot password, after the link or its retry".
BUG-011's refusal test now expects the specific reason. Also checked against the real local Supabase Auth: reusing the current password gives "Choose a password different from your current one." on the link save (422), the retry (400) and Change password (400).
Mutation checks: hiding refusals again, dropping the same-password or expired-session mapping, ignoring Supabase's length, the retry's missing expired screen, and Change password saying "link" each fail a test.
