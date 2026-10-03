/**
 * Naira as people type it, and kobo as the API carries it (CLAUDE.md doctrine 11: money crosses the
 * API as integer kobo, never naira floats). Conversion here is string arithmetic, never `* 100` on a
 * float: 0.29 * 100 is 28.999999999999996 in JavaScript.
 */

/**
 * "800", "800.5", "₦1,200.75" → kobo as a whole number. Anything else, or a value that is not more
 * than zero, → null. At most two decimal places: a third would be a fraction of a kobo.
 */
export function nairaToKobo(input: string): number | null {
  const cleaned = input.trim().replace(/^₦\s*/, '').replace(/,/g, '');
  const m = cleaned.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const kobo = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return kobo > 0 ? kobo : null;
}

/** 80000 → "₦800.00". Display only. */
export function formatKobo(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const rest = String(kobo % 100).padStart(2, '0');
  return `₦${naira.toLocaleString('en-NG')}.${rest}`;
}
