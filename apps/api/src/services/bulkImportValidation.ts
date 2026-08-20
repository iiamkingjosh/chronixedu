import type { ParsedStudentRow, ParsedParentRow } from './bulkImportParser';

export interface RowValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  student: ParsedStudentRow;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateParent(parent: ParsedParentRow, label: string): string[] {
  const errors: string[] = [];
  if (!parent.email) {
    errors.push(`${label} has other fields filled in but no email — email is required for a parent contact.`);
    return errors;
  }
  if (!EMAIL_PATTERN.test(parent.email)) {
    errors.push(`${label} email "${parent.email}" is not a valid email address.`);
  }
  if (!parent.first_name || !parent.last_name) {
    errors.push(`${label} is missing a first or last name.`);
  }
  if (parent.first_name && parent.first_name.length > 100) errors.push(`${label} First Name must be 100 characters or fewer.`);
  if (parent.last_name && parent.last_name.length > 100) errors.push(`${label} Last Name must be 100 characters or fewer.`);
  if (parent.phone && parent.phone.length > 30) errors.push(`${label} Phone must be 30 characters or fewer.`);
  if (!parent.relationship_type) {
    errors.push(`${label} is missing a relationship (e.g. Father, Mother, Guardian).`);
  } else if (parent.relationship_type.length > 50) {
    errors.push(`${label} Relationship must be 50 characters or fewer.`);
  }
  return errors;
}

export function validateRowShape(row: ParsedStudentRow): string[] {
  const errors: string[] = [];
  if (!row.first_name) errors.push('First Name is required.');
  else if (row.first_name.length > 100) errors.push('First Name must be 100 characters or fewer.');
  if (!row.last_name) errors.push('Last Name is required.');
  else if (row.last_name.length > 100) errors.push('Last Name must be 100 characters or fewer.');
  if (row.email && !EMAIL_PATTERN.test(row.email)) errors.push(`Student email "${row.email}" is not a valid email address.`);
  if (row.dob && !DATE_PATTERN.test(row.dob)) errors.push(`Date of Birth "${row.dob}" must be in YYYY-MM-DD format.`);
  if (row.phone && row.phone.length > 30) errors.push('Phone must be 30 characters or fewer.');
  if (row.gender && row.gender.length > 50) errors.push('Gender must be 50 characters or fewer.');
  if (row.address && row.address.length > 500) errors.push('Address must be 500 characters or fewer.');
  if (row.blood_group && row.blood_group.length > 20) errors.push('Blood Group must be 20 characters or fewer.');
  if (row.emergency_contact_name && row.emergency_contact_name.length > 200) errors.push('Emergency Contact Name must be 200 characters or fewer.');
  if (row.emergency_contact_phone && row.emergency_contact_phone.length > 30) errors.push('Emergency Contact Phone must be 30 characters or fewer.');
  if (row.parent1) errors.push(...validateParent(row.parent1, 'Parent 1'));
  if (row.parent2) errors.push(...validateParent(row.parent2, 'Parent 2'));
  return errors;
}

/**
 * Row numbers that repeat an earlier row's first name + last name + student email
 * (case-insensitive). Keying on the composite tuple — not email alone — means two
 * rows for the same student with no email at all are still caught as duplicates
 * (the common case, since student email is optional), while two different students
 * who happen to share a name are not falsely flagged as long as their emails differ.
 */
export function findDuplicatesWithinFile(rows: ParsedStudentRow[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    const key = `${row.first_name.toLowerCase()}|${row.last_name.toLowerCase()}|${(row.email ?? '').toLowerCase()}`;
    if (seen.has(key)) {
      duplicates.add(row.row_number);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

/**
 * Combines shape validation, in-file duplicate detection, and a DB-backed
 * email-conflict check into the final per-row verdict. lookupEmailRoles is
 * injected so this stays unit-testable without a real database — the route
 * layer wires it to a real query, tests wire it to a stub.
 */
export async function runFullValidation(
  rows: ParsedStudentRow[],
  lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>
): Promise<RowValidationResult[]> {
  const duplicateRowNumbers = findDuplicatesWithinFile(rows);

  const allEmails = new Set<string>();
  for (const row of rows) {
    if (row.email) allEmails.add(row.email.toLowerCase());
    if (row.parent1?.email) allEmails.add(row.parent1.email.toLowerCase());
    if (row.parent2?.email) allEmails.add(row.parent2.email.toLowerCase());
  }
  const existingRoles = allEmails.size > 0 ? await lookupEmailRoles([...allEmails]) : new Map<string, string>();

  return rows.map(row => {
    const errors = validateRowShape(row);

    if (duplicateRowNumbers.has(row.row_number)) {
      errors.push('This student (same name and email) also appears in an earlier row of this file.');
    }

    if (row.email) {
      const existingRole = existingRoles.get(row.email.toLowerCase());
      if (existingRole) {
        errors.push(`Student email "${row.email}" is already registered to an existing ${existingRole} account.`);
      }
    }

    (['parent1', 'parent2'] as const).forEach(key => {
      const parent = row[key];
      const label = key === 'parent1' ? 'Parent 1' : 'Parent 2';
      if (!parent?.email) return;
      const existingRole = existingRoles.get(parent.email.toLowerCase());
      if (existingRole && existingRole !== 'parent') {
        errors.push(`${label} email "${parent.email}" already belongs to an existing ${existingRole} account and cannot be used as a parent contact.`);
      }
    });

    return {
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' as const : 'error' as const,
      errors,
      student: row,
    };
  });
}
