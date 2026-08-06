import pool from '../db/client';

export type PlanFeature = 'sms' | 'online_payments' | 'analytics';

// All three PlanFeature values are Premium+-only today (Basic gets none of
// them) — the feature argument is kept so this can grow into a real
// per-feature table later without changing any call site.
export function planIncludesFeature(
  subscriptionTier: string | null | undefined,
  _feature: PlanFeature
): boolean {
  if (subscriptionTier === 'basic') return false;
  // trial, premium, enterprise, and any unrecognized/null value all pass —
  // fail open toward access rather than silently locking out a school with
  // a not-yet-assigned or unexpected plan value.
  return true;
}

/** For the two code paths (fee-reminder cron, notification worker) that have
 *  no live request/res.locals.school to reuse — does its own small lookup. */
export async function schoolAllowsFeature(schoolId: string, feature: PlanFeature): Promise<boolean> {
  const result = await pool.query<{ subscription_tier: string | null }>(
    `SELECT subscription_tier FROM schools WHERE id = $1`,
    [schoolId]
  );
  const row = result.rows[0];
  if (!row) return true; // fail open — same posture as planIncludesFeature
  return planIncludesFeature(row.subscription_tier, feature);
}
