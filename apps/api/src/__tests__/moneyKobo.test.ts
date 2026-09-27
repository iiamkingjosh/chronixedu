/**
 * Money arithmetic in the payment path.
 *
 * The audit recorded this as accumulation drift: repeated partial payments leaving a
 * residue so an invoice never settles. Measured, that does NOT happen — every money
 * column is numeric(12,2) and values return from pg as exact 2-dp strings, so a single
 * float addition per payment is laundered by the round-trip. A search over invoice
 * totals from ₦1,000 to ₦500,000 split 3, 6, 7 and 9 ways found zero cases where the
 * float sum missed the total.
 *
 * The real defect was one line away and worse, because it rejects a payment rather than
 * mis-stating one. The overpayment guard compared a float SUBTRACTION against the
 * amount tendered:
 *
 *   250000.00 − 83333.33 = 166666.66999999998
 *   parent tenders the exact remaining 166666.67
 *   166666.67 > 166666.66999999998  →  OverpaymentError
 *
 * A bursar keying in the exact closing balance was told it was an overpayment. Three of
 * six realistic settlement cases behaved that way.
 */
import { toKobo, fromKobo } from '../services/money';
import { deriveStatus } from '../db/queries/fees';

/** The float expression that used to guard overpayment, kept for contrast. */
const floatOutstanding = (total: string, paid: string) => Number(total) - Number(paid);

describe('toKobo / fromKobo round-trip', () => {
  it.each([
    ['0.00', 0], ['0.01', 1], ['0.07', 7], ['166666.67', 16666667],
    ['99999.99', 9999999], ['250000.00', 25000000],
  ])('%s naira is %i kobo', (naira, kobo) => {
    expect(toKobo(naira)).toBe(kobo);
    expect(fromKobo(kobo)).toBe(Number(naira).toFixed(2));
  });

  it('accepts the numbers zod hands the route as well as the strings pg returns', () => {
    expect(toKobo(166666.67)).toBe(toKobo('166666.67'));
  });

  it('rounds rather than truncates, so a half kobo cannot vanish', () => {
    // Number('0.1') * 100 is 10.000000000000002; Math.floor would give 9.
    expect(toKobo('0.1')).toBe(10);
    expect(toKobo('1.005')).toBe(101);
  });
});

describe('a parent paying their exact remaining balance is not an overpayment', () => {
  // Each case is (invoice total, already paid, exact remaining). Every one of these is
  // a legitimate final settlement that must be accepted.
  const settlements: Array<[string, string, string]> = [
    ['100000.00', '99999.99', '0.01'],
    ['12500.00',  '12499.93', '0.07'],
    ['250000.00', '83333.33', '166666.67'],
    ['50000.00',  '49999.70', '0.30'],
    ['75000.00',  '74999.29', '0.71'],
    ['100000.00', '33333.33', '66666.67'],
  ];

  it.each(settlements)('total %s, paid %s, tender %s is accepted', (total, paid, tender) => {
    const outstandingKobo = toKobo(total) - toKobo(paid);
    expect(toKobo(tender) > outstandingKobo).toBe(false);
  });

  it('is a real change — the float comparison refused several of these', () => {
    const refused = settlements.filter(([total, paid, tender]) =>
      Number(tender) > floatOutstanding(total, paid));
    expect(refused.length).toBeGreaterThan(0); // guards against a vacuous test
    // And every one of them passes under kobo.
    for (const [total, paid, tender] of refused) {
      expect(toKobo(tender) > toKobo(total) - toKobo(paid)).toBe(false);
    }
  });

  it('still rejects a genuine overpayment, by a single kobo', () => {
    const outstandingKobo = toKobo('250000.00') - toKobo('83333.33');
    expect(toKobo('166666.68') > outstandingKobo).toBe(true);
  });
});

describe('an invoice settles exactly, however it is split', () => {
  /** Replays the route: read 2-dp state, add in kobo, write 2-dp state back. */
  function payAll(total: string, parts: string[]) {
    let paid = '0.00';
    for (const part of parts) {
      const paidKobo = toKobo(paid) + toKobo(part);
      paid = fromKobo(paidKobo);          // the numeric(12,2) round-trip
    }
    const totalKobo = toKobo(total);
    const paidKobo = toKobo(paid);
    return {
      paid,
      balance: fromKobo(totalKobo - paidKobo),
      status: deriveStatus(totalKobo, paidKobo),
    };
  }

  it('settles a three-way split of ₦100,000', () => {
    expect(payAll('100000.00', ['33333.33', '33333.33', '33333.34']))
      .toEqual({ paid: '100000.00', balance: '0.00', status: 'paid' });
  });

  it('settles a seven-way split, the awkward one', () => {
    const each = '14285.71';
    const parts = [each, each, each, each, each, each, '14285.74'];
    expect(payAll('100000.00', parts))
      .toEqual({ paid: '100000.00', balance: '0.00', status: 'paid' });
  });

  it('leaves an exact balance mid-way, not a floating residue', () => {
    const r = payAll('100000.00', ['33333.33', '33333.33']);
    expect(r.balance).toBe('33333.34');
    expect(r.status).toBe('partial');
  });

  it('reports unpaid before anything is paid', () => {
    expect(payAll('100000.00', []).status).toBe('unpaid');
  });

  it('treats a Paystack overpayment as a credit, not an error', () => {
    // The route records these in full; the balance goes negative deliberately.
    const r = payAll('1000.00', ['1500.00']);
    expect(r.balance).toBe('-500.00');
    expect(r.status).toBe('paid');
  });
});
