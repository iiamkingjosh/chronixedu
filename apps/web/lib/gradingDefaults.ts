/**
 * What School-wide Grading shows before a school has chosen anything (audit, 8 Oct 2026).
 *
 * The page used to open with a five-band scale already in the form, so a school that had set
 * nothing saw a scale and could believe it had one; and it had no pass-mark field at all, so
 * the school-wide pass mark could not be set from any screen (doctrine 8: a value nobody chose
 * must look unchosen).
 */

export interface GradeBand {
  grade: string;
  min: number;
  max: number;
  label: string;
  remark?: string;
}

/** A widely used Nigerian scale, offered by a button, never put in the form on its own. */
export const COMMON_SCALE: GradeBand[] = [
  { grade: 'A', min: 75, max: 100, label: 'Distinction', remark: 'Excellent' },
  { grade: 'B', min: 60, max: 74, label: 'Credit', remark: 'Very Good' },
  { grade: 'C', min: 50, max: 59, label: 'Merit', remark: 'Good' },
  { grade: 'D', min: 40, max: 49, label: 'Pass', remark: 'Fair' },
  { grade: 'F', min: 0, max: 39, label: 'Fail', remark: 'Poor' },
];

export interface GradingFormStart {
  bands: GradeBand[];
  scaleSet: boolean;
  passMark: string;
  passMarkSet: boolean;
}

/** The form's starting state from the school's stored academic config: empty where nothing is set. */
export function initialGradingForm(config: { grading_scale?: unknown; promotion_cutoff?: unknown } | null | undefined): GradingFormStart {
  const scale = Array.isArray(config?.grading_scale) ? (config.grading_scale as GradeBand[]) : [];
  const cutoff = config?.promotion_cutoff;
  const passMarkSet = typeof cutoff === 'number' && Number.isInteger(cutoff);
  return {
    bands: scale,
    scaleSet: scale.length > 0,
    passMark: passMarkSet ? String(cutoff) : '',
    passMarkSet,
  };
}

/** Reads a typed pass mark: a whole number from 0 to 100, or a message saying what is wrong. */
export function parsePassMark(input: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = input.trim();
  if (text === '') return { ok: false, message: 'Enter a pass mark from 0 to 100.' };
  if (!/^\d{1,3}$/.test(text)) return { ok: false, message: 'Enter a whole number from 0 to 100, without a % sign.' };
  const value = Number(text);
  if (value > 100) return { ok: false, message: 'A pass mark cannot be more than 100.' };
  return { ok: true, value };
}
