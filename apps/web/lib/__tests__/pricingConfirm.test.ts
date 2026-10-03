import { pricingConfirmMessage, type PreviewLine } from '../pricingConfirm';

const school = (over: Partial<PreviewLine> = {}): PreviewLine => ({
  school_name: 'Chronix High School', is_demo: true, billable_students: 6,
  current_amount_kobo: 0, new_amount_kobo: 6 * 80000, kept_reason: null, ...over,
});

describe('the confirmation before a new per-student rate', () => {
  it('reads out each school\'s bill, so a slip shows in the total', () => {
    const msg = pricingConfirmMessage(null, 80000, [school()]);
    expect(msg).toContain('Set the rate to ₦800.00 per enrolled student, per term?');
    expect(msg).toContain('Chronix High School (demo): 6 billable students × ₦800.00 = ₦4,800.00 per term');
    expect(msg).toContain('Every paid subscription is repriced as soon as you confirm.');
    // The slip it exists for: 80 for 800 is a tenth of the bill, in plain sight.
    expect(pricingConfirmMessage(null, 8000, [school({ new_amount_kobo: 6 * 8000 })])).toContain('= ₦480.00 per term');
  });

  it('names the old rate on a change, and a school that keeps its amount says why', () => {
    const msg = pricingConfirmMessage(80000, 100000, [school({ is_demo: false, kept_reason: 'no_current_session', current_amount_kobo: 480000 })]);
    expect(msg).toContain('Change the rate from ₦800.00 to ₦1,000.00');
    expect(msg).toContain('Chronix High School: no current session, so it keeps ₦4,800.00');
  });

  it('prices an example school when none is on a paid plan, so there is still a total to check', () => {
    expect(pricingConfirmMessage(null, 80000, [])).toContain('a school with 100 billable students would pay ₦80,000.00 per term');
  });

  it('lists at most twelve schools and counts the rest', () => {
    const many = Array.from({ length: 15 }, (_, i) => school({ school_name: `School ${i + 1}`, is_demo: false }));
    const msg = pricingConfirmMessage(80000, 80000, many);
    expect(msg).toContain('School 12:');
    expect(msg).not.toContain('School 13:');
    expect(msg).toContain('…and 3 more.');
  });
});
