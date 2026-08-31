import type { ParsedStaffRow } from './staffBulkImportParser';

export const STAFF_ROLES = ['teacher', 'registrar', 'bursar', 'principal'] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export interface StaffValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  staff: ParsedStaffRow;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateStaffRowShape(row: ParsedStaffRow): string[] {
  const errors: string[] = [];

  if (!row.email) errors.push('Email is required.');
  else if (!EMAIL_PATTERN.test(row.email)) errors.push(`Email "${row.email}" is not a valid email address.`);

  if (!row.first_name) errors.push('First Name is required.');
  else if (row.first_name.length > 255) errors.push('First Name must be 255 characters or fewer.');

  if (!row.last_name) errors.push('Last Name is required.');
  else if (row.last_name.length > 255) errors.push('Last Name must be 255 characters or fewer.');

  if (!row.role) {
    errors.push('Role is required.');
  } else if (!(STAFF_ROLES as readonly string[]).includes(row.role)) {
    errors.push(`Role must be one of: ${STAFF_ROLES.join(', ')}.`);
  }

  if (row.title && row.title.length > 20) errors.push('Title must be 20 characters or fewer.');
  if (row.phone && row.phone.length > 50) errors.push('Phone must be 50 characters or fewer.');

  if (row.role === 'teacher') {
    if (!row.teacher_mode) {
      errors.push('Teaching Mode is required for a teacher (must be "class" or "subject").');
    } else if (row.teacher_mode !== 'class' && row.teacher_mode !== 'subject') {
      errors.push('Teaching Mode must be "class" or "subject".');
    }
  } else if (row.teacher_mode) {
    errors.push('Teaching Mode must be blank unless Role is teacher.');
  }

  return errors;
}

/** Row numbers that repeat an earlier row's email, case-insensitively — email
 *  is the true uniqueness key here (unlike Students, where student email is
 *  optional and a name+email composite key was needed). */
export function findDuplicatesWithinFile(rows: ParsedStaffRow[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
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
 * layer wires it to the existing findUsersRolesByEmails query.
 */
export async function runFullStaffValidation(
  rows: ParsedStaffRow[],
  lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>
): Promise<StaffValidationResult[]> {
  const duplicateRowNumbers = findDuplicatesWithinFile(rows);

  const allEmails = new Set<string>();
  for (const row of rows) {
    if (row.email) allEmails.add(row.email.toLowerCase());
  }
  const existingRoles = allEmails.size > 0 ? await lookupEmailRoles([...allEmails]) : new Map<string, string>();

  return rows.map(row => {
    const errors = validateStaffRowShape(row);

    if (duplicateRowNumbers.has(row.row_number)) {
      errors.push('This email also appears in an earlier row of this file.');
    }

    if (row.email) {
      const existingRole = existingRoles.get(row.email.toLowerCase());
      if (existingRole) {
        errors.push(`Email "${row.email}" is already registered to an existing ${existingRole} account.`);
      }
    }

    return {
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' as const : 'error' as const,
      errors,
      staff: row,
    };
  });
}
