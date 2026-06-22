# Payment Receipt Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any payment is recorded (cash, bank transfer, waiver, or Paystack), automatically generate a PDF receipt and email a link to it to the student's parent(s); also let parents download a receipt for their own child's payment on demand from the parent fees page.

**Architecture:** A new `notifyPaymentReceipt()` helper in its own service file is called, unawaited, from the three existing `recordPayment()` call sites in `apps/api/src/routes/fees.ts`. It fetches the full payment record, generates the PDF (reusing the existing `generateReceipt`), looks up linked parents, and emails each a link — swallowing and logging any error internally so a receipt failure never affects the payment response. The existing staff-only receipt download route is extended to also allow the owning parent.

**Tech Stack:** Express, TypeScript, Jest + Supertest, Puppeteer (existing), Handlebars (existing), Next.js (parent fees page).

## Global Constraints

- Receipt generation/email must never block or fail the HTTP response for payment recording, the Paystack callback redirect, or the Paystack webhook ack (per spec).
- No changes to `emailService.ts` — receipts are delivered as a link, not an attachment (per spec).
- Student-portal receipt access is explicitly out of scope (per spec).
- Follow existing patterns in this codebase exactly: Zod validation style, `requireRole`/`requireSchoolAccess` middleware order, `logger.error(eventName, metaObject)` call shape, `jest.mock` + `jest.Mocked<typeof module>` test style already used in `fees.test.ts` and `feesQueries.test.ts`.

---

### Task 1: Add `student_id` to the payment-receipt query

**Files:**
- Modify: `apps/api/src/db/queries/fees.ts` (the `PaymentReceiptRow` interface and `getPaymentById` SQL, both currently around line 234-268)
- Test: `apps/api/src/__tests__/feesQueries.test.ts` (existing `describe('getPaymentById', ...)` block, around line 438)

**Interfaces:**
- Produces: `PaymentReceiptRow` now includes `student_id: string`, used by Task 4's authorization check.

- [ ] **Step 1: Update the failing test to expect `student_id`**

In `apps/api/src/__tests__/feesQueries.test.ts`, find the `getPaymentById` test (around line 438-456) and add `student_id` to the mock row:

```ts
describe('getPaymentById', () => {
  it('returns the payment with invoice/student/term details for the school', async () => {
    const row = {
      id: 'pay-1', invoice_id: 'inv-1', school_id: 'school-1', amount: '10000.00',
      payment_date: '2026-06-11', method: 'cash', reference: 'RCT-2', paystack_reference: null,
      recorded_by: 'user-1', created_at: '',
      student_id: 'student-1',
      total_amount: '15000.00', amount_paid: '15000.00', balance: '0.00', invoice_status: 'paid',
      first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
      class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await getPaymentById('school-1', 'pay-1');

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('fi.student_id'),
      ['pay-1', 'school-1']
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest apps/api/src/__tests__/feesQueries.test.ts -t "getPaymentById"`
Expected: FAIL — the SQL string does not yet contain `fi.student_id`, so the `expect(mockQuery).toHaveBeenCalledWith(...)` assertion fails.

- [ ] **Step 3: Add `student_id` to the interface and the query**

In `apps/api/src/db/queries/fees.ts`, update `PaymentReceiptRow`:

```ts
export interface PaymentReceiptRow extends PaymentRow {
  student_id: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
  invoice_status: 'unpaid' | 'partial' | 'paid';
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
  term_name: string;
  session_name: string;
}
```

Update the `getPaymentById` SQL (the `SELECT` inside it) to add `fi.student_id,` right after `p.created_at,`:

