# Fees Module — Design Spec

**Date:** 2026-06-11
**Status:** Approved for implementation planning

## Overview

Adds a fees/billing module to Chronix Edu: per-term fee structures (line items), per-student-per-term invoices generated from those structures, and payment recording (cash, bank transfer, Paystack, waiver) with live Paystack verification.

## Permissions Model

| Capability | Roles |
|---|---|
| Create fee structures, generate invoices, record payments | `bursar`, `super_admin` |
| View fee structures, outstanding balances, collection summary | `bursar`, `principal`, `super_admin` |
| View own/child's invoice | `parent` (linked child only), `student` (self only), plus all staff roles above |

`school_id` is always derived from `req.params.schoolId` (validated against the JWT via `requireSchoolAccess`), never from the request body — per existing rules S1/C9.

## Database Schema (`migrations/011_add_fees_tables.sql`)

### New enums

```sql
CREATE TYPE chronixedu_payment_method AS ENUM ('cash','bank_transfer','paystack','waiver');
CREATE TYPE chronixedu_invoice_status AS ENUM ('unpaid','partial','paid');
```

### `fee_structures`

One row per fee component (e.g. "Tuition", "Sports Levy").

```sql
id              UUID PK DEFAULT gen_random_uuid()
school_id       UUID NOT NULL REFERENCES schools(id)
class_id        UUID REFERENCES classes(id)        -- NULL = applies to all classes (school-wide)
term_id         UUID NOT NULL REFERENCES terms(id)
component_name  TEXT NOT NULL
amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
is_mandatory    BOOLEAN NOT NULL DEFAULT TRUE
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

Indexes: `school_id`, `(term_id, class_id)`

### `fee_invoices`

One row per student per term.

```sql
id            UUID PK DEFAULT gen_random_uuid()
school_id     UUID NOT NULL REFERENCES schools(id)
student_id    UUID NOT NULL REFERENCES students(id)
term_id       UUID NOT NULL REFERENCES terms(id)
total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0
amount_paid   NUMERIC(12,2) NOT NULL DEFAULT 0
balance       NUMERIC(12,2) NOT NULL DEFAULT 0
status        chronixedu_invoice_status NOT NULL DEFAULT 'unpaid'
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at    TIMESTAMPTZ
```

`UNIQUE (student_id, term_id)` — required for the upsert in `/fee-invoices/generate`.
Indexes: `school_id`, `(school_id, term_id)`, `student_id`

### `payments`

```sql
id                  UUID PK DEFAULT gen_random_uuid()
invoice_id          UUID NOT NULL REFERENCES fee_invoices(id)
school_id           UUID NOT NULL REFERENCES schools(id)
amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0)
payment_date        TIMESTAMPTZ NOT NULL DEFAULT now()
method              chronixedu_payment_method NOT NULL
reference           TEXT
paystack_reference  TEXT
recorded_by         UUID REFERENCES users(id)
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

`UNIQUE (paystack_reference)` — NULLs allowed multiple times (Postgres treats NULL as distinct), so non-Paystack payments are unaffected. Prevents the same Paystack transaction being recorded twice.

Indexes: `invoice_id`, `school_id`

### Row Level Security

Tenant-isolation policies on all three tables, matching the existing `*_tenant_isolation` pattern (`school_id = (auth.jwt() ->> 'school_id')::uuid`). `fee_invoices` additionally gets a parent-read policy mirroring `parent_students_tenant_isolation` (joins through `parent_students` → `students`).

## Query Layer (`apps/api/src/db/queries/fees.ts`)

NUMERIC columns are returned as strings by `pg`; arithmetic is done via `Number(...)`.

| Function | Behavior |
|---|---|
| `insertFeeStructure(schoolId, input)` | Inserts one `fee_structures` row, returns it. |
| `listFeeStructures(schoolId, termId, classId?)` | Lists components for a term. If `classId` given, includes both `class_id = classId` and `class_id IS NULL` (school-wide) rows. |
| `generateInvoices(schoolId, termId, classId)` | Single transaction: 1) resolve the term's `session_id`; 2) find students in `classId` via `student_classes` for that session; 3) compute `total = SUM(amount)` from `fee_structures` where `term_id = termId`, `is_mandatory = true`, and (`class_id = classId` OR `class_id IS NULL`); 4) for each student, `INSERT ... ON CONFLICT (student_id, term_id) DO UPDATE` setting `total_amount = EXCLUDED.total_amount`, recomputing `balance` and `status` from the row's **existing** `amount_paid` (so re-running generate after a fee change preserves payment history). Returns the list of upserted invoices. |
| `getInvoiceByStudent(schoolId, studentId, termId)` | Returns `{ ...invoice, payments: [...] }` ordered by `payment_date`, or `null` if no invoice exists for that student/term. |
| `getOutstandingBalances(schoolId, termId, classId?)` | Students with `balance > 0` for the term, joined with name/admission_no/class for display. |
| `getCollectionSummary(schoolId, termId, classId?)` | Aggregates: `total_expected` (Σ total_amount), `total_collected` (Σ amount_paid), `total_outstanding` (Σ balance), and counts per `status`. |
| `recordPayment(schoolId, invoiceId, paymentInput)` | Transaction: `SELECT ... FOR UPDATE` the invoice (returns `null` if missing/wrong school) → `INSERT INTO payments` → recompute `amount_paid = amount_paid + amount`, `balance = total_amount - amount_paid`, `status` via `deriveStatus(total_amount, amount_paid)` → `UPDATE fee_invoices`. Returns `{ payment, invoice }`. Overpayment is allowed (results in negative `balance`, status `'paid'`); no validation against the existing balance. |

