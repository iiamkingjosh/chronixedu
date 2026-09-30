import { z } from 'zod';
import pool from '../db/client';
import { logger } from '../config/logger';

/**
 * The plans, their features, and the one rule for whether a school has a feature.
 *
 * This replaced a single string comparison — `false` if the tier was 'basic', `true` for
 * anything else — which meant every other value, including ones nobody had decided about,
 * got everything. With Basic removed, that rule would have made every `requireFeature` call
 * decoration. So:
 *
 *   - PLANS is the single list. Every zod enum that accepts a plan is `planEnum`, built from
 *     it; routes/superAdmin.ts holds no literal of its own (planFeatures.test.ts checks).
 *   - PLAN_FEATURES is a `Record<Plan, …>`: a plan added to PLANS without a decision about
 *     its features is a TYPE ERROR, so the build fails rather than the plan inheriting
 *     everything by accident (doctrine 9: a guard that cannot fail loudly is not a guard).
 *   - A read-only subscription has no features, whatever its plan (the trial gate, migration
 *     046).
 *   - A null or unrecognised tier still passes — a misconfigured school should not lose a
 *     product it may be paying for — but it is logged at error with the value. It used to
 *     pass in silence, which is why nobody noticed trial had full access all along.
 *
 * Decided 30 Sep 2026: trial, premium and enterprise all get every feature. A trial that
 * hides the best features does not convert; enterprise is a price tier, not a feature tier.
 */
export const PLANS = ['trial', 'premium', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];
export const planEnum = z.enum(PLANS);

/** The plans a school pays for. MRR is reported per paid plan. */
export const PAID_PLANS = PLANS.filter((p): p is Exclude<Plan, 'trial'> => p !== 'trial');

export type PlanFeature = 'sms' | 'online_payments' | 'analytics';
export const PLAN_FEATURES: Record<Plan, readonly PlanFeature[]> = {
  trial: ['sms', 'online_payments', 'analytics'],
  premium: ['sms', 'online_payments', 'analytics'],
  enterprise: ['sms', 'online_payments', 'analytics'],
};

function isPlan(value: string | null | undefined): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function planIncludesFeature(
  subscriptionTier: string | null | undefined,
  feature: PlanFeature,
  subscriptionStatus?: string | null
): boolean {
  if (subscriptionStatus === 'read_only') return false;
  if (isPlan(subscriptionTier)) return PLAN_FEATURES[subscriptionTier].includes(feature);
  logger.error('plan_feature_unrecognised_tier', { tier: subscriptionTier ?? null, feature });
  return true;
}

/** For the two code paths (fee-reminder cron, notification worker) that have no live
 *  request/res.locals.school to reuse — does its own small lookup, reading the same map. */
export async function schoolAllowsFeature(schoolId: string, feature: PlanFeature): Promise<boolean> {
  const result = await pool.query<{ subscription_tier: string | null; subscription_status: string | null }>(
    `SELECT s.subscription_tier, ps.subscription_status
       FROM schools s
       LEFT JOIN platform_subscriptions ps ON ps.school_id = s.id
      WHERE s.id = $1`,
    [schoolId]
  );
  const row = result.rows[0];
  if (!row) {
    logger.error('plan_feature_school_not_found', { school_id: schoolId, feature });
    return true; // fail open — same posture as planIncludesFeature
  }
  return planIncludesFeature(row.subscription_tier, feature, row.subscription_status);
}
