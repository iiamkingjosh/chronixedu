import pool from '../client';

/**
 * Platform MRR, as one aggregate, in integer kobo.
 *
 * There were two MRR figures in this product: `/super-admin/subscriptions/mrr` summed
 * every active subscription, while `/super-admin/analytics/overview` excluded demo and
 * suspended schools after d5c7716. They agree today only because no demo school has a
 * subscription — a latent disagreement, not an absent one. `/api/partner/revenue` would
 * have made it three. This is the single source all of them read.
 *
 * Demo tenants and suspended schools are excluded, matching the overview: a fixture
 * school's subscription is not revenue, and a suspended school is not billing this month.
 *
 * ## Why kobo, and why the arithmetic is in SQL
 *
 * The first version of this function returned naira as a JS number and did
 * `entry.mrr += amount / 12` for annual plans, then summed those floats. That is
 * precisely what doctrine 11 forbids, and it was written in the same week the fee module
 * was moved off floats for the same reason — a money boundary added while the argument
 * against money boundaries like it was still fresh.
 *
 * Every arithmetic step now happens in Postgres `numeric` and lands as integer kobo:
 *
 *   - Naira → kobo is `amount_naira * 100` on a `numeric(12,2)` column, so it is exact
 *     by construction; there is no float that could carry a 0.999999 into it.
 *   - An annual plan divides by 12 **per subscription**, then rounds to whole kobo
 *     (`ROUND`, half-up away from zero), and the plan total is the exact sum of those
 *     rounded figures. Rounding per subscription rather than per plan is the billing
 *     convention and it keeps one invariant a consumer can check: a plan's MRR is the
 *     sum of what its subscriptions each contribute this month. Summing first and
 *     rounding once would break that for no benefit.
 *   - `total_mrr_kobo` is the sum of the per-plan figures, so the parts always add up to
 *     the total exactly. Adding integers in JS is exact — that is the alternative
 *     doctrine 11 names, not the thing it forbids.
 *
 * Callers convert to naira for display and nowhere else.
 */

export interface PlanRevenue {
  plan: string;
  /** Integer kobo. Multiply by 100 never happens downstream; divide by 100 for display. */
  mrr_kobo: number;
  count: number;
}

export interface PlatformRevenue {
  total_mrr_kobo: number;
  by_plan: PlanRevenue[];
  currency: 'NGN';
  /** Names the unit in the payload itself, so a consumer cannot mistake kobo for naira. */
  unit: 'kobo';
}

const PLANS = ['basic', 'premium', 'enterprise'] as const;

/**
 * `pg` returns bigint as a string to avoid silently losing precision, and `Number()`
 * would undo that protection quietly. Past Number.MAX_SAFE_INTEGER the sum stops being
 * the sum. ₦90 trillion of MRR is not a realistic figure, which is exactly why a wrong
 * one here would be believed — so it throws rather than returning a plausible number.
 */
function toSafeInteger(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`platformRevenue: ${label} is not a safe integer (${raw})`);
  }
  return n;
}

export async function getPlatformRevenue(): Promise<PlatformRevenue> {
  const result = await pool.query<{ plan: string; mrr_kobo: string; count: string }>(
    // The monthly contribution of one subscription, in kobo, computed entirely in
    // numeric: annual plans divide by 12 and round to whole kobo; monthly plans divide
    // by 1, which ROUND leaves untouched because amount_naira * 100 is already integral.
    `SELECT ps.plan,
            COALESCE(SUM(ROUND(ps.amount_naira * 100
                               / CASE WHEN ps.billing_cycle = 'annual' THEN 12 ELSE 1 END)), 0)::bigint
              AS mrr_kobo,
            COUNT(*) AS count
       FROM platform_subscriptions ps
       JOIN schools s ON s.id = ps.school_id
      WHERE ps.subscription_status = 'active'
        AND s.is_active = true
        AND s.is_demo = false
      GROUP BY ps.plan`
  );

  const byPlan = new Map<string, { mrr_kobo: number; count: number }>(
    PLANS.map(plan => [plan, { mrr_kobo: 0, count: 0 }])
  );

  for (const row of result.rows) {
    const entry = byPlan.get(row.plan);
    if (!entry) continue; // a plan outside the known set is not revenue we can classify
    entry.mrr_kobo += toSafeInteger(row.mrr_kobo, `${row.plan} mrr_kobo`);
    entry.count += parseInt(row.count, 10);
  }

  const by_plan = PLANS.map(plan => ({
    plan,
    mrr_kobo: byPlan.get(plan)!.mrr_kobo,
    count: byPlan.get(plan)!.count,
  }));

  return {
    total_mrr_kobo: by_plan.reduce((sum, p) => sum + p.mrr_kobo, 0),
    by_plan,
    currency: 'NGN',
    unit: 'kobo',
  };
}
