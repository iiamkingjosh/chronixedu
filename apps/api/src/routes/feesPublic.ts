import { clientIp } from '../middleware/clientIp';
import { Router, Request, Response, NextFunction } from 'express';
import { logAudit } from '../db/queries/auditLog';
import { settleFeeCheckout, type FeeSettlement } from '../db/queries/feeCheckouts';
import { settlePayment } from '../db/queries/platformBilling';
import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
import { verifyPaystackTransaction, verifyPaystackWebhookSignature } from '../services/paystackService';
import { logger } from '../config/logger';
import { appBaseUrl } from '../config/appUrls';

// This router carries ONLY the two Paystack endpoints that must be reachable
// without a bearer token: the browser redirect callback and the server-to-server
// webhook. Paystack cannot supply an Authorization header for either, so these
// must never sit behind verifyToken/detectSupportSession/requireActiveSchool.
// Mount this router in index.ts BEFORE that auth chain; mount the rest of
// fees.ts's routes (feesRoutes) after it, exactly as before.
//
// WHERE A PAYMENT IS CREDITED (6 Oct 2026, migration 062, SECURITY.md Round 38). Only through the record
// its start wrote before Paystack was called (fee_checkouts, by reference): that record's school and
// invoice, at exactly its amount. Paystack's metadata and the :schoolId in either address are not used.
// The return page used to take the school from its own address, which any caller chooses, and both took
// the invoice from metadata, which a transaction created another way on the same Paystack account can
// set to anything.
const router = Router();

/** Logs a payment that was not credited, by reason, for the alert (config/alerts.ts). Never the payer. */
function logNotCredited(route: string, reference: string, settled: FeeSettlement): void {
  if (settled.outcome === 'no_checkout') {
    logger.error('paystack_fee_payment_unmatched', { route, paystack_reference: reference });
  } else if (settled.outcome === 'not_naira') {
    logger.error('paystack_payment_not_naira', { route, school_id: settled.schoolId, paystack_reference: reference });
  } else if (settled.outcome === 'amount_mismatch') {
    logger.error('paystack_fee_amount_mismatch', {
      route, school_id: settled.schoolId, expected_kobo: settled.expectedKobo, verified_kobo: settled.verifiedKobo,
    });
  }
}

// ── GET /:schoolId/payments/paystack/callback ────────────────────────────────────

const CALLBACK_REASON: Partial<Record<FeeSettlement['outcome'], string>> = {
  no_checkout: 'unknown_payment',
  not_naira: 'wrong_currency',
  amount_mismatch: 'amount_mismatch',
  invoice_missing: 'invoice_not_found',
};

router.get(
  '/:schoolId/payments/paystack/callback',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reference = typeof req.query.reference === 'string' ? req.query.reference : undefined;
      const redirectBase = `${appBaseUrl()}/parent/fees`;

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

      const settled = await settleFeeCheckout(reference, verification.amountKobo, verification.currency);
      if (settled.outcome === 'duplicate') {
        // The webhook usually wins this race: already credited, notified and audited.
        return res.redirect(`${redirectBase}?payment=success`);
      }
      if (settled.outcome !== 'credited') {
        logNotCredited('fees_callback', reference, settled);
        return res.redirect(`${redirectBase}?payment=error&reason=${CALLBACK_REASON[settled.outcome] ?? 'not_credited'}`);
      }

      notifyPaymentReceipt(settled.schoolId, settled.payment.id, settled.invoice.student_id);
      await logAudit({
        // The payer's own browser, so its address is theirs.
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: settled.schoolId,
        userId: settled.recordedBy,
        actionType: 'PAYMENT_RECORDED',
        entity: 'payments',
        entityId: settled.payment.id,
        newValue: settled.payment,
      });
      return res.redirect(`${redirectBase}?payment=success`);
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/payments/paystack/webhook ────────────────────────────────────
// Paystack sends every event of the account to the one address in its dashboard. A charge is credited
// through its record whichever school's address this is, so the pilot's address serves every school.
// Chronix's own subscription payments arriving here are settled by their reference, as the
// platform-billing webhook settles them. Any other event is acknowledged and logged by name: the
// account-wide handling of refunds and disputes is parked for the second school (branch
// parked/paystack-account-webhook).

interface PaystackWebhookEvent {
  event?: string;
  data?: { reference?: string };
}

router.post(
  '/:schoolId/payments/paystack/webhook',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.rawBody) {
        logger.warn('paystack_webhook_malformed', { route: 'fees_webhook', detail: 'rawBody missing: possible middleware misconfiguration' });
        return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid webhook request' } });
      }

      const signature = req.headers['x-paystack-signature'];
      if (typeof signature !== 'string' || !verifyPaystackWebhookSignature(req.rawBody, signature)) {
        return res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid Paystack signature' } });
      }

      const event = req.body as PaystackWebhookEvent;
      if (event.event !== 'charge.success') {
        // Never dropped silently: a refund, a dispute or anything else Paystack sends is visible by name.
        logger.warn('paystack_event_unhandled', { event: typeof event.event === 'string' ? event.event : '(none)' });
        return res.status(200).json({ success: true, data: { ignored: true } });
      }

      const reference = event.data?.reference;
      if (!reference) {
        return res.status(200).json({ success: true, data: { processed: false } });
      }
      // Re-verified with Paystack's API: the amount and currency are Paystack's, never the event's.
      const verification = await verifyPaystackTransaction(reference);
      if (!verification || verification.status !== 'success') {
        return res.status(200).json({ success: true, data: { processed: false } });
      }

      const settled = await settleFeeCheckout(reference, verification.amountKobo, verification.currency);
      if (settled.outcome === 'no_checkout') {
        const platform = await settlePayment(reference, verification.amountKobo, verification.currency);
        if (platform.outcome !== 'not_found') {
          return res.status(200).json({ success: true, data: { processed: platform.outcome === 'settled', outcome: platform.outcome } });
        }
      }
      if (settled.outcome === 'duplicate') {
        return res.status(200).json({ success: true, data: { processed: false, duplicate: true } });
      }
      if (settled.outcome !== 'credited') {
        // Acknowledged (200): delivering it again would not change the answer. Alerted instead.
        logNotCredited('fees_webhook', reference, settled);
        return res.status(200).json({ success: true, data: { processed: false, reason: settled.outcome } });
      }

      notifyPaymentReceipt(settled.schoolId, settled.payment.id, settled.invoice.student_id);
      await logAudit({
        // Null, not clientIp(req): this request is Paystack's server, not the person the row names.
        ipAddress: null,
        supportSession: req.supportSession,
        schoolId: settled.schoolId,
        userId: settled.recordedBy,
        actionType: 'PAYMENT_RECORDED',
        entity: 'payments',
        entityId: settled.payment.id,
        newValue: settled.payment,
      });
      return res.status(200).json({ success: true, data: { processed: true } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
