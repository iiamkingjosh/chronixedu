import pool from '../client';
import { logger } from '../../config/logger';
import { logAudit } from './auditLog';

/**
 * A school paying Chronix for its own platform subscription, via Paystack (migration 052).
 *
 * THE TRUST MODEL, carried over from routes/feesPublic.ts and sharpened: a payment's
 * identity — which school, which subscription, what it was for — is resolved ONLY from
 * the `platform_subscription_payments` row this server wrote at checkout, looked up by
 * the `reference` this server generated. settlePayment() below takes a reference and a
 * Paystack-VERIFIED amount and nothing else; it never takes a school id, and nothing in
 * routes/platformBillingPublic.ts reads one out of Paystack's webhook body or callback
 * query string. feesPublic.ts reads `metadata.school_id`/`metadata.invoice_id` out of
 * Paystack's data (cross-checked against the URL's :schoolId) — deliberately not repeated
 * here: metadata is unauthenticated input twice over, and this flow has no need of it.
 */

export interface BillableSubscription {
  id: string;
  school_id: string;
  plan: string;
  subscription_status: string;
  billing_cycle: string;
  amount_naira: string;
  next_billing_date: string | null;
  next_billing_basis: string;
}

/**
 * Duplicated from routes/superAdmin.ts's nextBillingSql/nextBillingBasisSql rather than
 * imported: those are unexported helpers private to that route file (CLAUDE.md keeps
 * partner.ts's guard out of superAdmin.ts for the same reason — separate files should not
 * reach into each other's internals), and the fragment is two lines. getApiBaseUrl/
 * getAppBaseUrl are already duplicated the same way between routes/fees.ts and
 * routes/feesPublic.ts.
 */
function nextBillingSql(ps: string): string {
  return `CASE WHEN ${ps}.billing_cycle = 'termly' THEN next_term_start(${ps}.school_id) ELSE ${ps}.next_billing_date END`;
}
function nextBillingBasisSql(ps: string): string {
  return `CASE WHEN ${ps}.plan = 'trial' THEN 'not_billed'
               WHEN ${ps}.billing_cycle = 'termly' THEN CASE WHEN next_term_start(${ps}.school_id) IS NULL THEN 'not_yet_known' ELSE 'next_term' END
               WHEN ${ps}.next_billing_date IS NULL THEN 'not_set' ELSE 'stored' END`;
}

/** The school's own subscription, with the same derived next-billing fields the
 *  super-admin screens show. Null if the school has no subscription row yet. */
export async function findBillableSubscription(schoolId: string): Promise<BillableSubscription | null> {
  const { rows } = await pool.query<BillableSubscription>(
    `SELECT ps.id, ps.school_id, ps.plan, ps.subscription_status, ps.billing_cycle, ps.amount_naira,
            ${nextBillingSql('ps')} AS next_billing_date,
            ${nextBillingBasisSql('ps')} AS next_billing_basis
       FROM platform_subscriptions ps
      WHERE ps.school_id = $1`,
    [schoolId]
  );
  return rows[0] ?? null;
}

export interface PendingPlatformPayment {
  id: string;
  reference: string;
  amount_kobo: string;
  status: string;
  created_at: string;
}

/** The most recent still-open checkout for this school, if any — so the status screen can
 *  say "a payment is in progress" instead of letting a bursar start a second one by mistake. */
export async function findPendingPaymentForSchool(schoolId: string): Promise<PendingPlatformPayment | null> {
  const { rows } = await pool.query<PendingPlatformPayment>(
    `SELECT id, reference, amount_kobo, status, created_at
       FROM platform_subscription_payments
      WHERE school_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1`,
    [schoolId]
  );
  return rows[0] ?? null;
}

export interface PlatformSubscriptionPayment {
  id: string;
  school_id: string;
  subscription_id: string;
  reference: string;
  amount_kobo: string;
  plan: string;
  billing_cycle: string;
  status: string;
  initiated_by: string;
  consumed_at: string | null;
}

/** Opens a checkout attempt: a pending row keyed by a reference THIS server generates,
 *  snapshotting what the payer is being asked to pay right now (doctrine: "same amount
 *  as per students", no proration — see migration 052's header). */
export async function createPendingPayment(input: {
  schoolId: string;
  subscriptionId: string;
  reference: string;
  amountKobo: number;
  plan: string;
  billingCycle: string;
  initiatedBy: string;
}): Promise<PlatformSubscriptionPayment> {
  const { rows } = await pool.query<PlatformSubscriptionPayment>(
    `INSERT INTO platform_subscription_payments
       (school_id, subscription_id, reference, amount_kobo, plan, billing_cycle, initiated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [input.schoolId, input.subscriptionId, input.reference, input.amountKobo, input.plan, input.billingCycle, input.initiatedBy]
  );
  return rows[0];
}

/** A checkout that never reached Paystack (initialize failed) — marked failed rather than
 *  left pending forever, so it does not show up as "a payment is in progress" indefinitely. */
export async function markPaymentFailed(id: string): Promise<void> {
  await pool.query(`UPDATE platform_subscription_payments SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id]);
}

