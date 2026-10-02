import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { requireRole } from '../middleware/auth';
import { logger } from '../config/logger';
import { toKobo, fromKobo } from '../services/money';
import {
  findBillableSubscription,
  findPendingPaymentForSchool,
  createPendingPayment,
  markPaymentFailed,
} from '../db/queries/platformBilling';
import { isPaystackConfigured, initializePaystackTransaction } from '../services/paystackService';

/**
 * A school paying Chronix for its own platform subscription (migration 052). Named with a
 * `platform-billing` path segment throughout — PLATFORM_PAYMENT_PATH's naming contract
 * (middleware/requireWritableSubscription.ts) — so a lapsed-trial (read_only) school can
 * still reach the checkout route that lets it pay its way back to full access.
 *
 * Mounted under /api/schools AFTER requireWritableSubscription, like every other
 * school-scoped router; the public webhook/callback counterpart
 * (routes/platformBillingPublic.ts) is a SEPARATE router mounted before the auth chain,
 * exactly where routes/feesPublic.ts is mounted relative to routes/fees.ts.
 */
const router = Router();

// CLAUDE.md doctrine 1: requireSchoolAccess is defined per file and they are not
// identical. This one is the common/permissive shape (super_admin excepted, otherwise
// the caller's own school only) — the same one routes/fees.ts defines for itself.
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

/**
 * Public base URL of THIS api service, for the Paystack callback_url — duplicated from
 * routes/fees.ts's getApiBaseUrl (and the event name it logs, api_base_url_not_configured,
 * is reused rather than given a new name: it is the same misconfiguration with the same
 * consequence, already carried in config/alerts.ts as payment_callback_url_missing).
 */
function getApiBaseUrl(): string {
  const configured = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!configured) {
    logger.error('api_base_url_not_configured', {
      detail: 'Neither API_BASE_URL nor NEXT_PUBLIC_API_URL is set. Paystack callback_url for a platform-billing checkout will point at localhost and payers will be redirected to a dead page after paying.',
    });
    return 'http://localhost:3001';
  }
  return configured.replace(/\/$/, '');
}

// ── GET /:schoolId/platform-billing/status ──────────────────────────────────

router.get(
  '/:schoolId/platform-billing/status',
  requireSchoolAccess,
  requireRole('principal', 'bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schoolId = req.params.schoolId;
      const subscription = await findBillableSubscription(schoolId);
      if (!subscription) {
        return res.json({ success: true, data: { has_subscription: false } });
      }

      const payable = subscription.plan !== 'trial' && subscription.subscription_status !== 'cancelled';
      const pending = await findPendingPaymentForSchool(schoolId);

      return res.json({
        success: true,
        data: {
          has_subscription: true,
          plan: subscription.plan,
          subscription_status: subscription.subscription_status,
          billing_cycle: subscription.billing_cycle,
          amount_naira: subscription.amount_naira,
          next_billing_date: subscription.next_billing_date,
          next_billing_basis: subscription.next_billing_basis,
          // Why checkout would refuse, named rather than left for the client to guess:
          //   trial       — nothing is owed yet (trial schools are free until it ends)
          //   cancelled   — contact Chronix; nothing can be paid online
          payable,
          pending_payment: pending ? { reference: pending.reference, amount_naira: fromKobo(Number(pending.amount_kobo)) } : null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/platform-billing/checkout ───────────────────────────────
// Starts a Paystack transaction for the school's current bill, snapshotted as it stands
// right now (rate x currently-enrolled students) — no late-payment logic, no proration:
// [MOSES]'s decision, "still same amount as per students", recorded in migration 052.

router.post(
  '/:schoolId/platform-billing/checkout',
  requireSchoolAccess,
  requireRole('principal', 'bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schoolId = req.params.schoolId;
      const subscription = await findBillableSubscription(schoolId);
      if (!subscription) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'This school has no subscription yet; contact Chronix.' } });
      }
      if (subscription.plan === 'trial') {
        return res.status(409).json({
          success: false,
          error: { code: 'TRIAL_NOT_BILLABLE', message: 'This school is on a free trial — trial schools are free until the trial ends, so there is nothing to pay yet.' },
        });
      }
      if (subscription.subscription_status === 'cancelled') {
        return res.status(409).json({
          success: false,
          error: { code: 'SUBSCRIPTION_CANCELLED', message: 'This subscription is cancelled. Contact Chronix to reinstate it before paying.' },
        });
      }

      const amountKobo = toKobo(subscription.amount_naira);
      if (amountKobo <= 0) {
        return res.status(409).json({ success: false, error: { code: 'NOTHING_TO_PAY', message: 'The current amount due is ₦0.00 — there is nothing to pay right now.' } });
      }

      if (!isPaystackConfigured()) {
        return res.status(503).json({ success: false, error: { code: 'PAYSTACK_NOT_CONFIGURED', message: 'Online payment is not configured on this server yet.' } });
      }

      const reference = crypto.randomUUID();
      const payment = await createPendingPayment({
        schoolId,
        subscriptionId: subscription.id,
        reference,
        amountKobo,
        plan: subscription.plan,
        billingCycle: subscription.billing_cycle,
        initiatedBy: req.user!.user_id,
      });

      // No subaccount, no `bearer` override: unlike parent fee payments (routes/fees.ts),
      // money here flows directly to Chronix — this is Chronix's own revenue, not a
      // school's, so there is no subaccount to split it with.
      const initialization = await initializePaystackTransaction({
        email: req.user!.email!,
        amountKobo,
        reference,
        callbackUrl: `${getApiBaseUrl()}/api/schools/platform-billing/callback`,
        // Descriptive only, for a human looking at the Paystack dashboard — NOT trusted
        // identity. The webhook/callback resolve school_id and subscription_id from the
        // `reference`-keyed row above, never from this.
        metadata: { purpose: 'platform_subscription', school_id: schoolId },
      });

      if (!initialization) {
        await markPaymentFailed(payment.id);
        return res.status(502).json({ success: false, error: { code: 'PAYSTACK_INIT_FAILED', message: 'Unable to start the Paystack transaction. Try again shortly.' } });
      }

      return res.status(201).json({
        success: true,
        data: {
          authorization_url: initialization.authorization_url,
          reference,
          amount_naira: fromKobo(amountKobo),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
