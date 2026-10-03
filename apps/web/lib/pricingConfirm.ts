import { formatKobo } from './money';

/** The parts of a pricing preview the confirmation reads out (lib/superAdminApi.ts PricingPreview). */
export interface PreviewLine {
  school_name: string;
  is_demo: boolean;
  billable_students: number;
  current_amount_kobo: number;
  new_amount_kobo: number;
  kept_reason: 'no_current_session' | null;
}

const MAX_LINES = 12;

/**
 * The question asked before a new per-student rate is saved (3 Oct 2026). It reads out the bill, not
 * just the rate: "6 billable students × ₦800 = ₦4,800 per term". Typing 80 for 800 looks harmless as a
 * rate and obvious as a total, and the API's ceiling cannot catch it. With no paid school yet, it
 * prices an example school so there is still a total to check.
 */
export function pricingConfirmMessage(currentKobo: number | null, newKobo: number, lines: PreviewLine[]): string {
  const head = currentKobo === null
    ? `Set the rate to ${formatKobo(newKobo)} per enrolled student, per term?`
    : `Change the rate from ${formatKobo(currentKobo)} to ${formatKobo(newKobo)} per enrolled student, per term?`;

  const students = (n: number) => `${n} billable student${n === 1 ? '' : 's'}`;
  const body = lines.length === 0
    ? [`No school is on a paid plan yet. For example, a school with ${students(100)} would pay ${formatKobo(100 * newKobo)} per term.`]
    : [
        'Each paid school would be billed:',
        ...lines.slice(0, MAX_LINES).map(l => {
          const name = `${l.school_name}${l.is_demo ? ' (demo)' : ''}`;
          return l.kept_reason === 'no_current_session'
            ? `${name}: no current session, so it keeps ${formatKobo(l.current_amount_kobo)}`
            : `${name}: ${students(l.billable_students)} × ${formatKobo(newKobo)} = ${formatKobo(l.new_amount_kobo)} per term`;
        }),
        ...(lines.length > MAX_LINES ? [`…and ${lines.length - MAX_LINES} more.`] : []),
        '',
        'Every paid subscription is repriced as soon as you confirm.',
      ];
  return [head, '', ...body].join('\n');
}
