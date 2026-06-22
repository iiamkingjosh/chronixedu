# Payment Receipt Delivery — Design Spec

**Date:** 2026-06-22
**Status:** Approved for implementation planning

## Overview

Chronix Edu already generates PDF payment receipts (Puppeteer + `receipt.hbs`, stored in Supabase storage) and exposes them on demand to staff via `GET /:schoolId/payments/:paymentId/receipt`. Parents have no way to see a receipt for their own child's payment — the route is staff-only, there's no email, and there's no button on the parent fees page.

This spec adds: (1) automatic receipt generation + email immediately after any payment is recorded, for every payment method, and (2) parent-facing access to download that receipt on demand. Scope is parent-only — the student portal is unchanged.

## Current State (reference)

- `recordPayment(schoolId, invoiceId, input)` — `apps/api/src/db/queries/fees.ts:176` — the single function all payment methods funnel through. Returns `{ payment: PaymentRow, invoice: FeeInvoiceRow }` or `null`.
- Three call sites invoke `recordPayment`, all in `apps/api/src/routes/fees.ts`:
  - `POST /:schoolId/payments` (line ~330) — bursar manual recording (cash/bank_transfer/waiver/paystack)
  - `GET /:schoolId/payments/paystack/callback` (line ~493) — browser redirect after Paystack checkout
  - `POST /:schoolId/payments/paystack/webhook` (line ~568) — Paystack server-to-server webhook
- `getPaymentById(schoolId, paymentId)` — `apps/api/src/db/queries/fees.ts:249` — fetches the joined `PaymentReceiptRow` (student name, term, session, etc.) that `generateReceipt` requires.
- `generateReceipt(schoolId, payment: PaymentReceiptRow)` — `apps/api/src/services/receiptService.ts:36` — renders the PDF, uploads to Supabase storage, returns a public URL.
- `getParentsForStudent(studentId)` — `apps/api/src/db/queries/parents.ts:56` — returns `{ parent_id, email, phone }[]` for all parents linked to a student. Already used by `feeReminderService.ts` for the existing weekly fee-reminder email job — this feature follows that same pattern.
- `sendEmail(to, subject, text)` — `apps/api/src/services/emailService.ts` — no-ops if SendGrid isn't configured, falls back to `email_queue` + cron retry on send failure. No code changes needed here.
- `canAccessInvoiceForStudent(user, schoolId, studentId)` — `apps/api/src/routes/fees.ts:47` — existing authorization helper already used for parent/student invoice access; reused as-is for the new receipt route.

## Behavior

### 1. Automatic receipt + email on every successful payment

At each of the three `recordPayment` call sites, after a payment is newly created (i.e. `result` is non-null, and excluding the duplicate-webhook/`23505` paths where no new row was created), fire an **unawaited** call to a new helper:

```ts
notifyPaymentReceipt(schoolId, result.payment.id, result.invoice.student_id).catch(err =>
  logger.error('payment_receipt_notify_failed', { schoolId, paymentId: result.payment.id, error: err })
);
```

`notifyPaymentReceipt` (new function in `receiptService.ts` or a thin new `paymentReceiptNotifier.ts`):
1. `getPaymentById(schoolId, paymentId)` → `PaymentReceiptRow`
2. `generateReceipt(schoolId, payment)` → public URL
3. `getParentsForStudent(studentId)` → parent list
4. For each parent: `sendEmail(parent.email, 'Payment receipt — Chronix Edu', <body with student name, amount, method, and the receipt URL>)`

This is fire-and-forget relative to the HTTP response — the bursar's request and the Paystack callback/webhook response are not delayed by PDF generation. Errors are logged, not thrown; a receipt failure must never undo or block the payment itself. Because `sendEmail` already falls back to the queue-and-retry mechanism on its own failure, no new resilience layer is needed for the email leg. Receipt **generation** failure (e.g. a transient Puppeteer error) is simply logged — the parent can still retrieve the receipt later on demand, since generation runs again (idempotent: `upsert: true` on the storage path) when they hit the download endpoint.

### 2. Parent-facing receipt access

Extend `GET /:schoolId/payments/:paymentId/receipt`:
- Add `parent` to the `requireRole(...)` list.
- Inside the handler, after fetching the payment, if `req.user.role === 'parent'`, call `canAccessInvoiceForStudent(req.user, schoolId, payment.student_id)` and return `403 FORBIDDEN` if false. Staff roles skip this check (unchanged behavior).
- Note: `PaymentReceiptRow` does not currently expose `student_id` directly (it joins through `fi.student_id` internally but doesn't select it) — add `fi.student_id` to the `SELECT` and the `PaymentReceiptRow` interface in `getPaymentById`, since the new authorization check needs it.

### 3. Frontend — parent fees page

In `apps/web/app/(parent)/parent/fees/page.tsx`, in the existing payment history list, add a "Download Receipt" link per row that calls the (now parent-accessible) receipt endpoint and opens the returned URL in a new tab — mirroring the existing bursar-side `downloadReceipt()` pattern in `apps/web/app/(dashboard)/bursar/invoices/page.tsx:79-86`.

## Data Flow

```
Payment recorded (any method, any of 3 call sites)
        │
        ├─→ HTTP response returned immediately (bursar UI / Paystack callback redirect / webhook 200 ack)
        │
        └─→ (unawaited) notifyPaymentReceipt()
                 ├─ getPaymentById            → PaymentReceiptRow
                 ├─ generateReceipt           → PDF in Supabase storage, public URL
                 ├─ getParentsForStudent      → [{ email, phone }, ...]
                 └─ sendEmail per parent      → link-only email (no attachment)
                          └─ on failure → email_queue (existing retry cron)

Parent later visits /parent/fees
        └─→ clicks "Download Receipt" on a past payment
                 └─→ GET /:schoolId/payments/:paymentId/receipt (parent role now allowed)
                          ├─ ownership check (canAccessInvoiceForStudent)
                          └─ generateReceipt (re-generates; upsert overwrites the same storage path)
```

## Error Handling

- **Receipt generation throws** (Puppeteer error, storage upload failure, missing school): caught in `notifyPaymentReceipt`, logged via `logger.error`, payment recording is unaffected (already committed in its own transaction before this runs).
- **No parents linked to student**: `getParentsForStudent` returns `[]`; loop simply sends nothing. Not an error — logged at debug level at most.
- **Duplicate payment recording** (webhook + callback both firing for the same Paystack reference): the existing `23505` unique-constraint catch already short-circuits before a *new* payment row exists in those paths, so `notifyPaymentReceipt` is never called twice for the same payment. No new de-duplication logic needed.
- **Parent requests a receipt for a payment that isn't theirs**: `403 FORBIDDEN`, same shape as the existing `canAccessInvoiceForStudent` failure response used elsewhere in this file.

## Testing

- Unit: `notifyPaymentReceipt` — mock `getPaymentById`/`generateReceipt`/`getParentsForStudent`/`sendEmail`; assert correct call sequence and that a thrown error from any step is caught and logged, not propagated.
- Unit: receipt route — parent with linked student gets `200`; parent without linked student gets `403`; staff roles unaffected (existing tests should still pass).
- Integration-style (existing `fees.test.ts` pattern): recording a payment via each of the three call sites triggers exactly one `notifyPaymentReceipt` call when a new payment is created, and zero calls on the duplicate-webhook path.

## Out of Scope

- Student-portal receipt access (explicitly deferred per user decision).
- PDF email attachments (link-only, per user decision — avoids extending `emailService.ts`).
- SMS notification of receipt availability (existing fee-reminder SMS pattern is not reused here; only email).
