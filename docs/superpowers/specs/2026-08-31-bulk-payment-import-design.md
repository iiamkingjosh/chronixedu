# Bulk Payment Import — Design

## Overview

A bursar or super_admin can upload a spreadsheet of historical/pre-implementation payments — students who paid their fees (in cash, by bank transfer, or via a fee waiver) before their school started using Chronix Edu — and record them in bulk against each student's existing invoice for a chosen term, instead of using the "Record Payment" form one student at a time.

This is the 4th of 4 approved bulk-import features (after Students & Parents, Roster, Staff/Users). Its scope is narrower than originally approved: rather than bulk-creating fee structure *definitions* (which don't help with the actual problem — a school onboarding mid-term with students who already paid), this feature bulk-records *payments* against invoices that already exist, reusing the exact logic the live "Record Payment" endpoint already uses.

## Problem This Solves

When a school starts using Chronix Edu partway through a term (or year), some students will have already paid some or all of their fees through the school's previous (offline) process. The system needs to know this so:
- Those students aren't shown as owing money they've already paid.
- Anything gated on fee-payment status (if any exists or is added later) behaves correctly for them.
- The school's financial records in the new system are accurate from day one.

The underlying capability already exists: `POST /:schoolId/payments` lets a bursar record a `cash`/`bank_transfer`/`waiver` payment against any invoice, and it correctly recomputes the invoice's `amount_paid`/`balance`/`status`. The gap is doing this for 100+ students one at a time during onboarding.

## Precondition: Invoices Must Already Exist

`fee_invoices` rows are created by a separate step, `generateInvoices(schoolId, termId, classId)` — it sums that class's `fee_structures` for the term and creates one invoice per enrolled student. This feature does **not** generate invoices. If a row's student has no invoice for the chosen term (fee structures/invoice generation wasn't done for their class yet), that row fails with a clear error telling the bursar to generate invoices for that class/term first. This keeps the feature focused on recording payments, not invoice setup.

## Scope

**In scope:** recording `cash`/`bank_transfer`/`waiver` payments in bulk against existing invoices, for one term per import.

**Out of scope:**
- Generating invoices (a row without an existing invoice fails, per above).
- Bulk-creating fee structure definitions — schools set these up once via the existing one-at-a-time flow; it's rarely done at volume, unlike payment reconciliation during onboarding.
- Recording `paystack`-method payments in bulk — Paystack payments are always verified against Paystack's API per-transaction (see the live endpoint's `verifyPaystackTransaction` call); there's no bulk equivalent, and there shouldn't be, since a spreadsheet can't carry a verifiable live transaction reference for a real Paystack charge.
- A new `migration`/`historical` payment-method enum value — bulk-imported payments use the same `cash`/`bank_transfer`/`waiver` values a bursar would pick live, so existing reporting/filtering by method needs no changes.

## File Format

`.xlsx` or `.csv`, one flat sheet — matching Students & Parents (a single flat table has no multi-sheet constraint).

## Term Selection

The term is picked **once per import** (via a dropdown on the upload screen, sent alongside the file), not as a per-row column. Reconciliation is naturally done per-term ("import all of Term 1 2025/2026's historical payments"), and this keeps the file simpler. The preview and commit endpoints both take a `term_id` field alongside the uploaded file.

## Columns

| Column | Required | Notes |
|---|---|---|
| `Admission Number` | Yes | Identifies the student. Chosen over email because every student has one (school-assigned, per-school unique) and it's what a bursar's existing offline records would already reference — unlike student email, which is optional and often blank. |
| `Amount` | Yes | A positive number. Validated against the invoice's outstanding balance (see Validation). |
| `Method` | Yes | One of `cash`, `bank_transfer`, `waiver` (case-insensitive, normalized to lowercase). `paystack` is rejected — see Scope. |
| `Payment Date` | No | `YYYY-MM-DD`. If blank, defaults to the moment the row is committed (matching the live endpoint's current behavior). If given, the recorded payment's `payment_date` is backdated to this value — needed for accurate financial history when reconciling months-old payments. |
| `Reference` | No | Free text (e.g. a receipt number from the school's old records). Stored in `payments.reference`. |

## Validation Rules

Per-row checks:
- Admission Number resolves to an existing, active student in this school.
- Amount is a positive number.
- Method is one of `cash`/`bank_transfer`/`waiver`.
- Payment Date, if given, is a valid `YYYY-MM-DD` date not in the future.

Invoice-resolution and payment-recording checks (reusing `recordPayment()`'s existing logic, not reimplemented):
- The student has an existing `fee_invoices` row for the chosen term — if not, the row fails with "No invoice found for this student for this term. Generate invoices for their class/term first."
- Amount does not exceed the invoice's current outstanding balance (`OverpaymentError`, same as the live endpoint) — this is evaluated at commit time, using each invoice's balance *as of that point in the commit's processing order*, since two rows in the same file could target the same student's invoice (e.g. two partial historical payments).
- The existing 5-minute duplicate-detection window (same invoice + method + amount within 5 minutes) applies exactly as it does today — this is inherited behavior, not a new bulk-specific rule. In practice this only matters if two rows in the same file share the same invoice, method, and amount; each row is processed in its own `recordPayment()` transaction, so the second matching row would be rejected as a duplicate, exactly as it would if a bursar submitted the same values twice by hand within 5 minutes.

No duplicate-detection *within the file* beyond what `recordPayment()` already provides — unlike the other bulk-import features, there's no natural "this looks like the same logical record" key for payments the way there is for a student row or a class name; two genuinely different installments can share amount and method.

## Endpoints

**`POST /:schoolId/payments-bulk-import/preview`**
- Auth: `bursar`, `super_admin` only — matches the existing single-item `POST /:schoolId/payments` route's gate exactly (this differs from the other three bulk-import features, which are principal-gated; payment recording has always been a bursar responsibility in this app, not a principal one).
- Takes the uploaded file plus a `term_id` field. Parses and validates every row, including resolving each Admission Number to a student and confirming an invoice exists for the chosen term. **Writes nothing.**
- Row cap: starting at 100 rows — see Row Cap below.

**`POST /:schoolId/payments-bulk-import/commit`**
- Same auth gate, same `term_id` requirement.
- Re-validates every row from scratch — never trusts the client-supplied `status`/`errors` fields from preview.
- For each valid row, calls the existing `recordPayment()` function (the same one the live single-item endpoint calls) — not a reimplementation. Each row's call is `recordPayment()`'s own transaction; one row's failure doesn't stop the batch.
- Returns per-row created/failed status plus a downloadable `.xlsx` results file (columns: row #, admission number, student name, amount, method, status, reason-if-failed).

## Schema Change

`recordPayment()`'s `PaymentInput` currently has no `payment_date` field — the `payments` table always gets `NOW()` via its column default. Extend `PaymentInput` with an optional `payment_date?: string | null`; when provided, pass it explicitly in the `INSERT` instead of relying on the column default. This is backward-compatible: the live single-item endpoint doesn't pass one and keeps behaving exactly as it does today.

## Row Cap

Each row's cost is one `recordPayment()` transaction: a row-locked invoice lookup, an optional duplicate check, one insert, one update — lighter than `registerStudent()` (which does a student insert plus up to two parent inserts/lookups) and entirely DB-local, with no external API calls (unlike Staff/Users' Supabase Auth calls). A starting cap of 100 rows is proposed, pending the same kind of real timing measurement the other three features required before their final caps were set — this spec does not guess a final number; the implementation plan must measure it.

## Testing

- Unit tests for the parser (column matching, blank-row skipping, method/date normalization).
- Unit tests for validation (required fields, method enum, date format, and the injected invoice-lookup/recordPayment stubs for testability without a real database).
- Integration tests for both endpoints against a real test school: role-gate rejection (principal/registrar tokens get 403 — this feature is bursar-gated, not principal-gated), a successful payment recorded against an existing invoice with correct balance/status recomputation, a missing-invoice rejection, an overpayment rejection, a backdated Payment Date correctly stored, and a partial-failure commit (one row succeeds, one fails, batch continues).
- A real end-to-end timing measurement at the chosen row cap, per Row Cap above.

## Decisions Made

1. **Scope**: bulk payment recording only, not fee structure definitions or invoice generation — the actual pain point is reconciling historical payments at onboarding volume, not the rarely-repeated one-time fee-structure setup.
2. **Missing invoice**: row fails with a clear error; no auto-generation.
3. **Payment date**: accepts an optional historical date per row (requires extending `recordPayment()`'s `PaymentInput`, backward-compatible).
4. **Payment method**: reuses the existing `cash`/`bank_transfer`/`waiver` enum values; no new `migration` method, no schema migration needed for the enum.
5. **Student identification**: Admission Number, not email (every student has one; email is optional and often blank).
6. **Term scope**: one term selected per import, not a per-row column.
7. **Role gate**: `bursar`/`super_admin`, matching the existing single-item payment endpoint exactly.
