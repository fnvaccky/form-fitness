# RepReady PayMongo setup

> **Superseded.** This guide describes the earlier GCash/QR Ph design built on `ff_paymongo_attempts`. On this branch that design is retired (Option A in [docs/BRANCH_RECONCILIATION.md](docs/BRANCH_RECONCILIATION.md)). The current PayMongo setup, migrations and verification steps are in [PAYMONGO_DEMO_REPORT.md](PAYMONGO_DEMO_REPORT.md). The text below is kept unchanged as history.

Code supports GCash and bank/wallet-app payments through QR Ph using PayMongo Hosted Checkout v2. Ordinary bank transfers remain manually reviewed. This does not enable a bank-account transfer API.

## Current verification

The integration is disabled until credentials and workspace settings are present. Automated tests use synthetic events, not real payments. Provider checkout, merchant channel eligibility, actual QR scanning, settlement and inbox delivery must be verified with your own PayMongo account. Do not describe real payments as tested before completing the checklist below.

## Test setup

1. Apply both October 1 PayMongo migrations in order to a new database before deploying, including the notification permission migration. Both have already been applied to the existing project `ivxbrhqqfgmhfpgpauzh`.
2. Use a separate Vercel test deployment with `APP_WORKSPACE=demo` and its exact HTTPS URL in `APP_ORIGIN`. Never switch your customer-facing production deployment to demo.
3. In Vercel's protected environment settings enter `PAYMONGO_SECRET_KEY` (your `sk_test_...` key), `PAYMONGO_WEBHOOK_SECRET` (the endpoint signing secret), and the existing `SUPABASE_SECRET_KEY`. Never put these in GitHub or chat. `PAYMONGO_ALLOW_LIVE=false`.
4. In PayMongo register `https://YOUR-TEST-HOST/api/paymongo/webhook` for `checkout_session.payment.paid`. The endpoint must be reachable by PayMongo without Vercel login; retain account authentication on member/admin pages. Register test and live webhooks separately.
5. Redeploy, sign in with an isolated demo member, open an unpaid invoice and choose **Continue to GCash / QR Ph**. Enable both channels in your merchant account if necessary.
6. Complete PayMongo's simulated GCash and QR Ph payments on separate test invoices. Confirm each invoice updates once, the payment reference appears, and a repeated webhook does not add another payment. Test cancellation and provider failure: the invoice must stay unpaid. Returning to the app alone never confirms payment.

## Production activation

After sandbox verification and owner approval, set live credentials on the production deployment, `APP_WORKSPACE=production`, `PAYMONGO_ALLOW_LIVE=true`, correct `APP_ORIGIN`, and register the production webhook. Test keys intentionally cannot pay production invoices. Live keys cannot pay demo invoices. Check your merchant account supports GCash and QR Ph. PayMongo fees are deducted from the merchant proceeds; no extra fee is added by this integration.

An owner-authorized small real transaction for each channel is still needed to verify end-to-end money receipt. Check PayMongo's dashboard and the app; SMTP acceptance alone is not inbox delivery. No live charges were made during implementation.

## Reconciliation

`ff_paymongo_attempts` preserves pending, paid and review attempts. A timeout or rejected session creation conservatively stays pending because provider outcome may be unknown. Reopening payment reuses the existing session; it never silently creates a replacement. Staff must inspect PayMongo before closing an abandoned attempt. Cancel/expire the provider session first, confirm no payment, then a trusted server administrator can set the attempt to `closed`. Never reset invoice balances or delete payment records to retry.

If a manual payment arrives during checkout, an excessive or mismatched provider payment is retained as `review` without increasing the balance. Reconcile/refund through PayMongo and contact the member. Additional unexpected provider payment IDs return an error for investigation. Staff should monitor pending/review attempts and webhook failures in Supabase and PayMongo until an administrative reconciliation screen is added.

GCash and QR Ph payments use signed raw-body webhooks, PHP integer centavos, immutable invoice-derived amounts, row locks and unique provider payment IDs. Customers cannot call settlement functions directly. Confirmed payments queue the existing email notification; demo messages are suppressed. SMTP configuration is separate.

References: https://docs.paymongo.com/docs/payment-channels-hosted-checkout and https://docs.paymongo.com/docs/developer-tools-webhook-setup-management
