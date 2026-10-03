import { nairaToKobo, formatKobo } from '../money';

describe('nairaToKobo', () => {
  it('turns what a person types into whole kobo, without float arithmetic', () => {
    expect(nairaToKobo('800')).toBe(80000);
    expect(nairaToKobo(' ₦1,200.75 ')).toBe(120075);
    expect(nairaToKobo('800.5')).toBe(80050);
    // The control: the float way gets this wrong.
    expect(0.29 * 100).not.toBe(29);
    expect(nairaToKobo('0.29')).toBe(29);
  });

  it('refuses anything that is not a positive amount with at most two decimal places', () => {
    for (const bad of ['', '0', '0.00', '-800', '800.123', '8OO', '1e3', '800 naira', '.5']) {
      expect({ bad, kobo: nairaToKobo(bad) }).toEqual({ bad, kobo: null });
    }
  });
});

describe('formatKobo', () => {
  it('shows kobo as naira with two decimals', () => {
    expect(formatKobo(80000)).toBe('₦800.00');
    expect(formatKobo(120075)).toBe('₦1,200.75');
    expect(formatKobo(5)).toBe('₦0.05');
  });
});
