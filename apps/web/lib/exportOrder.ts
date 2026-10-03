/**
 * The order of the single-spreadsheet downloads on Settings → Data Export (3 Oct 2026).
 *
 * The ones most often wanted on their own come first: students, the accounts (staff, parents and
 * students) and the audit log. Every other dataset follows in the order the API lists it. This only
 * reorders: every dataset the API returns is shown exactly once, because a dropped one would hide
 * part of the school's data without a word. What the export contains is decided by the API
 * (EXPORT_DATASETS), never here.
 */
export const FIRST_DATASETS = ['students', 'people', 'audit_log'] as const;

export function orderDatasets<T extends { key: string }>(datasets: T[]): T[] {
  const rank = (key: string) => {
    const i = (FIRST_DATASETS as readonly string[]).indexOf(key);
    return i === -1 ? FIRST_DATASETS.length : i;
  };
  // Array.prototype.sort is stable, so the rest keep the API's order.
  return [...datasets].sort((a, b) => rank(a.key) - rank(b.key));
}