```ts
export async function getPaymentById(schoolId: string, paymentId: string): Promise<PaymentReceiptRow | null> {
  const result = await pool.query<PaymentReceiptRow>(
    `SELECT
       p.id, p.invoice_id, p.school_id, p.amount, p.payment_date, p.method,
       p.reference, p.paystack_reference, p.recorded_by, p.created_at,
       fi.student_id,
       fi.total_amount, fi.amount_paid, fi.balance, fi.status AS invoice_status,
       u.first_name, u.last_name, s.admission_no,
       c.name AS class_name,
       t.name AS term_name, sess.name AS session_name
     FROM payments p
     JOIN fee_invoices fi ON fi.id = p.invoice_id
     JOIN students s ON s.id = fi.student_id
     JOIN users u ON u.id = s.user_id
     JOIN terms t ON t.id = fi.term_id
     JOIN sessions sess ON sess.id = t.session_id
     LEFT JOIN student_classes sc ON sc.student_id = fi.student_id AND sc.session_id = t.session_id
     LEFT JOIN classes c ON c.id = sc.class_id
     WHERE p.id = $1 AND p.school_id = $2`,
    [paymentId, schoolId]
  );
  return result.rows[0] ?? null;
}
```

(The rest of the function body — the `return result.rows[0] ?? null;` line and the closing brace — is unchanged; only the `SELECT` column list and interface gain `student_id`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest apps/api/src/__tests__/feesQueries.test.ts -t "getPaymentById"`
Expected: PASS

- [ ] **Step 5: Run the full fees query test file to check nothing else broke**

Run: `npx jest apps/api/src/__tests__/feesQueries.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/queries/fees.ts apps/api/src/__tests__/feesQueries.test.ts
git commit -m "Add student_id to payment receipt query for parent authorization"
```

---

### Task 2: Create the payment receipt notifier service

**Files:**
- Create: `apps/api/src/services/paymentReceiptNotifier.ts`
- Test: `apps/api/src/__tests__/paymentReceiptNotifier.test.ts` (new)

**Interfaces:**
- Consumes: `getPaymentById(schoolId, paymentId): Promise<PaymentReceiptRow | null>` from `../db/queries/fees` (Task 1's updated shape); `getParentsForStudent(studentId): Promise<{ parent_id: string; email: string; phone: string | null }[]>` from `../db/queries/parents`; `generateReceipt(schoolId, payment): Promise<string>` from `./receiptService`; `sendEmail(to, subject, text): Promise<void>` from `./emailService`; `logger` from `../config/logger`.
- Produces: `notifyPaymentReceipt(schoolId: string, paymentId: string, studentId: string): Promise<void>` — never rejects. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/paymentReceiptNotifier.test.ts`:

```ts
import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
import * as feesQueries from '../db/queries/fees';
import * as parentQueries from '../db/queries/parents';
import * as receiptService from '../services/receiptService';
import * as emailService from '../services/emailService';

jest.mock('../db/queries/fees');
jest.mock('../db/queries/parents');
jest.mock('../services/receiptService');
jest.mock('../services/emailService');
jest.mock('../config/logger', () => ({ logger: { error: jest.fn() } }));

const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockParents = parentQueries as jest.Mocked<typeof parentQueries>;
const mockReceipt = receiptService as jest.Mocked<typeof receiptService>;
const mockEmail = emailService as jest.Mocked<typeof emailService>;

const SCHOOL_ID = 'school-1';
const PAYMENT_ID = 'pay-1';
const STUDENT_ID = 'student-1';
const PAYMENT_AMOUNT = 10000;
const INVOICE_TOTAL_AMOUNT = 15000;

const PAYMENT_ROW = {
  id: PAYMENT_ID, invoice_id: 'inv-1', school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
  payment_date: '2026-06-22', method: 'cash', reference: 'RCT-1', paystack_reference: null,
  recorded_by: 'user-1', created_at: '', student_id: STUDENT_ID,
  total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, invoice_status: 'paid',
  first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
  class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
};

beforeEach(() => jest.clearAllMocks());

describe('notifyPaymentReceipt', () => {
  it('generates the receipt and emails every linked parent a link', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: 'p1', email: 'parent1@example.com', phone: null },
      { parent_id: 'p2', email: 'parent2@example.com', phone: null },
    ] as never);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockFees.getPaymentById).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_ID);
    expect(mockReceipt.generateReceipt).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_ROW);
    expect(mockParents.getParentsForStudent).toHaveBeenCalledWith(STUDENT_ID);
    expect(mockEmail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent1@example.com',
      'Payment receipt — Chronix Edu',
      expect.stringContaining('https://storage.example/receipts/pay-1.pdf')
    );
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent2@example.com',
      'Payment receipt — Chronix Edu',
      expect.stringContaining('https://storage.example/receipts/pay-1.pdf')
    );
  });

  it('does nothing but log when the payment cannot be found', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(null);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockReceipt.generateReceipt).not.toHaveBeenCalled();
    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when no parents are linked to the student', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([]);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when receipt generation fails', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockRejectedValueOnce(new Error('Puppeteer crashed'));

    await expect(notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID)).resolves.toBeUndefined();
    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when getPaymentById itself throws', async () => {
    mockFees.getPaymentById.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest apps/api/src/__tests__/paymentReceiptNotifier.test.ts`
Expected: FAIL with `Cannot find module '../services/paymentReceiptNotifier'`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/paymentReceiptNotifier.ts`:

```ts
import { getPaymentById } from '../db/queries/fees';
import { getParentsForStudent } from '../db/queries/parents';
import { generateReceipt } from './receiptService';
import { sendEmail } from './emailService';
import { logger } from '../config/logger';

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Generates a PDF receipt for a newly recorded payment and emails a link to every
 *  parent linked to the student. Never throws — a receipt failure must never affect
 *  the payment it's reporting on, which has already succeeded by the time this runs. */
export async function notifyPaymentReceipt(schoolId: string, paymentId: string, studentId: string): Promise<void> {
  try {
    const payment = await getPaymentById(schoolId, paymentId);
    if (!payment) {
      logger.error('payment_receipt_notify_payment_not_found', { schoolId, paymentId });
      return;
    }

    const url = await generateReceipt(schoolId, payment);
    const parents = await getParentsForStudent(studentId);

    const subject = 'Payment receipt — Chronix Edu';
    const body =
      `Dear Parent,\n\n` +
      `We have received a payment of ${formatCurrency(payment.amount)} for ${payment.first_name} ${payment.last_name}.\n\n` +
      `You can view and download your receipt here:\n${url}\n\n` +
      `Thank you,\nChronix Edu`;

    for (const parent of parents) {
      await sendEmail(parent.email, subject, body);
    }
  } catch (err) {
    logger.error('payment_receipt_notify_failed', {
      schoolId,
      paymentId,
      studentId,
      error: err instanceof Error ? err.message : err,
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest apps/api/src/__tests__/paymentReceiptNotifier.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/paymentReceiptNotifier.ts apps/api/src/__tests__/paymentReceiptNotifier.test.ts
git commit -m "Add notifyPaymentReceipt service for automatic receipt emails"
```

---

### Task 3: Trigger the notifier from all three payment-recording call sites

**Files:**
- Modify: `apps/api/src/routes/fees.ts` (imports near the top; the three `recordPayment` call sites — `POST /:schoolId/payments` around line 330-388, the Paystack callback around line 493-555, and the Paystack webhook around line 568-626)
- Test: `apps/api/src/__tests__/fees.test.ts` (existing mock setup at the top, and the three corresponding `describe` blocks)

**Interfaces:**
- Consumes: `notifyPaymentReceipt(schoolId, paymentId, studentId): Promise<void>` from Task 2.

- [ ] **Step 1: Update the test mocks, extract shared fixture constants, and add failing assertions**

In `apps/api/src/__tests__/fees.test.ts`, add the import and mock near the top (after the existing `receiptService` mock, around line 11-21):

```ts
import * as paymentReceiptNotifier from '../services/paymentReceiptNotifier';
```

```ts
jest.mock('../services/paymentReceiptNotifier');
```

Add the typed mock alongside the others (around line 29):

```ts
const mockNotifier = paymentReceiptNotifier as jest.Mocked<typeof paymentReceiptNotifier>;
```

Add two new named constants next to the existing `PAYMENT_ID` constant (around line 53), so the recurring fixture amounts below are named instead of repeated as bare numbers:

```ts
const PAYMENT_AMOUNT = 10000;
const INVOICE_TOTAL_AMOUNT = 15000;
```

In the `describe('POST /api/schools/:schoolId/payments', ...)` block, update the `PAYMENT_RESULT` fixture (around line 405-416) to use the new constants instead of literals:

```ts
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'cash', reference: 'RCT-1', paystack_reference: null,
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };
```

In that same block's `'records a cash payment and logs audit'` test (around line 418-434), use the constant in the request body too, and add the new assertion after the existing `expect(mockAudit.logAudit)...` call:

```ts
  it('records a cash payment and logs audit', async () => {
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: PAYMENT_AMOUNT, method: 'cash', reference: 'RCT-1' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(PAYMENT_RESULT);
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'cash', reference: 'RCT-1', paystack_reference: null, recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });
```

In the `describe('GET /api/schools/:schoolId/payments/paystack/callback', ...)` block, update its own `PAYMENT_RESULT` and `SUCCESS_VERIFICATION` fixtures (around line 727-746) the same way:

```ts
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const SUCCESS_VERIFICATION = {
    status: 'success',
    amount: PAYMENT_AMOUNT,
    currency: 'NGN',
    reference: 'ref-xyz',
    metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
  };
```

Then add the assertion to the `'verifies the transaction, records the payment, and redirects with payment=success'` test (after the existing `logAudit` assertion, around line 761):

```ts
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
```

In the `describe('POST /api/schools/:schoolId/payments/paystack/webhook', ...)` block, update its `PAYMENT_RESULT` and `CHARGE_SUCCESS_EVENT` fixtures (around line 831-851) — note Paystack reports amounts in kobo (amount × 100), so this uses `PAYMENT_AMOUNT * 100` rather than the unrelated literal `1000000`:

```ts
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const CHARGE_SUCCESS_EVENT = {
    event: 'charge.success',
    data: {
      reference: 'ref-xyz',
      amount: PAYMENT_AMOUNT * 100,
      metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
    },
  };
```

Then add the assertion to the `'records the payment on charge.success and logs audit'` test (after the existing `logAudit` assertion, around line 904):

```ts
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
```

Also add a negative assertion to the duplicate-webhook test (`'returns processed:false (duplicate) for an already-recorded paystack reference'`, around line 937) to lock in that the duplicate path never triggers a notification:

```ts
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest apps/api/src/__tests__/fees.test.ts -t "records a cash payment and logs audit"`
Expected: FAIL — `notifyPaymentReceipt` was never called because the route doesn't call it yet.

- [ ] **Step 3: Wire the import and the three call sites**

In `apps/api/src/routes/fees.ts`, add the import near the other service imports (after the `generateReceipt` import, around line 21):

```ts
import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
```

In the `POST /:schoolId/payments` handler, immediately after the existing `if (!result) { return res.status(404)... }` check and before `await logAudit(...)` (around line 367-371):

```ts
      if (!result) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invoice not found' } });
      }

      notifyPaymentReceipt(req.params.schoolId, result.payment.id, result.invoice.student_id);

      await logAudit({
```

In the Paystack callback handler, immediately after its `if (!result) { return res.redirect(...) }` check and before the `if (metadata.recorded_by)` block (around line 529-533):

```ts
        if (!result) {
          return res.redirect(`${redirectBase}?payment=error&reason=invoice_not_found`);
        }

        notifyPaymentReceipt(schoolId, result.payment.id, result.invoice.student_id);

        if (metadata.recorded_by) {
```

In the Paystack webhook handler, immediately after its `if (!result) { return res.status(200)... }` check and before the `if (metadata.recorded_by)` block (around line 600-604):

```ts
        if (!result) {
          return res.status(200).json({ success: true, data: { processed: false } });
        }

        notifyPaymentReceipt(req.params.schoolId, result.payment.id, result.invoice.student_id);

        if (metadata.recorded_by) {
```

Note: `notifyPaymentReceipt` is called without `await` and without `.catch(...)` — it already swallows and logs every internal error itself (Task 2), so there's nothing for the caller to handle. This keeps all three response paths exactly as fast as they are today.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest apps/api/src/__tests__/fees.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/fees.ts apps/api/src/__tests__/fees.test.ts
git commit -m "Trigger receipt notification from all payment recording paths"
```

---

### Task 4: Allow parents to download their own child's receipt

**Files:**
- Modify: `apps/api/src/routes/fees.ts` (the `GET /:schoolId/payments/:paymentId/receipt` route, around line 392-412)
- Test: `apps/api/src/__tests__/fees.test.ts` (the `describe('GET /api/schools/:schoolId/payments/:paymentId/receipt', ...)` block, around line 955-999)

**Interfaces:**
- Consumes: `canAccessInvoiceForStudent(user, schoolId, studentId): Promise<boolean>` — already defined in this same file (line 47), unchanged.
- Consumes: `PaymentReceiptRow.student_id` from Task 1.

- [ ] **Step 1: Replace the parent test and add a new authorized-parent test**

In `apps/api/src/__tests__/fees.test.ts`, replace the existing `'returns 403 for parent'` test (around line 991-998) with:

```ts
  it('returns the receipt for a parent linked to the student', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_RECEIPT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/payments/${PAYMENT_ID}/receipt`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://storage.example/receipts/pay-1.pdf' });
    expect(mockParents.isParentLinkedToStudent).toHaveBeenCalledWith('user-uuid-001', STUDENT_ID);
  });

  it('returns 403 for a parent not linked to the student', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_RECEIPT_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(false);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/payments/${PAYMENT_ID}/receipt`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
    expect(mockReceipt.generateReceipt).not.toHaveBeenCalled();
  });
```

Also update the existing `PAYMENT_RECEIPT_ROW` fixture in that same `describe` block (around line 956-963) to add `student_id: STUDENT_ID` (the route now reads it) and to use the shared `PAYMENT_AMOUNT`/`INVOICE_TOTAL_AMOUNT` constants from Task 3 instead of bare literals:

```ts
  const PAYMENT_RECEIPT_ROW = {
    id: PAYMENT_ID, invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
    payment_date: '2026-06-11', method: 'cash', reference: 'RCT-1', paystack_reference: null,
    recorded_by: 'user-uuid-001', created_at: '',
    student_id: STUDENT_ID,
    total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, invoice_status: 'paid',
    first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
    class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
  };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest apps/api/src/__tests__/fees.test.ts -t "receipt"`
Expected: FAIL — the route currently has no `parent` case in `requireRole`, so a parent request gets `403` before reaching the handler, and `isParentLinkedToStudent` is never called.

- [ ] **Step 3: Update the route**

In `apps/api/src/routes/fees.ts`, replace the `GET /:schoolId/payments/:paymentId/receipt` route (around line 392-412):

```ts
router.get(
  '/:schoolId/payments/:paymentId/receipt',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin', 'parent'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, paymentId } = req.params;

      const payment = await getPaymentById(schoolId, paymentId);
      if (!payment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Payment not found' } });
      }

      if (req.user!.role === 'parent') {
        const allowed = await canAccessInvoiceForStudent(req.user!, schoolId, payment.student_id);
        if (!allowed) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const url = await generateReceipt(schoolId, payment);
      return res.json({ success: true, data: { url } });
    } catch (err) {
      return next(err);
    }
  }
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest apps/api/src/__tests__/fees.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run the full API unit test suite to confirm nothing else regressed**

Run: `npm run test:unit`
Expected: all suites PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/fees.ts apps/api/src/__tests__/fees.test.ts
git commit -m "Allow parents to download receipts for their own child's payments"
```

---

### Task 5: Add a "Download Receipt" button to the parent fees page

**Files:**
- Modify: `apps/web/app/(parent)/parent/fees/page.tsx`

**Interfaces:**
- Consumes: `GET /api/schools/:schoolId/payments/:paymentId/receipt` (now parent-accessible per Task 4), via the existing `apiFetch` helper from `@/lib/api`.

This task has no backend logic to unit-test — it's a frontend wiring change. Verification is manual (Step 4 below), matching how `downloadReceipt` was verified on the bursar invoices page.

- [ ] **Step 1: Add the `downloadReceipt` handler**

In `apps/web/app/(parent)/parent/fees/page.tsx`, add a new piece of state and a handler function. Add the state near the other `useState` declarations (after `paymentStatus`, around line 53):

```ts
  const [receiptError, setReceiptError] = useState('');
```

Add the handler function near `handlePayNow` (after it, around line 125):

```ts
  async function downloadReceipt(paymentId: string) {
    if (!schoolId) return;
    setReceiptError('');
    try {
      const res = await apiFetch<{ success: boolean; data: { url: string } }>(
        `/api/schools/${schoolId}/payments/${paymentId}/receipt`
      );
      window.open(res.data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setReceiptError(err instanceof Error ? err.message : 'Failed to generate receipt');
    }
  }
```

- [ ] **Step 2: Add the button to the payment history list**

In the same file, find the payment history rendering block (around line 230-246):

```tsx
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment History</h2>
            {invoice.payments.length === 0 ? (
              <p className="text-sm text-gray-500">No payments have been recorded yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {invoice.payments.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <p className="text-gray-900 font-medium">{formatCurrency(p.amount)}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(p.payment_date).toLocaleDateString()} · {p.method.replace('_', ' ')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
```

Replace it with (adds the error banner and a download button per row):

```tsx
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment History</h2>
            {receiptError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700 mb-3">{receiptError}</div>
            )}
            {invoice.payments.length === 0 ? (
              <p className="text-sm text-gray-500">No payments have been recorded yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {invoice.payments.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <p className="text-gray-900 font-medium">{formatCurrency(p.amount)}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(p.payment_date).toLocaleDateString()} · {p.method.replace('_', ' ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadReceipt(p.id)}
                      className="text-xs font-medium text-[#2472B4] hover:underline"
                    >
                      Download Receipt
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
```

- [ ] **Step 3: Typecheck the web app**

Run: `npx tsc --project apps/web/tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 4: Manual verification**

Run: `npm run dev:web` (and `npm run dev:api` in a second terminal if not already running)
Steps:
1. Log in as a parent with at least one linked child who has a recorded payment (any seeded test parent account works — see `chronixedu-test-credentials.html` if you have it locally)
2. Go to the Fees page
3. Confirm a "Download Receipt" link appears next to each row in Payment History
4. Click it — confirm a PDF opens in a new tab matching the existing receipt layout
5. Confirm there is no console error and the rest of the page (Pay Now button, balance figures) still renders normally

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(parent)/parent/fees/page.tsx"
git commit -m "Add Download Receipt button to parent fees payment history"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Automatic generation+email on all 3 record-payment paths → Tasks 2-3. Parent receipt access → Task 4. Frontend button → Task 5. `student_id` gap identified in the spec's own "Current State" section → Task 1. Error handling (never block, never throw, log only) → built into Task 2's implementation and tests. Duplicate-webhook non-trigger → covered by the added negative assertion in Task 3, Step 1.
- **Out of scope confirmed not touched:** no `emailService.ts` changes, no student-portal changes, no PDF attachments.
- **Type consistency:** `notifyPaymentReceipt(schoolId: string, paymentId: string, studentId: string): Promise<void>` is defined once in Task 2 and called identically (same parameter order) at all three sites in Task 3.
- **Fixture hardcoding (user feedback, addressed):** `fees.test.ts` fixtures for the payment/invoice blocks this plan touches (Task 3's three `PAYMENT_RESULT` fixtures plus Task 4's `PAYMENT_RECEIPT_ROW`) now reference shared `PAYMENT_AMOUNT`/`INVOICE_TOTAL_AMOUNT` constants instead of repeating bare `10000`/`15000` literals, matching the file's existing `SCHOOL_ID`/`INVOICE_ID`/`PAYMENT_ID` constant convention. The webhook fixture's kobo amount is expressed as `PAYMENT_AMOUNT * 100` rather than the unrelated-looking literal `1000000`. The new `paymentReceiptNotifier.test.ts` (Task 2) follows the same convention from the start. `feesQueries.test.ts` (Task 1) is left in its existing local-fixture style — it's a different file with its own string-typed-amount convention (matching raw DB numeric-as-string returns) and wasn't part of the flagged selection; changing it would be unrelated scope creep.
