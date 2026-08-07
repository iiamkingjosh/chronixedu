import { Router, Request, Response, NextFunction } from 'express';
import { logAudit } from '../db/queries/auditLog';
import { recordPayment } from '../db/queries/fees';
import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
import { verifyPaystackTransaction, verifyPaystackWebhookSignature } from '../services/paystackService';

// This router carries ONLY the two Paystack endpoints that must be reachable
// without a bearer token: the browser redirect callback and the server-to-server
// webhook. Paystack cannot supply an Authorization header for either, so these
// must never sit behind verifyToken/detectSupportSession/requireActiveSchool.
// Mount this router in index.ts BEFORE that auth chain; mount the rest of
// fees.ts's routes (feesRoutes) after it, exactly as before.
const router = Router();

interface PaystackPaymentMetadata {
  school_id?: string;
  invoice_id?: string;
  recorded_by?: string | null;
}

function getAppBaseUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

// ── GET /:schoolId/payments/paystack/callback ────────────────────────────────────

router.get(
  '/:schoolId/payments/paystack/callback',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schoolId = req.params.schoolId;
      const reference = typeof req.query.reference === 'string' ? req.query.reference : undefined;
      const redirectBase = `${getAppBaseUrl()}/parent/fees`;

      if (!reference) {
        return res.redirect(`${redirectBase}?payment=error&reason=missing_reference`);
      }

      const verification = await verifyPaystackTransaction(reference);
      if (!verification) {
        return res.redirect(`${redirectBase}?payment=error&reason=verify_failed`);
      }

      if (verification.status !== 'success') {
        return res.redirect(`${redirectBase}?payment=failed`);
      }

      const metadata = (verification.metadata ?? {}) as PaystackPaymentMetadata;
      if (!metadata.invoice_id || metadata.school_id !== schoolId) {
        return res.redirect(`${redirectBase}?payment=error&reason=invalid_metadata`);
      }
      const invoiceId = metadata.invoice_id;

      try {
        const result = await recordPayment(schoolId, invoiceId, {
          amount: verification.amount,
          method: 'paystack',
          reference: null,
          paystack_reference: reference,
          recorded_by: metadata.recorded_by ?? null,
        });

        if (!result) {
          return res.redirect(`${redirectBase}?payment=error&reason=invoice_not_found`);
        }

        notifyPaymentReceipt(schoolId, result.payment.id, result.invoice.student_id);

        if (metadata.recorded_by) {
          await logAudit({
            supportSession: req.supportSession,
            schoolId,
            userId: metadata.recorded_by,
            actionType: 'PAYMENT_RECORDED',
            entity: 'payments',
            entityId: result.payment.id,
            newValue: result.payment,
          });
        }

        return res.redirect(`${redirectBase}?payment=success`);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return res.redirect(`${redirectBase}?payment=success`);
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/payments/paystack/webhook ────────────────────────────────────

interface PaystackWebhookEvent {
  event?: string;
  data?: {
    reference?: string;
    amount?: number;
    metadata?: PaystackPaymentMetadata;
  };
}

router.post(
  '/:schoolId/payments/paystack/webhook',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.rawBody) {
        console.error('Paystack webhook: rawBody missing — possible middleware misconfiguration');
        return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid webhook request' } });
      }

      const signature = req.headers['x-paystack-signature'];
      if (typeof signature !== 'string' || !verifyPaystackWebhookSignature(req.rawBody, signature)) {
        return res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid Paystack signature' } });
      }

      const event = req.body as PaystackWebhookEvent;
      if (event.event !== 'charge.success') {
        return res.status(200).json({ success: true, data: { ignored: true } });
      }

      const data = event.data ?? {};
      const metadata = data.metadata ?? {};
      if (!metadata.invoice_id || metadata.school_id !== req.params.schoolId) {
        return res.status(200).json({ success: true, data: { ignored: true } });
      }
      const invoiceId = metadata.invoice_id;

      // Re-verify the transaction via Paystack API — never trust the webhook payload amount.
      // This mirrors what the manual POST /payments route does and prevents amount tampering
      // if a webhook payload is replayed or Paystack's schema ever changes.
      if (!data.reference) {
        return res.status(200).json({ success: true, data: { processed: false } });
      }
      const verification = await verifyPaystackTransaction(data.reference);
      if (!verification || verification.status !== 'success') {
        return res.status(200).json({ success: true, data: { processed: false } });
      }

      try {
        const result = await recordPayment(req.params.schoolId, invoiceId, {
          amount: verification.amount,
          method: 'paystack',
          reference: null,
          paystack_reference: data.reference,
          recorded_by: metadata.recorded_by ?? null,
        });

        if (!result) {
          return res.status(200).json({ success: true, data: { processed: false } });
        }

        notifyPaymentReceipt(req.params.schoolId, result.payment.id, result.invoice.student_id);

        if (metadata.recorded_by) {
          await logAudit({
            supportSession: req.supportSession,
            schoolId: req.params.schoolId,
            userId: metadata.recorded_by,
            actionType: 'PAYMENT_RECORDED',
            entity: 'payments',
            entityId: result.payment.id,
            newValue: result.payment,
          });
        }

        return res.status(200).json({ success: true, data: { processed: true } });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return res.status(200).json({ success: true, data: { processed: false, duplicate: true } });
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
