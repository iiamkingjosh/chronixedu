import { PAYSTACK_LOCAL_PRICING as P, paystackChargeKobo, totalForSchoolToReceive } from '../services/paystackPricing';

/**
 * The convenience fee (6 Oct 2026): what a parent pays so that, after Paystack's charge, the school
 * receives its whole fee. Worked examples first, at each edge of Paystack's pricing; then the two
 * properties every answer must have, over a sweep: the school is never short, and no smaller total would do.
 */
const receives = (total: number) => total - paystackChargeKobo(total);

describe("Paystack's charge", () => {
  it('1.5% under ₦2,500, with a fraction of a kobo counted as a whole one', () => {
    expect(paystackChargeKobo(10_000)).toBe(150); // ₦100 → ₦1.50
    expect(paystackChargeKobo(10_153)).toBe(153); // 152.295 kobo → 153
    expect(paystackChargeKobo(249_999)).toBe(3_750);
  });

  it('plus ₦100 from ₦2,500', () => {
    expect(paystackChargeKobo(250_000)).toBe(3_750 + 10_000);
  });

  it('never more than ₦2,000', () => {
    expect(paystackChargeKobo(12_666_666)).toBe(190_000 + 10_000); // just reaches the cap
    expect(paystackChargeKobo(50_000_000)).toBe(200_000);
  });
});

describe('what a parent pays for the school to receive its fee', () => {
  it.each([
    // [school fee, total, convenience fee], kobo
    ['₦50,000', 5_000_000, 5_086_295, 86_295],
    ['₦100', 10_000, 10_153, 153],
    ['₦2,450: the total stays under ₦2,500, so no ₦100', 245_000, 248_731, 3_731],
    ['₦2,470: the total would reach ₦2,500, so the ₦100 applies', 247_000, 260_914, 13_914],
    ['₦200,000: the charge is capped at ₦2,000', 20_000_000, 20_200_000, 200_000],
  ])('%s', (_label, fee, total, convenience) => {
    expect(totalForSchoolToReceive(fee)).toEqual({ totalKobo: total, convenienceFeeKobo: convenience });
    expect(receives(total)).toBeGreaterThanOrEqual(fee);
    expect(receives(total - 1)).toBeLessThan(fee);
  });

  it('over a sweep: the school is never short, and no smaller total would do', () => {
    const fees: number[] = [];
    for (let k = 1; k <= 3_000; k++) fees.push(k);                       // the smallest amounts
    for (let k = 236_000; k <= 262_000; k++) fees.push(k);               // around the ₦2,500 step
    for (let k = 12_440_000; k <= 12_500_000; k += 7) fees.push(k);      // around the cap
    for (let k = 1; k <= 2_000; k++) fees.push(k * 499_999);             // up to ~₦10m
    const highestBelowStep = receives(P.flatFromKobo - 1);
    for (const fee of fees) {
      const { totalKobo, convenienceFeeKobo } = totalForSchoolToReceive(fee);
      const ok = receives(totalKobo) >= fee
        && receives(totalKobo - 1) < fee
        // What the school receives drops at ₦2,500, so a total above it is smallest only if nothing
        // below ₦2,500 would have done.
        && (totalKobo < P.flatFromKobo || highestBelowStep < fee)
        && convenienceFeeKobo === totalKobo - fee
        && convenienceFeeKobo <= P.capKobo;
      if (!ok) throw new Error(`fee ${fee} kobo → total ${totalKobo}: receives ${receives(totalKobo)}`);
    }
    expect(fees.length).toBeGreaterThan(30_000);
  });

  it('refuses anything but a positive whole number of kobo', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => totalForSchoolToReceive(bad)).toThrow(RangeError);
    }
    expect(totalForSchoolToReceive(1).totalKobo).toBe(2);
  });
});
