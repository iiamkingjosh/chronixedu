/**
 * What Paystack charges on a local naira payment, and what a parent pays when their school has chosen to
 * pass that charge on as a convenience fee (`fee_config.convenience_fee_payer = 'parent'`, 6 Oct 2026).
 *
 * Paystack's standard local pricing, read from its pricing page on 6 Oct 2026: 1.5% plus ₦100, the ₦100
 * waived on a payment under ₦2,500, the whole charge never more than ₦2,000. Paystack's written reply of
 * 7 Oct 2026 allows marking the fee up on our own site, and rules out education pricing for Chronix
 * (docs/paystack-runbook.md). If Paystack's pricing changes, these numbers change here and nowhere else.
 *
 * The charge falls on what the PARENT pays, which includes the convenience fee itself, so the fee is grossed
 * up: the smallest total whose charge still leaves the school its whole fee. A fraction of a kobo in
 * Paystack's charge is counted as a whole kobo, so whichever way Paystack rounds, the school is never short.
 * A foreign card costs more (3.9% + ₦100) and is not covered: the school then receives a little less.
 */
export const PAYSTACK_LOCAL_PRICING = {
  /** 1.5%, in hundredths of a percent. */
  percentBasisPoints: 150,
  /** ₦100. */
  flatKobo: 10_000,
  /** The ₦100 is charged on payments of ₦2,500 or more. */
  flatFromKobo: 250_000,
  /** ₦2,000. */
  capKobo: 200_000,
} as const;

/** Exact for whole numbers below 2^53, with no float division. */
const ceilDiv = (a: number, b: number): number => (a - (a % b)) / b + (a % b === 0 ? 0 : 1);

/** Paystack's charge on a payment of `totalKobo`, with a fraction of a kobo counted as a whole one. */
export function paystackChargeKobo(totalKobo: number): number {
  const p = PAYSTACK_LOCAL_PRICING;
  const flat = totalKobo >= p.flatFromKobo ? p.flatKobo : 0;
  return Math.min(ceilDiv(totalKobo * p.percentBasisPoints, 10_000) + flat, p.capKobo);
}

/**
 * The smallest total a parent can pay for the school to receive at least `feeKobo` once Paystack has taken
 * its charge, and the convenience fee that adds.
 *
 * What the school receives (total minus charge) rises with the total everywhere except at ₦2,500, where the
 * ₦100 starts and it drops. So the search runs below ₦2,500 first, and from ₦2,500 only if that fails.
 */
export function totalForSchoolToReceive(feeKobo: number): { totalKobo: number; convenienceFeeKobo: number } {
  if (!Number.isSafeInteger(feeKobo) || feeKobo <= 0) {
    throw new RangeError('feeKobo must be a positive whole number of kobo');
  }
  const p = PAYSTACK_LOCAL_PRICING;
  const receives = (total: number) => total - paystackChargeKobo(total);
  const smallest = (lo: number, hi: number): number | null => {
    if (lo > hi || receives(hi) < feeKobo) return null;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (receives(mid) >= feeKobo) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  // The charge never exceeds the cap, so fee + cap always leaves the school its fee.
  const totalKobo = smallest(feeKobo, p.flatFromKobo - 1)
    ?? smallest(Math.max(feeKobo, p.flatFromKobo), Math.max(p.flatFromKobo, feeKobo + p.capKobo))!;
  return { totalKobo, convenienceFeeKobo: totalKobo - feeKobo };
}
