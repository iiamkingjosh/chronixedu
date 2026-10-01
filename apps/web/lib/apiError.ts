/**
 * Turns an API error body into something a person can read, and a per-field map a form can
 * attach to its inputs.
 *
 * The API answers validation failures with zod's `error.flatten()` —
 * `{ formErrors: [...], fieldErrors: { motto: ['Too small: …'] } }` — and the client used to
 * JSON.stringify whatever was not a string, so that object appeared on screen verbatim, on
 * every page that showed `err.message` (about 150 of them). This is the one place that shape
 * is read. Unknown shapes become a plain sentence, never raw JSON.
 */
export interface DescribedError {
  message: string;
  /** Field name → one readable message, for forms that can show it beside the input. */
  fields: Record<string, string>;
  code?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fields: Record<string, string>;
  constructor(status: number, described: DescribedError) {
    super(described.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = described.code;
    this.fields = described.fields;
  }
}

/** zod's default messages, in words a school administrator would use. */
export function humanizeValidationMessage(raw: string): string {
  let m: RegExpMatchArray | null;
  if (/expected string to have >=1 characters?/i.test(raw)) return 'Required';
  if ((m = raw.match(/expected string to have >=(\d+) characters?/i))) return `Must be at least ${m[1]} characters`;
  if ((m = raw.match(/expected string to have <=(\d+) characters?/i))) return `Must be at most ${m[1]} characters`;
  if (/invalid email/i.test(raw)) return 'Enter a valid email address';
  if (/received undefined/i.test(raw) || /^required$/i.test(raw)) return 'Required';
  if (/expected boolean/i.test(raw)) return 'Choose one of the options';
  if ((m = raw.match(/expected number to be >=(-?\d+(?:\.\d+)?)/i))) return `Must be at least ${m[1]}`;
  if ((m = raw.match(/expected number to be <=(-?\d+(?:\.\d+)?)/i))) return `Must be at most ${m[1]}`;
  if (/expected number/i.test(raw)) return 'Must be a number';
  return raw;
}

/** "school_email" → "School email". */
export function humanizeFieldName(field: string): string {
  const spaced = field.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function describeApiError(json: unknown, fallback: string): DescribedError {
  const err = (json as { error?: unknown } | null)?.error;
  const code = typeof (err as { code?: unknown } | undefined)?.code === 'string' ? (err as { code: string }).code : undefined;
  const message = (err as { message?: unknown } | undefined)?.message ?? (typeof err === 'string' ? err : undefined);

  if (typeof message === 'string' && message.trim()) return { message, fields: {}, code };

  // zod flatten(): { formErrors: string[], fieldErrors: Record<string, string[]> }
  if (message && typeof message === 'object') {
    const formErrors = Array.isArray((message as { formErrors?: unknown }).formErrors)
      ? ((message as { formErrors: unknown[] }).formErrors.filter((x) => typeof x === 'string') as string[])
      : [];
    const rawFields = (message as { fieldErrors?: unknown }).fieldErrors;
    const fields: Record<string, string> = {};
    if (rawFields && typeof rawFields === 'object') {
      for (const [field, msgs] of Object.entries(rawFields as Record<string, unknown>)) {
        const first = Array.isArray(msgs) ? msgs.find((x) => typeof x === 'string') : undefined;
        if (typeof first === 'string') fields[field] = humanizeValidationMessage(first);
      }
    }
    const parts = [
      ...formErrors.map(humanizeValidationMessage),
      ...Object.entries(fields).map(([f, m]) => `${humanizeFieldName(f)}: ${m}`),
    ];
    if (parts.length > 0) {
      return { message: `Please check the highlighted fields. ${parts.join('. ')}.`.replace(/\.\./g, '.'), fields, code };
    }
  }
  return { message: fallback, fields: {}, code };
}
