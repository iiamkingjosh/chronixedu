import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { verifyToken, requireRole, AuthUser } from '../middleware/auth';
import { requireFeature } from '../middleware/requireFeature';
import { logAudit } from '../db/queries/auditLog';
import { isParentLinkedToStudent } from '../db/queries/parents';
import { findStudentByUserId } from '../db/queries/students';
import { getActiveTerm } from '../db/queries/roster';
import { getSchoolPayoutConfig } from '../db/queries/schools';
import { sendFeeRemindersForSchool } from '../services/feeReminderService';
import {
  insertFeeStructure,
  listFeeStructures,
  generateInvoices,
  getInvoiceByStudent,
  getInvoiceById,
  listInvoices,
  getOutstandingBalances,
  getCollectionSummary,
  recordPayment,
  getPaymentById,
  DuplicatePaymentError,
  OverpaymentError,
} from '../db/queries/fees';
import { generateReceipt } from '../services/receiptService';
import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
import { signReportCardAsset } from '../services/reportCardService';
import {
  isPaystackConfigured,
  verifyPaystackTransaction,
  initializePaystackTransaction,
} from '../services/paystackService';

const router = Router();

// ── Middleware ─────────────────────────────────────────────────────────────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if (user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

/** Staff (bursar/principal/super_admin) may access any student's invoice in their school;
 *  parents only their linked children; students only their own record. */
async function canAccessInvoiceForStudent(user: AuthUser, schoolId: string, studentId: string): Promise<boolean> {
  if (user.role === 'bursar' || user.role === 'principal' || user.role === 'super_admin') {
    return true;
  }

  if (user.role === 'parent') {
    return isParentLinkedToStudent(user.user_id, studentId);
  }

  if (user.role === 'student') {
    const student = await findStudentByUserId(user.user_id, schoolId);
    return !!student && student.id === studentId;
  }

  return false;
}

async function requireFeeInvoiceAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const allowed = await canAccessInvoiceForStudent(req.user!, req.params.schoolId, req.params.studentId);
  if (allowed) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const feeStructureSchema = z.object({
  term_id: z.string().uuid(),
  class_id: z.string().uuid().nullable().optional(),
  component_name: z.string().min(1).max(255),
  amount: z.number().min(0),
  is_mandatory: z.boolean().optional().default(true),
});

const listFeeStructuresQuerySchema = z.object({
  term_id: z.string().uuid(),
  class_id: z.string().uuid().optional(),
});

const generateInvoicesSchema = z.object({
  term_id: z.string().uuid(),
  class_id: z.string().uuid(),
});

const termQuerySchema = z.object({
  term_id: z.string().uuid(),
});

const reportQuerySchema = z.object({
  term_id: z.string().uuid(),
  class_id: z.string().uuid().optional(),
});

const listInvoicesQuerySchema = z.object({
  term_id: z.string().uuid(),
  class_id: z.string().uuid().optional(),
  status: z.enum(['unpaid', 'partial', 'paid']).optional(),
});

const paystackInitiateSchema = z.object({
  invoice_id: z.string().uuid(),
  amount: z.number().positive().optional(),
});

const paymentSchema = z
  .object({
    invoice_id: z.string().uuid(),
    amount: z.number().positive(),
    method: z.enum(['cash', 'bank_transfer', 'paystack', 'waiver']),
    reference: z.string().min(1).nullable().optional(),
    paystack_reference: z.string().min(1).nullable().optional(),
  })
  .refine((data) => data.method !== 'paystack' || !!data.paystack_reference, {
    message: 'paystack_reference is required when method is paystack',
    path: ['paystack_reference'],
  });

// ── POST /:schoolId/fee-structures ──────────────────────────────────────────────

router.post(
  '/:schoolId/fee-structures',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = feeStructureSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { term_id, class_id, component_name, amount, is_mandatory } = parsed.data;

      const structure = await insertFeeStructure(req.params.schoolId, {
        term_id,
        class_id: class_id ?? null,
        component_name,
        amount,
        is_mandatory,
      });

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'FEE_STRUCTURE_CREATED',
        entity: 'fee_structures',
        entityId: structure.id,
        newValue: structure,
      });

      return res.status(201).json({ success: true, data: structure });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/fee-structures ───────────────────────────────────────────────