`deriveStatus(totalAmount, amountPaid)`:
- `amountPaid <= 0` → `'unpaid'`
- `amountPaid >= totalAmount` → `'paid'`
- otherwise → `'partial'`

## Paystack Verification (`apps/api/src/services/paystackService.ts`)

Mirrors `smsService.ts`'s native-`fetch` style (no new HTTP client dependency).

- `isPaystackConfigured(): boolean` — `!!process.env.PAYSTACK_SECRET_KEY`
- `verifyPaystackTransaction(reference: string): Promise<{ status: string; amount: number; currency: string } | null>` — calls `GET https://api.paystack.co/transaction/verify/:reference` with `Authorization: Bearer ${PAYSTACK_SECRET_KEY}`. Returns `null` on network/parse error or unexpected response shape. `amount` is converted from kobo to naira (`/100`).

New env var `PAYSTACK_SECRET_KEY`, added to `.env.example` under a new "Payments (Paystack)" section. **Not** added to the `required` startup-check list in `index.ts` (matches `SENDGRID_API_KEY`/`TERMII_API_KEY`, which are optional/feature-gated).

### Paystack flow in `POST /payments`

When `method === 'paystack'`:
1. `paystack_reference` is required (Zod `.refine`).
2. If `!isPaystackConfigured()` → `503 PAYSTACK_NOT_CONFIGURED`.
3. `verifyPaystackTransaction(paystack_reference)` → if `null` → `502 PAYSTACK_VERIFY_FAILED`.
4. If `verification.status !== 'success'` → `400 PAYMENT_NOT_VERIFIED`.
5. No amount-match check — the bursar-entered `amount` is trusted as long as Paystack confirms the transaction succeeded (allows partial recording against a larger transaction).
6. Proceed to `recordPayment`. The `UNIQUE(paystack_reference)` constraint prevents replay (DB error mapped to `409 DUPLICATE_PAYSTACK_REFERENCE`).

## API Routes (`apps/api/src/routes/fees.ts`)

All routes: `verifyToken` → `requireSchoolAccess` → `requireRole(...)` → Zod validation → handler with try/catch → `next(err)`. Response envelope: `{ success: true, data }` / `{ success: false, error: { code, message } }`.

| Method & Path | Roles | Request | Response |
|---|---|---|---|
| `POST /:schoolId/fee-structures` | `bursar`, `super_admin` | Body: `term_id` (uuid), `class_id?` (uuid\|null), `component_name` (string 1-255), `amount` (number ≥0), `is_mandatory?` (bool, default `true`) | `201` created row. Audit-logged: `FEE_STRUCTURE_CREATED` / entity `fee_structures`. |
| `GET /:schoolId/fee-structures` | `bursar`, `principal`, `super_admin` | Query: `term_id` (uuid, required), `class_id?` (uuid) | `200` array of fee structures |
| `POST /:schoolId/fee-invoices/generate` | `bursar`, `super_admin` | Body: `term_id` (uuid), `class_id` (uuid) | `200` array of upserted invoices |
| `GET /:schoolId/fee-invoices/student/:studentId` | `bursar`, `principal`, `super_admin`, `parent`, `student` | Query: `term_id` (uuid, required) | `200` invoice + `payments[]`, or `404 NOT_FOUND` if no invoice. Access enforced by `requireFeeInvoiceAccess` (staff: any student in school; `parent`: via `isParentLinkedToStudent`; `student`: via `findStudentByUserId` matching `studentId`). |
| `GET /:schoolId/fee-invoices/outstanding` | `bursar`, `principal`, `super_admin` | Query: `term_id` (required), `class_id?` | `200` array of `{ student_id, first_name, last_name, admission_no, class_name, total_amount, amount_paid, balance, status }` |
| `GET /:schoolId/fee-invoices/summary` | `bursar`, `principal`, `super_admin` | Query: `term_id` (required), `class_id?` | `200` `{ total_expected, total_collected, total_outstanding, counts: { unpaid, partial, paid } }` |
| `POST /:schoolId/payments` | `bursar`, `super_admin` | Body: `invoice_id` (uuid), `amount` (number >0), `method` (enum), `reference?`, `paystack_reference?` (required iff `method === 'paystack'`) | `201` `{ payment, invoice }`. Audit-logged: `PAYMENT_RECORDED` / entity `payments`. Errors: `404 NOT_FOUND` (invoice), Paystack errors as above, `409 DUPLICATE_PAYSTACK_REFERENCE`. |

### Wiring

`apps/api/src/index.ts`:
```ts
import feesRoutes from './routes/fees';
// ...
app.use('/api/schools', feesRoutes);
```

## Testing Plan (TDD)

- `apps/api/src/__tests__/feesQueries.test.ts` — unit tests for `db/queries/fees.ts`, mocking `pool.query` / `pool.connect()` (transaction mocks for `generateInvoices` and `recordPayment`), modeled on `schoolQueries.test.ts`.
- `apps/api/src/__tests__/fees.test.ts` — route tests via `supertest` + signed JWTs, mocking `db/queries/fees`, `db/queries/auditLog`, and `services/paystackService`, modeled on `schools.test.ts`. Covers: validation errors, role/ownership enforcement (incl. parent/student access to `/fee-invoices/student/:studentId`), generate upsert, and all Paystack verification branches (success, not configured, verify failure, status≠success, duplicate reference).

## Out of Scope

- Frontend UI for the fees module.
- Paystack webhook handling (this spec covers synchronous verify-on-record only).
- Refunds / payment reversal.
- Multi-currency support.
