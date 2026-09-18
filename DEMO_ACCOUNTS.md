# Demo accounts

Three real Supabase Auth accounts are prepared in the `demo` workspace: `form-fitness-demo-admin@example.invalid`, `form-fitness-demo-customer@example.invalid`, and `form-fitness-demo-isolation@example.invalid`. Reserved `.invalid` identifiers were used without sending invitations or mail. These are working password-authenticated accounts, not browser mocks or bypasses.

## Retrieve credentials privately

On the original Windows workstation, open `.local/demo-credentials.json` in VS Code. This file has restricted user access, is ignored by Git, and is excluded from deployment and the ZIP. Passwords are not printed here. The ZIP recipient must seed their own accounts; it does not include working credentials.

Visit the protected Vercel URL in README.md, authenticate with authorized Vercel access, then log in to FORM using the selected demo account. Local use requires `APP_WORKSPACE=demo`.

## Create or reset demo credentials

Use the existing Supabase project and a server-only secret in `.env.local`. Set `APP_WORKSPACE=demo`, and three distinct email addresses you control in `DEMO_ADMIN_EMAIL`, `DEMO_CUSTOMER_EMAIL`, `DEMO_SECOND_CUSTOMER_EMAIL`.

```powershell
npm run seed:demo
npm run seed:demo -- --reset
```

For the already prepared reserved accounts, set those three variables to the exact existing identifiers to reset them. The script sends no email, refuses unrelated existing accounts, generates strong passwords, and saves credentials only in `.local/demo-credentials.json`. Sample records are idempotent, clearly named DEMO, and outbound mail is suppressed. It creates an active paid customer cycle, a future renewal invoice and pending review. Demo and production are enforced as separate workspaces by the API and RLS.

## Class demonstration

1. Sign in as the customer; reload to show persistence. Open membership, invoices and the short-lived member QR.
2. In a separate browser profile, sign in as admin. Review dashboard and the pending sample payment. Explain that staff verification is required; sample funds are fictional.
3. Upload a fresh member pass image into the scanner, confirm the displayed identity and check in. Replay the same image to demonstrate rejection.
4. Sign in as the isolation customer to show that another member's records are unavailable.
5. Show notification suppression and payment settings awaiting real owner images. Sign out of each account.

Passes expire after 90 seconds. Demo memberships also have real dates; rerun the seed after expiry to prepare a current cycle. Never use these shared demo accounts for real member records.