router.get(
  '/:schoolId/fee-structures',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listFeeStructuresQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID); optional: class_id (UUID)' },
        });
      }

      const { term_id, class_id } = parsed.data;
      const structures = await listFeeStructures(req.params.schoolId, term_id, class_id);
      return res.json({ success: true, data: structures });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/fee-invoices ─────────────────────────────────────────────────

router.get(
  '/:schoolId/fee-invoices',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listInvoicesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID); optional: class_id (UUID), status (unpaid|partial|paid)' },
        });
      }

      const { term_id, class_id, status } = parsed.data;
      const invoices = await listInvoices(req.params.schoolId, term_id, { classId: class_id, status });
      return res.json({ success: true, data: invoices });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/fee-invoices/generate ───────────────────────────────────────

router.post(
  '/:schoolId/fee-invoices/generate',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = generateInvoicesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { term_id, class_id } = parsed.data;

      const invoices = await generateInvoices(req.params.schoolId, term_id, class_id);
      if (!invoices) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Term not found for this school' } });
      }

      return res.json({ success: true, data: invoices });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/fee-invoices/outstanding ─────────────────────────────────────

router.get(
  '/:schoolId/fee-invoices/outstanding',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID); optional: class_id (UUID)' },
        });
      }

      const { term_id, class_id } = parsed.data;
      const balances = await getOutstandingBalances(req.params.schoolId, term_id, class_id);
      return res.json({ success: true, data: balances });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/fee-invoices/summary ─────────────────────────────────────────

router.get(
  '/:schoolId/fee-invoices/summary',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID); optional: class_id (UUID)' },
        });
      }

      const { term_id, class_id } = parsed.data;
      const summary = await getCollectionSummary(req.params.schoolId, term_id, class_id);
      return res.json({ success: true, data: summary });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/fee-invoices/student/:studentId ──────────────────────────────

router.get(
  '/:schoolId/fee-invoices/student/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'principal', 'super_admin', 'parent', 'student'),
  requireFeeInvoiceAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;
      const { term_id } = parsed.data;

      const invoice = await getInvoiceByStudent(schoolId, studentId, term_id);
      if (!invoice) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No invoice found for this student/term' } });
      }

      return res.json({ success: true, data: invoice });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/payments ─────────────────────────────────────────────────────

router.post(
  '/:schoolId/payments',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { invoice_id, method, reference, paystack_reference } = parsed.data;
      let amount = parsed.data.amount;

      if (method === 'paystack') {
        if (!isPaystackConfigured()) {
          return res.status(503).json({ success: false, error: { code: 'PAYSTACK_NOT_CONFIGURED', message: 'Paystack is not configured for this server' } });
        }

        const verification = await verifyPaystackTransaction(paystack_reference!);
        if (!verification) {
          return res.status(502).json({ success: false, error: { code: 'PAYSTACK_VERIFY_FAILED', message: 'Unable to verify the Paystack transaction' } });
        }

        if (verification.status !== 'success') {
          return res.status(400).json({ success: false, error: { code: 'PAYMENT_NOT_VERIFIED', message: `Paystack transaction status is '${verification.status}', not 'success'` } });
        }

        // All schools share one Paystack merchant account, so a transaction reference
        // is resolvable platform-wide — without this check, a reference belonging to
        // one school's transaction could be recorded against a different school's
        // invoice. Mirrors the binding check the webhook and callback already perform.
        const metadata = (verification.metadata ?? {}) as PaystackPaymentMetadata;
        if (metadata.school_id !== req.params.schoolId || metadata.invoice_id !== invoice_id) {
          return res.status(400).json({ success: false, error: { code: 'PAYMENT_MISMATCH', message: 'This Paystack transaction does not belong to the specified school/invoice' } });
        }

        // Always use Paystack's verified amount — never trust the client-supplied value.
        // verifyPaystackTransaction already converts kobo → naira.
        amount = verification.amount;
      }

      const result = await recordPayment(req.params.schoolId, invoice_id, {
        amount,
        method,
        reference: reference ?? null,
        paystack_reference: paystack_reference ?? null,
        recorded_by: req.user!.user_id,
      });

      if (!result) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invoice not found' } });
      }

      notifyPaymentReceipt(req.params.schoolId, result.payment.id, result.invoice.student_id);

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'PAYMENT_RECORDED',
        entity: 'payments',
        entityId: result.payment.id,
        newValue: result.payment,
      });

      return res.status(201).json({ success: true, data: result });
    } catch (err) {
      if (err instanceof DuplicatePaymentError) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PAYMENT', message: 'A duplicate payment for this invoice was already recorded within the last 5 minutes' } });
      }
      if (err instanceof OverpaymentError) {
        return res.status(400).json({ success: false, error: { code: 'AMOUNT_EXCEEDS_BALANCE', message: err.message } });
      }
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PAYSTACK_REFERENCE', message: 'This Paystack transaction has already been recorded' } });
      }
      return next(err);
    }
  }
);

