import { describeApiError, humanizeValidationMessage, humanizeFieldName } from '../apiError';

/**
 * The defect: the onboarding Branding step showed
 *   {"formErrors":[],"fieldErrors":{"motto":["Too small: expected string to have >=1 characters"]}}
 * on screen, because the client JSON.stringify'd any non-string error message. This is the exact
 * body the API sent; the assertions are on what a person sees.
 */
const BRANDING_400 = {
  success: false,
  error: { code: 'VALIDATION_ERROR', message: { formErrors: [], fieldErrors: { motto: ['Too small: expected string to have >=1 characters'] } } },
};

describe('describeApiError', () => {
  it('turns a zod flatten() body into a readable message and a field map — never raw JSON', () => {
    const d = describeApiError(BRANDING_400, 'Request failed (400)');
    expect(d.message).not.toMatch(/[{}[\]"]|fieldErrors|Too small/);
    expect(d.message).toBe('Please check the highlighted fields. Motto: Required.');
    expect(d.fields).toEqual({ motto: 'Required' });
    expect(d.code).toBe('VALIDATION_ERROR');
  });

  it('keeps a string message as it is', () => {
    expect(describeApiError({ error: { code: 'EMAIL_IN_USE', message: 'A user with this email already exists' } }, 'x'))
      .toEqual({ message: 'A user with this email already exists', fields: {}, code: 'EMAIL_IN_USE' });
  });

  it('includes form-level errors, and several fields', () => {
    const d = describeApiError({ error: { message: {
      formErrors: ['At least one field is required'],
      fieldErrors: { school_email: ['Invalid email address'], address: ['Invalid input: expected string, received undefined'] },
    } } }, 'x');
    expect(d.fields).toEqual({ school_email: 'Enter a valid email address', address: 'Required' });
    expect(d.message).toBe('Please check the highlighted fields. At least one field is required. School email: Enter a valid email address. Address: Required.');
  });

  it('falls back to a plain sentence for any shape it does not know — never JSON', () => {
    expect(describeApiError({ error: { message: { weird: true } } }, 'Request failed (500)').message).toBe('Request failed (500)');
    expect(describeApiError(null, 'Request failed (502)').message).toBe('Request failed (502)');
    expect(describeApiError({ error: 'Plain string error' }, 'x').message).toBe('Plain string error');
  });
});

describe('humanizing', () => {
  it.each([
    ['Too small: expected string to have >=1 characters', 'Required'],
    ['Too small: expected string to have >=3 characters', 'Must be at least 3 characters'],
    ['Too big: expected string to have <=10 characters', 'Must be at most 10 characters'],
    ['Invalid email address', 'Enter a valid email address'],
    ['Invalid input: expected boolean, received string', 'Choose one of the options'],
    ['A message the API wrote itself', 'A message the API wrote itself'],
  ])('%s → %s', (raw, readable) => expect(humanizeValidationMessage(raw)).toBe(readable));

  it('field names read as words', () => {
    expect(humanizeFieldName('school_email')).toBe('School email');
    expect(humanizeFieldName('primary_colour')).toBe('Primary colour');
  });
});
