import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import { settlePayment } from '../db/queries/platformBilling';
import { verifyPaystackTransaction, verifyPaystackWebhookSignature } from '../services/paystackService';
import { appBaseUrl } from '../config/appUrls';

/**
 * The two Paystack endpoints for a school's OWN subscription payment that must be
 * reachable with no bearer token: the browser callback and the server-to-server webhook.
 * Mirrors routes/feesPublic.ts's mounting rule exactly — mount this router in index.ts
 * BEFORE the auth chain (verifyToken etc.), alongside feesPublicRoutes, and mount
 * routes/platformBilling.ts's authenticated router after it, same as fees.ts/feesRoutes.
 *
 * Neither route carries :schoolId. THE TRUST MODEL (db/queries/platformBilling.ts) means
 * school identity is resolved from the `reference`-keyed row the checkout route wrote —
 * never from Paystack's metadata, and so never needed in this router's own path either.
 */
const router = Router();

const getAppBaseUrl = appBaseUrl;

function redirectReason(outcome: 'amount_mismatch' | 'not_found'): string {
  return outcome === 'amount_mismatch' ? 'amount_mismatch' : 'unknown_reference';
}

// ── GET /platform-billing/callback ──────────────────────────────────────────

router.get(
  '/platform-billing/callback',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reference = typeof req.query.reference === 'string' ? req.query.reference : undefined;
      const redirectBase = `${getAppBaseUrl()}/settings/billing`;

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

      const result = await settlePayment(reference, verification.amountKobo);
      if (result.outcome === 'settled' || result.outcome === 'already_settled') {
        return res.redirect(`${redirectBase}?payment=success`);
      }
      return res.redirect(`${redirectBase}?payment=error&reason=${redirectReason(result.outcome)}`);
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /platform-billing/webhook ──────────────────────────────────────────

interface PaystackWebhookEvent {
  event?: string;
  data?: { reference?: string };
}

router.post(
  '/platform-billing/webhook',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.rawBody) {
        // A per-request shape check, same posture as the signature check just below it
        // (which answers 401 with no log line at all) — classified in config/alerts.ts
        // as NOT_ALERTED, for the same reason: it fires on malformed input, not on an
        // outage, and a persistent instance of it would show as Paystack's own delivery
        // failures on its dashboard well before this log line would be read.
        logger.error('platform_billing_webhook_malformed', { detail: 'rawBody missing — possible middleware misconfiguration' });
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

      const reference = event.data?.reference;
      if (!reference) {
        return res.status(200).json({ success: true, data: { processed: false } });
      }

      // Re-verify via Paystack's API — never trust the webhook payload's own amount, which
      // is exactly what routes/fees.ts's webhook already does for parent fee payments.
      const verification = await verifyPaystackTransaction(reference);
      if (!verification || verification.status !== 'success') {
        return res.status(200).json({ success: true, data: { processed: false } });
      }

      const result = await settlePayment(reference, verification.amountKobo);
      return res.status(200).json({ success: true, data: { processed: result.outcome === 'settled', outcome: result.outcome } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