// ── GET /:schoolId/payments/:paymentId/receipt ───────────────────────────────────

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

      const storagePath = await generateReceipt(schoolId, payment);
      const url = await signReportCardAsset(storagePath);
      if (!url) {
        return res.status(500).json({ success: false, error: { code: 'SIGNING_FAILED', message: 'Failed to generate a download link for the receipt.' } });
      }

      return res.json({ success: true, data: { url } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── Paystack online payments ─────────────────────────────────────────────────────

interface PaystackPaymentMetadata {
  school_id?: string;
  invoice_id?: string;
  recorded_by?: string | null;
}

function getApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

// ── POST /:schoolId/payments/paystack/initiate ───────────────────────────────────

router.post(
  '/:schoolId/payments/paystack/initiate',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'student'),
  requireFeature('online_payments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paystackInitiateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { invoice_id, amount } = parsed.data;
      const schoolId = req.params.schoolId;

      const invoice = await getInvoiceById(schoolId, invoice_id);
      if (!invoice) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invoice not found' } });
      }

      const allowed = await canAccessInvoiceForStudent(req.user!, schoolId, invoice.student_id);
      if (!allowed) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const balance = Number(invoice.balance);
      if (balance <= 0) {
        return res.status(400).json({ success: false, error: { code: 'INVOICE_ALREADY_SETTLED', message: 'This invoice has no outstanding balance' } });
      }

      const payAmount = amount ?? balance;
      if (payAmount > balance) {
        return res.status(400).json({ success: false, error: { code: 'AMOUNT_EXCEEDS_BALANCE', message: 'Amount exceeds the outstanding balance' } });
      }

      if (!isPaystackConfigured()) {
        return res.status(503).json({ success: false, error: { code: 'PAYSTACK_NOT_CONFIGURED', message: 'Paystack is not configured for this server' } });
      }

      const payoutConfig = await getSchoolPayoutConfig(schoolId);
      if (payoutConfig?.settlement_status !== 'active') {
        return res.status(503).json({ success: false, error: { code: 'PAYOUT_NOT_CONFIGURED', message: "Online payment isn't set up yet for this school — please contact the school office." } });
      }

      const reference = crypto.randomUUID();
      const initialization = await initializePaystackTransaction({
        email: req.user!.email!,
        amountKobo: Math.round(payAmount * 100),
        reference,
        callbackUrl: `${getApiBaseUrl()}/api/schools/${schoolId}/payments/paystack/callback`,
        metadata: { school_id: schoolId, invoice_id, recorded_by: req.user!.user_id },
        subaccountCode: payoutConfig.paystack_subaccount_code,
        bearer: 'subaccount',
      });

      if (!initialization) {
        return res.status(502).json({ success: false, error: { code: 'PAYSTACK_INIT_FAILED', message: 'Unable to initialize the Paystack transaction' } });
      }

      return res.json({ success: true, data: initialization });
    } catch (err) {
      return next(err);
    }
  }
);

// NOTE: the Paystack webhook (POST /:schoolId/payments/paystack/webhook) and
// callback (GET /:schoolId/payments/paystack/callback) routes live in
// ./feesPublic.ts, not here — they must be mounted before the auth middleware
// chain in index.ts since Paystack cannot supply a bearer token for either.

// ── POST /:schoolId/fee-reminders/run ───────────────────────────────────────────

router.post(
  '/:schoolId/fee-reminders/run',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No active term for this school' } });
      }

      const remindersSent = await sendFeeRemindersForSchool(req.params.schoolId, term.id);
      return res.json({ success: true, data: { reminders_sent: remindersSent } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
