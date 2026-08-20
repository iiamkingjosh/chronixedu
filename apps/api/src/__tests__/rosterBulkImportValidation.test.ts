import { runFullRosterValidation, type RosterValidationDeps } from '../services/rosterBulkImportValidation';
import type { ParsedClassRow, ParsedSubjectRow, ParsedAssignmentRow } from '../services/rosterBulkImportParser';

function classRow(overrides: Partial<ParsedClassRow> = {}): ParsedClassRow {
  return { row_number: 2, name: 'JSS 1A', level: 'JSS1', stream: null, form_teacher_email: null, ...overrides };
}
function subjectRow(overrides: Partial<ParsedSubjectRow> = {}): ParsedSubjectRow {
  return { row_number: 2, name: 'Mathematics', code: 'MTH', ...overrides };
}
function assignmentRow(overrides: Partial<ParsedAssignmentRow> = {}): ParsedAssignmentRow {
  return { row_number: 2, teacher_email: 'teacher@example.com', class_name: 'JSS 1A', subject_code: 'MTH', ...overrides };
}

function baseDeps(overrides: Partial<RosterValidationDeps> = {}): RosterValidationDeps {
  return {
    existingClasses: [],
    existingSubjects: [],
    lookupTeachersByEmails: async () => new Map(),
    activeTerm: { id: 'term-1' },
    findDuplicateAssignment: async () => false,
    ...overrides,
  };
}

describe('runFullRosterValidation — classes', () => {
  it('marks a minimal valid class row as valid', async () => {
    const result = await runFullRosterValidation({ classes: [classRow()], subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('valid');
  });

  it('flags a missing name or level', async () => {
    const result = await runFullRosterValidation({ classes: [classRow({ name: '' })], subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors).toContain('Name is required.');
  });

  it('flags a class name that already exists in the school', async () => {
    const deps = baseDeps({ existingClasses: [{ id: 'c1', name: 'JSS 1A' }] });
    const result = await runFullRosterValidation({ classes: [classRow()], subjects: [], assignments: [] }, deps);
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors[0]).toContain('already exists');
  });

  it('flags a class name duplicated within the same file', async () => {
    const rows = [classRow({ row_number: 2 }), classRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: rows, subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('valid');
    expect(result.classes[1].status).toBe('error');
    expect(result.classes[1].errors[0]).toContain('earlier row');
  });

  it('flags a form teacher email that does not resolve to a teacher', async () => {
    const result = await runFullRosterValidation(
      { classes: [classRow({ form_teacher_email: 'nobody@example.com' })], subjects: [], assignments: [] },
      baseDeps()
    );
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors[0]).toContain('does not match an existing teacher');
  });

  it('accepts a form teacher email that resolves to a teacher', async () => {
    const deps = baseDeps({ lookupTeachersByEmails: async () => new Map([['chidi@example.com', { id: 't1' }]]) });
    const result = await runFullRosterValidation(
      { classes: [classRow({ form_teacher_email: 'chidi@example.com' })], subjects: [], assignments: [] },
      deps
    );
    expect(result.classes[0].status).toBe('valid');
  });
});

describe('runFullRosterValidation — subjects', () => {
  it('flags a subject code that already exists', async () => {
    const deps = baseDeps({ existingSubjects: [{ id: 's1', code: 'MTH' }] });
    const result = await runFullRosterValidation({ classes: [], subjects: [subjectRow()], assignments: [] }, deps);
    expect(result.subjects[0].status).toBe('error');
  });

  it('flags a subject code duplicated within the same file', async () => {
    const rows = [subjectRow({ row_number: 2 }), subjectRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: [], subjects: rows, assignments: [] }, baseDeps());
    expect(result.subjects[1].status).toBe('error');
  });
});

describe('runFullRosterValidation — teacher assignments', () => {
  function fullDeps(): RosterValidationDeps {
    return baseDeps({
      existingClasses: [{ id: 'c1', name: 'JSS 1A' }],
      existingSubjects: [{ id: 's1', code: 'MTH' }],
      lookupTeachersByEmails: async () => new Map([['teacher@example.com', { id: 't1' }]]),
    });
  }

  it('marks a fully-resolvable assignment as valid and resolves all three ids', async () => {
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, fullDeps());
    expect(result.assignments[0].status).toBe('valid');
    expect(result.assignments[0]).toMatchObject({
      resolved_teacher_id: 't1',
      resolved_class_id: 'c1',
      resolved_subject_id: 's1',
    });
  });

  it('flags an unresolvable teacher/class/subject independently', async () => {
    const deps = fullDeps();
    const result = await runFullRosterValidation(
      { classes: [], subjects: [], assignments: [assignmentRow({ teacher_email: 'nobody@example.com', class_name: 'Nope', subject_code: 'ZZZ' })] },
      deps
    );
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors).toHaveLength(3);
  });

  it('flags every assignment row when there is no active term', async () => {
    const deps = fullDeps();
    deps.activeTerm = null;
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, deps);
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors[0]).toContain('No active term');
  });

  it('flags a duplicate teacher/class/subject combination already in the DB', async () => {
    const deps = fullDeps();
    deps.findDuplicateAssignment = async () => true;
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, deps);
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors[0]).toContain('already assigned');
  });

  it('flags a duplicate teacher/class/subject combination within the same file', async () => {
    const deps = fullDeps();
    const rows = [assignmentRow({ row_number: 2 }), assignmentRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: rows }, deps);
    expect(result.assignments[0].status).toBe('valid');
    expect(result.assignments[1].status).toBe('error');
    expect(result.assignments[1].errors[0]).toContain('earlier row');
  });
});