export type SettleOutcome =
  | { outcome: 'settled'; payment: PlatformSubscriptionPayment; subscription_reactivated: boolean }
  | { outcome: 'already_settled'; payment: PlatformSubscriptionPayment }
  | { outcome: 'not_found' }
  | { outcome: 'amount_mismatch'; payment: PlatformSubscriptionPayment }
  | { outcome: 'currency_mismatch'; payment: PlatformSubscriptionPayment };

/**
 * Settles a payment by reference, exactly once. Called from both the webhook and the
 * browser callback — whichever arrives first does the work, same race feesPublic.ts
 * already runs ("the webhook usually wins this race"); the loser sees `already_settled`
 * from the WHERE status = 'pending' guard finding zero rows, not a second write.
 *
 * verifiedAmountKobo must come from verifyPaystackTransaction (re-verified against
 * Paystack's API), never from a webhook payload or callback query string taken at face
 * value — callers enforce that; this function just compares it to what was snapshotted
 * at checkout and refuses to settle on a mismatch rather than trusting whichever number
 * showed up (doctrine: never infer the amount was right because it usually is).
 */
export async function settlePayment(reference: string, verifiedAmountKobo: number, verifiedCurrency: string): Promise<SettleOutcome> {
  const existing = await pool.query<PlatformSubscriptionPayment>(
    `SELECT * FROM platform_subscription_payments WHERE reference = $1`,
    [reference]
  );
  const payment = existing.rows[0];
  if (!payment) return { outcome: 'not_found' };
  if (payment.status !== 'pending') return { outcome: 'already_settled', payment };

  // Naira only (3 Oct 2026). The snapshot is in kobo; another currency's minor units are not kobo,
  // so a matching number would settle the bill at the wrong value (80,000 US cents for ₦800). Failed,
  // like an amount mismatch, and alerted: the money may need refunding.
  if (verifiedCurrency !== 'NGN') {
    await pool.query(`UPDATE platform_subscription_payments SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [payment.id]);
    logger.error('platform_billing_currency_mismatch', {
      payment_id: payment.id, school_id: payment.school_id, reference, currency: verifiedCurrency,
    });
    return { outcome: 'currency_mismatch', payment };
  }

  if (Number(payment.amount_kobo) !== verifiedAmountKobo) {
    await pool.query(`UPDATE platform_subscription_payments SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [payment.id]);
    // A genuinely new failure mode (CLAUDE.md doctrine 9's own example of one): logged and
    // classified in config/alerts.ts (platform_billing_amount_mismatch) in this same commit.
    logger.error('platform_billing_amount_mismatch', {
      payment_id: payment.id, school_id: payment.school_id, reference,
      expected_kobo: payment.amount_kobo, verified_kobo: verifiedAmountKobo,
    });
    return { outcome: 'amount_mismatch', payment };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settled = await client.query<PlatformSubscriptionPayment>(
      `UPDATE platform_subscription_payments
          SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [payment.id]
    );
    if (!settled.rows[0]) {
      // Lost the race between the SELECT above and this UPDATE — the other caller settled
      // it in between. Not an error; report it the same way a pre-existing non-pending row
      // would be reported.
      await client.query('COMMIT');
      return { outcome: 'already_settled', payment };
    }

    // A payment against a suspended/grace/read-only subscription restores it — the same
    // reactivation POST /subscriptions/:id/record-payment performs, money received being
    // the strongest evidence of a live customer. schools.is_active is never touched here:
    // that is a separate administrator decision (CLAUDE.md, Platform billing).
    const subscriptionResult = await client.query<{ subscription_status: string }>(
      `UPDATE platform_subscriptions
          SET subscription_status = 'active', updated_at = NOW()
        WHERE id = $1 AND subscription_status IN ('suspended', 'grace', 'read_only')
        RETURNING subscription_status`,
      [payment.subscription_id]
    );
    const reactivated = subscriptionResult.rows.length > 0;
    await client.query('COMMIT');

    try {
      await logAudit({
        schoolId: payment.school_id,
        userId: payment.initiated_by,
        actionType: 'PLATFORM_BILLING_PAYMENT_SETTLED',
        entity: 'platform_subscription_payments',
        entityId: payment.id,
        newValue: { amount_kobo: payment.amount_kobo, plan: payment.plan, billing_cycle: payment.billing_cycle, subscription_reactivated: reactivated },
      });
    } catch (auditErr) {
      // The payment is already settled and already reported as such above — an audit-log
      // failure must never retroactively undo that (same posture as fees.ts's
      // payment_recorded_audit_log_failed), but it is still logged so an outage here is visible.
      logger.error('platform_billing_payment_audit_log_failed', { paymentId: payment.id, schoolId: payment.school_id, err: auditErr });
    }

    return { outcome: 'settled', payment: settled.rows[0], subscription_reactivated: reactivated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // silent-ok: the original error is rethrown next
    throw err;
  } finally {
    client.release();
  }
}
