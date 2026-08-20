import { validateRowShape, findDuplicatesWithinFile, runFullValidation } from '../services/bulkImportValidation';
import type { ParsedStudentRow } from '../services/bulkImportParser';

function baseRow(overrides: Partial<ParsedStudentRow> = {}): ParsedStudentRow {
  return {
    row_number: 1,
    first_name: 'Tunde',
    last_name: 'Okonkwo',
    email: null,
    phone: null,
    dob: null,
    gender: null,
    address: null,
    blood_group: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    parent1: null,
    parent2: null,
    ...overrides,
  };
}

describe('validateRowShape', () => {
  it('returns no errors for a minimal valid row', () => {
    expect(validateRowShape(baseRow())).toEqual([]);
  });

  it('flags a missing first or last name', () => {
    expect(validateRowShape(baseRow({ first_name: '' }))).toContain('First Name is required.');
    expect(validateRowShape(baseRow({ last_name: '' }))).toContain('Last Name is required.');
  });

  it('flags a malformed student email', () => {
    const errors = validateRowShape(baseRow({ email: 'not-an-email' }));
    expect(errors.some(e => e.includes('not a valid email'))).toBe(true);
  });

  it('flags a malformed date of birth', () => {
    const errors = validateRowShape(baseRow({ dob: '12/25/2015' }));
    expect(errors.some(e => e.includes('YYYY-MM-DD'))).toBe(true);
  });

  it('flags a parent block with fields filled but no email', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: null, phone: null, relationship_type: 'Mother', is_primary_contact: false },
    }));
    expect(errors.some(e => e.includes('Parent 1') && e.includes('no email'))).toBe(true);
  });

  it('accepts a fully-formed parent block', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    }));
    expect(errors).toEqual([]);
  });

  it('flags a student first_name over 100 characters, matching the single-registration form limit', () => {
    const errors = validateRowShape(baseRow({ first_name: 'A'.repeat(101) }));
    expect(errors).toContain('First Name must be 100 characters or fewer.');
  });

  it('flags a student address over 500 characters', () => {
    const errors = validateRowShape(baseRow({ address: 'A'.repeat(501) }));
    expect(errors).toContain('Address must be 500 characters or fewer.');
  });

  it('flags a parent relationship_type over 50 characters', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'A'.repeat(51), is_primary_contact: false },
    }));
    expect(errors).toContain('Parent 1 Relationship must be 50 characters or fewer.');
  });

  it('flags a parent phone over 30 characters', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: '1'.repeat(31), relationship_type: 'Mother', is_primary_contact: false },
    }));
    expect(errors).toContain('Parent 1 Phone must be 30 characters or fewer.');
  });
});

describe('findDuplicatesWithinFile', () => {
  it('flags the second occurrence of a repeated student email', () => {
    const rows = [
      baseRow({ row_number: 1, email: 'dupe@example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([2]));
  });

  it('flags two rows with the same name and no email at all — the common case, since student email is optional', () => {
    const rows = [
      baseRow({ row_number: 1, first_name: 'Tunde', last_name: 'Okonkwo', email: null }),
      baseRow({ row_number: 2, first_name: 'Tunde', last_name: 'Okonkwo', email: null }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([2]));
  });

  it('does not flag two different students with no email, as long as their names differ', () => {
    const rows = [
      baseRow({ row_number: 1, first_name: 'Tunde', last_name: 'Okonkwo', email: null }),
      baseRow({ row_number: 2, first_name: 'Ada', last_name: 'Bello', email: null }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set());
  });

  it('is case-insensitive', () => {
    const rows = [
      baseRow({ row_number: 1, email: 'Dupe@Example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([2]));
  });
});

describe('runFullValidation', () => {
  it('marks a clean row as valid', async () => {
    const results = await runFullValidation([baseRow()], async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[0].errors).toEqual([]);
  });

  it('marks a row with a shape error as invalid', async () => {
    const results = await runFullValidation([baseRow({ first_name: '' })], async () => new Map());
    expect(results[0].status).toBe('error');
  });

  it('flags a student email that already belongs to any existing account', async () => {
    const rows = [baseRow({ email: 'taken@example.com' })];
    const results = await runFullValidation(rows, async () => new Map([['taken@example.com', 'teacher']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors.some(e => e.includes('already registered'))).toBe(true);
  });

  it('flags a parent email that belongs to a non-parent account', async () => {
    const rows = [baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const results = await runFullValidation(rows, async () => new Map([['bisi@example.com', 'bursar']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors.some(e => e.includes('Parent 1') && e.includes('cannot be used'))).toBe(true);
  });

  it('does NOT flag a parent email that already belongs to an existing parent — that is a legitimate reuse', async () => {
    const rows = [baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const results = await runFullValidation(rows, async () => new Map([['bisi@example.com', 'parent']]));
    expect(results[0].status).toBe('valid');
  });

  it('flags in-file duplicate student emails via runFullValidation end-to-end', async () => {
    const rows = [
      baseRow({ row_number: 1, email: 'dupe@example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    const results = await runFullValidation(rows, async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('error');
    expect(results[1].errors.some(e => e.includes('earlier row'))).toBe(true);
  });

  it('passes the deduplicated, lowercased set of all emails in the file to the lookup function', async () => {
    const rows = [baseRow({
      email: 'Student@Example.com',
      parent1: { first_name: 'A', last_name: 'B', email: 'Parent@Example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const lookup = jest.fn().mockResolvedValue(new Map());
    await runFullValidation(rows, lookup);
    expect(lookup).toHaveBeenCalledWith(expect.arrayContaining(['student@example.com', 'parent@example.com']));
  });
});
