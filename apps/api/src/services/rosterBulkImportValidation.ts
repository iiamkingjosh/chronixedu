import type { ParsedClassRow, ParsedSubjectRow, ParsedAssignmentRow, ParsedRosterWorkbook } from './rosterBulkImportParser';

export interface ClassValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  class: ParsedClassRow;
  resolved_form_teacher_id: string | null;
}

export interface SubjectValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  subject: ParsedSubjectRow;
}

export interface AssignmentValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  assignment: ParsedAssignmentRow;
  resolved_teacher_id: string | null;
  resolved_class_id: string | null;
  resolved_subject_id: string | null;
}

/**
 * Everything runFullRosterValidation needs from the outside world, injected
 * so this module stays DB-free and unit-testable. existingClasses/
 * existingSubjects/activeTerm are plain values (a single snapshot fetched
 * once by the caller before any commit-time inserts happen) — Teacher
 * Assignment rows must never resolve against something created earlier in
 * the same commit, so this snapshot is never refreshed mid-validation.
 */
export interface RosterValidationDeps {
  existingClasses: { id: string; name: string }[];
  existingSubjects: { id: string; code: string }[];
  lookupTeachersByEmails: (emails: string[]) => Promise<Map<string, { id: string }>>;
  activeTerm: { id: string } | null;
  findDuplicateAssignment: (teacherId: string, classId: string, subjectId: string, termId: string) => Promise<boolean>;
}

function validateClassRow(row: ParsedClassRow): string[] {
  const errors: string[] = [];
  if (!row.name) errors.push('Name is required.');
  else if (row.name.length > 255) errors.push('Name must be 255 characters or fewer.');
  if (!row.level) errors.push('Level is required.');
  else if (row.level.length > 100) errors.push('Level must be 100 characters or fewer.');
  if (row.stream && row.stream.length > 100) errors.push('Stream must be 100 characters or fewer.');
  return errors;
}

function validateSubjectRow(row: ParsedSubjectRow): string[] {
  const errors: string[] = [];
  if (!row.name) errors.push('Name is required.');
  else if (row.name.length > 255) errors.push('Name must be 255 characters or fewer.');
  if (!row.code) errors.push('Code is required.');
  else if (row.code.length > 20) errors.push('Code must be 20 characters or fewer.');
  return errors;
}

function validateAssignmentRowShape(row: ParsedAssignmentRow): string[] {
  const errors: string[] = [];
  if (!row.teacher_email) errors.push('Teacher Email is required.');
  if (!row.class_name) errors.push('Class Name is required.');
  if (!row.subject_code) errors.push('Subject Code is required.');
  return errors;
}

export async function runFullRosterValidation(
  parsed: ParsedRosterWorkbook,
  deps: RosterValidationDeps
): Promise<{ classes: ClassValidationResult[]; subjects: SubjectValidationResult[]; assignments: AssignmentValidationResult[] }> {
  // Every email this validation pass needs — form teachers on Classes rows,
  // plus assignment teachers — resolved in one batched call.
  const teacherEmailsNeeded = new Set<string>();
  for (const row of parsed.classes) {
    if (row.form_teacher_email) teacherEmailsNeeded.add(row.form_teacher_email);
  }
  for (const row of parsed.assignments) {
    if (row.teacher_email) teacherEmailsNeeded.add(row.teacher_email);
  }
  const teacherMatches = await deps.lookupTeachersByEmails([...teacherEmailsNeeded]);

  // ── Classes ──────────────────────────────────────────────────────────────
  const existingClassNames = new Set(deps.existingClasses.map(c => c.name));
  const seenClassNames = new Set<string>();
  const classResults: ClassValidationResult[] = parsed.classes.map(row => {
    const errors = validateClassRow(row);
    if (row.name) {
      if (existingClassNames.has(row.name)) {
        errors.push(`A class named "${row.name}" already exists in this school.`);
      } else if (seenClassNames.has(row.name)) {
        errors.push('This class name also appears in an earlier row of this file.');
      } else {
        seenClassNames.add(row.name);
      }
    }
    let resolvedFormTeacherId: string | null = null;
    if (row.form_teacher_email) {
      const match = teacherMatches.get(row.form_teacher_email);
      if (!match) {
        errors.push(`Form Teacher Email "${row.form_teacher_email}" does not match an existing teacher in this school.`);
      } else {
        resolvedFormTeacherId = match.id;
      }
    }
    return { row_number: row.row_number, status: errors.length === 0 ? 'valid' as const : 'error' as const, errors, class: row, resolved_form_teacher_id: resolvedFormTeacherId };
  });

  // ── Subjects ─────────────────────────────────────────────────────────────
  const existingSubjectCodes = new Set(deps.existingSubjects.map(s => s.code));
  const seenSubjectCodes = new Set<string>();
  const subjectResults: SubjectValidationResult[] = parsed.subjects.map(row => {
    const errors = validateSubjectRow(row);
    if (row.code) {
      if (existingSubjectCodes.has(row.code)) {
        errors.push(`Subject code "${row.code}" already exists in this school.`);
      } else if (seenSubjectCodes.has(row.code)) {
        errors.push('This subject code also appears in an earlier row of this file.');
      } else {
        seenSubjectCodes.add(row.code);
      }
    }
    return { row_number: row.row_number, status: errors.length === 0 ? 'valid' as const : 'error' as const, errors, subject: row };
  });

  // ── Teacher Assignments ──────────────────────────────────────────────────
  const classByName = new Map(deps.existingClasses.map(c => [c.name, c.id]));
  const subjectByCode = new Map(deps.existingSubjects.map(s => [s.code, s.id]));
  const seenAssignmentKeys = new Set<string>();
  const assignmentResults: AssignmentValidationResult[] = [];

  for (const row of parsed.assignments) {
    const errors = validateAssignmentRowShape(row);
    let teacherId: string | null = null;
    let classId: string | null = null;
    let subjectId: string | null = null;

    if (row.teacher_email) {
      const match = teacherMatches.get(row.teacher_email);
      if (!match) {
        errors.push(`Teacher Email "${row.teacher_email}" does not match an existing teacher in this school.`);
      } else {
        teacherId = match.id;
      }
    }
    if (row.class_name) {
      const id = classByName.get(row.class_name);
      if (!id) {
        errors.push(`Class Name "${row.class_name}" does not match an existing class in this school.`);
      } else {
        classId = id;
      }
    }
    if (row.subject_code) {
      const id = subjectByCode.get(row.subject_code);
      if (!id) {
        errors.push(`Subject Code "${row.subject_code}" does not match an existing subject in this school.`);
      } else {
        subjectId = id;
      }
    }
    if (!deps.activeTerm) {
      errors.push('No active term found for this school. Activate a session and term first.');
    }

    if (teacherId && classId && subjectId) {
      const key = `${teacherId}|${classId}|${subjectId}`;
      if (seenAssignmentKeys.has(key)) {
        errors.push('This teacher/class/subject combination also appears in an earlier row of this file.');
      } else {
        seenAssignmentKeys.add(key);
        if (deps.activeTerm) {
          const isDuplicate = await deps.findDuplicateAssignment(teacherId, classId, subjectId, deps.activeTerm.id);
          if (isDuplicate) {
            errors.push('This teacher is already assigned to this class and subject for the current term.');
          }
        }
      }
    }

    assignmentResults.push({
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' : 'error',
      errors,
      assignment: row,
      resolved_teacher_id: teacherId,
      resolved_class_id: classId,
      resolved_subject_id: subjectId,
    });
  }

  return { classes: classResults, subjects: subjectResults, assignments: assignmentResults };
}
