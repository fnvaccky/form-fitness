# Transactional email sources

`src/email-layout.js` supplies the shared table-based RepReady layout: dark green branding, light page, centered card, one action with a fallback link and a short footer. Text branding requires no images, fonts or tracking assets. Dynamic notification data is escaped before entering authored HTML. Supabase placeholders remain Go expressions for contextual escaping by its `html/template` engine.

Run `node scripts/build-email-templates.js` after editing the authored Auth content there. It generates the committed `supabase/templates/invite.html` and `recovery.html`, plus `.txt` companions. `node scripts/build-email-templates.js --check` verifies parity while allowing Windows checkout line endings. Do not edit generated files separately.

The application currently uses Supabase's **recovery** email for both initial account setup and Forgot password. These calls supply the same callback and no per-send template purpose. Clark chose to preserve delivery and use the neutral **Choose your RepReady password** for that shared email. Genuine invite emails say **Set up your password**. No user-metadata flags, authentication URL markers or account-state guesses were added. Distinct setup/reset wording for that shared path would need a separately reviewed delivery change.

Authentication destinations, token expressions, query parameters and expiry settings are unchanged. No real link belongs in logs, reports or committed fixtures. The invite/recovery action continues to use the supplied RedirectTo and TokenHash, preserving link-scanner protection and cross-device verification. Auth membership details still use the existing purchased metadata, not an editable catalog query.

`src/notifications.js` now passes both the original plain text and escaped HTML to its existing sender. Payment text still comes from `paymentEmail()` and the cycle's frozen terms; amounts, queue claims, Message-ID, delivery/retry behavior, SMTP provider and sender settings are unchanged.

The current Supabase Auth SMTP client exposes an HTML template body, not a separate plain-text template setting. The `.txt` files are review/integration companions; they are **not active MIME alternatives** in that unchanged Auth delivery path. Application notifications do send multipart alternatives. Adding an Auth text alternative requires a separate delivery integration; do not imply that installing these HTML templates enables it.

Repository Auth templates configure local Supabase. Deploying application code does **not** install hosted Auth templates or subjects. A later approved release must install the two generated HTML bodies and corresponding subjects through the existing hosted-template procedure, preserving SMTP settings and link-expiry configuration. Do not restart local services, modify hosted settings or send messages solely to preview styling.

Focused checks and dummy before/after previews use `tests/email-templates.test.js`, `tests/email-preview.test.js` and `tests/render-email-template.go`. Go is preview/test tooling only, not a runtime dependency. Previews must use fictitious data, block external requests and never follow authentication actions. Browser previews establish layout checks, not certification across every inbox client.

Run `npm run test:email-templates` for layout, exact plain text, frozen terms, queue and isolated MIME checks. Run `npm run test:email-preview` with Go on PATH, or `EMAIL_PREVIEW_GO` pointing to a Go executable, for real Go rendering and browser previews. It builds the small standard-library-only renderer into ignored `test-results/email-preview/` with module downloads disabled. The generated review gallery is `test-results/email-preview/index.html`; all accounts and tokens there are fictitious.

References: [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [Auth SMTP implementation](https://github.com/supabase/auth/blob/master/internal/mailer/mailmeclient/mailmeclient.go), [Go HTML escaping](https://pkg.go.dev/html/template).
