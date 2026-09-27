import pool from '../client';

/**
 * Platform MRR, as one aggregate.
 *
 * There were two MRR figures in this product: `/super-admin/subscriptions/mrr` summed
 * every active subscription, while `/super-admin/analytics/overview` excluded demo and
 * suspended schools after d5c7716. They agree today only because no demo school has a
 * subscription — a latent disagreement, not an absent one.
 *
 * Adding `/api/partner/revenue` for the ERP would have made it three. This is the single
 * source all of them read, so the number Chronix quotes internally and the number the ERP
 * pulls cannot drift apart.
 *
 * Demo tenants and suspended schools are excluded, matching the overview: a fixture
 * school's subscription is not revenue, and a suspended school is not billing this month.
 */

export interface PlanRevenue {
  plan: string;
  mrr: number;
  count: number;
}

export interface PlatformRevenue {
  total_mrr: number;
  by_plan: PlanRevenue[];
  currency: 'NGN';
}

const PLANS = ['basic', 'premium', 'enterprise'] as const;

export async function getPlatformRevenue(): Promise<PlatformRevenue> {
  const result = await pool.query<{ plan: string; billing_cycle: string; total_amount: string; count: string }>(
    `SELECT ps.plan, ps.billing_cycle,
            COALESCE(SUM(ps.amount_naira), 0) AS total_amount,
            COUNT(*) AS count
       FROM platform_subscriptions ps
       JOIN schools s ON s.id = ps.school_id
      WHERE ps.subscription_status = 'active'
        AND s.is_active = true
        AND s.is_demo = false
      GROUP BY ps.plan, ps.billing_cycle`
  );

  const byPlan = new Map<string, { mrr: number; count: number }>(
    PLANS.map(plan => [plan, { mrr: 0, count: 0 }])
  );

  for (const row of result.rows) {
    const entry = byPlan.get(row.plan);
    if (!entry) continue; // a plan outside the known set is not revenue we can classify
    const amount = Number(row.total_amount);
    entry.mrr += row.billing_cycle === 'annual' ? amount / 12 : amount;
    entry.count += parseInt(row.count, 10);
  }

  const by_plan = PLANS.map(plan => ({ plan, mrr: byPlan.get(plan)!.mrr, count: byPlan.get(plan)!.count }));
  return {
    total_mrr: by_plan.reduce((sum, p) => sum + p.mrr, 0),
    by_plan,
    currency: 'NGN',
  };
}
