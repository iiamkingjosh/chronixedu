import { runFullStaffValidation, validateStaffRowShape, findDuplicatesWithinFile } from '../services/staffBulkImportValidation';
import type { ParsedStaffRow } from '../services/staffBulkImportParser';

function row(overrides: Partial<ParsedStaffRow> = {}): ParsedStaffRow {
  return {
    row_number: 2,
    email: 'chidi@example.com',
    first_name: 'Chidi',
    last_name: 'Okafor',
    role: 'teacher',
    title: null,
    phone: null,
    teacher_mode: 'subject',
    ...overrides,
  };
}

describe('validateStaffRowShape', () => {
  it('accepts a minimal valid teacher row', () => {
    expect(validateStaffRowShape(row())).toEqual([]);
  });

  it('flags a missing email, first name, last name', () => {
    const errors = validateStaffRowShape(row({ email: '', first_name: '', last_name: '' }));
    expect(errors).toContain('Email is required.');
    expect(errors).toContain('First Name is required.');
    expect(errors).toContain('Last Name is required.');
  });

  it('flags an invalid email format', () => {
    expect(validateStaffRowShape(row({ email: 'not-an-email' }))).toContain('Email "not-an-email" is not a valid email address.');
  });

  it('flags a role outside teacher/registrar/bursar/principal', () => {
    expect(validateStaffRowShape(row({ role: 'parent' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
    expect(validateStaffRowShape(row({ role: 'student' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
    expect(validateStaffRowShape(row({ role: 'super_admin' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
  });

  it('requires teacher_mode when role is teacher', () => {
    expect(validateStaffRowShape(row({ role: 'teacher', teacher_mode: null }))).toContain('Teaching Mode is required for a teacher (must be "class" or "subject").');
  });

  it('rejects an invalid teacher_mode value', () => {
    expect(validateStaffRowShape(row({ role: 'teacher', teacher_mode: 'both' }))).toContain('Teaching Mode must be "class" or "subject".');
  });

  it('rejects a teacher_mode value on a non-teacher row', () => {
    expect(validateStaffRowShape(row({ role: 'registrar', teacher_mode: 'subject' }))).toContain('Teaching Mode must be blank unless Role is teacher.');
  });

  it('accepts a non-teacher row with no teacher_mode', () => {
    expect(validateStaffRowShape(row({ role: 'registrar', teacher_mode: null }))).toEqual([]);
  });

  it('flags field lengths over the createUserSchema limits', () => {
    const errors = validateStaffRowShape(row({ title: 'x'.repeat(21), phone: 'x'.repeat(51), first_name: 'x'.repeat(256) }));
    expect(errors).toContain('Title must be 20 characters or fewer.');
    expect(errors).toContain('Phone must be 50 characters or fewer.');
    expect(errors).toContain('First Name must be 255 characters or fewer.');
  });
});

describe('findDuplicatesWithinFile', () => {
  it('flags the second of two rows sharing an email, case-insensitively', () => {
    const rows = [row({ row_number: 2, email: 'a@example.com' }), row({ row_number: 3, email: 'A@Example.com' })];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([3]));
  });

  it('does not flag two different emails', () => {
    const rows = [row({ row_number: 2, email: 'a@example.com' }), row({ row_number: 3, email: 'b@example.com' })];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set());
  });
});

describe('runFullStaffValidation', () => {
  it('marks a valid row as valid when the email has no existing account', async () => {
    const results = await runFullStaffValidation([row()], async () => new Map());
    expect(results[0].status).toBe('valid');
  });

  it('flags an email that already belongs to an existing account', async () => {
    const results = await runFullStaffValidation([row()], async () => new Map([['chidi@example.com', 'teacher']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('already registered to an existing teacher account');
  });

  it('flags in-file duplicates alongside shape errors', async () => {
    const rows = [row({ row_number: 2 }), row({ row_number: 3 })];
    const results = await runFullStaffValidation(rows, async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('error');
    expect(results[1].errors[0]).toContain('also appears in an earlier row');
  });

  it('does not call the email lookup when there are no rows', async () => {
    const lookup = jest.fn(async () => new Map());
    await runFullStaffValidation([], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
