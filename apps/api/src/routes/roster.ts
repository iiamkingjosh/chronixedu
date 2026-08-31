import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  findClassByName, insertClass, updateClass, listClasses,
  findClassById, classHasReferences, deleteClass,
  findSubjectByCode, insertSubject, updateSubject, listActiveSubjects,
  findSubjectById, subjectHasReferences, deleteSubject,
  getActiveTerm,
  findDuplicateAssignment, insertTeacherAssignment, listTeacherAssignments,
  findAssignmentById, scoresExistForAssignment, deleteTeacherAssignment,
  findTeachersByEmails, listClassNamesAndIds, listSubjectCodesAndIds,
} from '../db/queries/roster';
import { findUserById } from '../db/queries/users';
import { cache } from '../services/cacheService';
import { parseRosterBulkImportFile, RosterBulkImportParseError } from '../services/rosterBulkImportParser';
import { runFullRosterValidation } from '../services/rosterBulkImportValidation';
import { generateRosterBulkImportResultsFile, type CreatedClassRecord, type CreatedSubjectRecord, type CreatedAssignmentRecord } from '../services/rosterBulkImportResults';
import { logger } from '../config/logger';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const classSchema = z.object({
  name:            z.string().min(1).max(255),
  level:           z.string().min(1).max(100),
  stream:          z.string().max(100).optional(),
  form_teacher_id: z.string().uuid().nullable().optional(),
});

// ── Validate that form_teacher_id (if provided) is a teacher in this school ─────

async function validateFormTeacher(schoolId: string, formTeacherId: string | null | undefined): Promise<string | null> {
  if (!formTeacherId) return null;
  const user = await findUserById(formTeacherId, schoolId);
  if (!user || user.role !== 'teacher') {
    return 'form_teacher_id must reference a teacher in this school';
  }
  return null;
}

const subjectSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(20),
});

const assignmentSchema = z.object({
  teacher_id: z.string().uuid(),
  class_id:   z.string().uuid(),
  subject_id: z.string().uuid(),
});

// ── Middleware: super_admin or any authenticated member of the school ───────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if (user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

// ── POST /:schoolId/classes ────────────────────────────────────────────────────

router.post(
  '/:schoolId/classes',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { name, level, stream, form_teacher_id } = parsed.data;

      const formTeacherError = await validateFormTeacher(req.params.schoolId, form_teacher_id);
      if (formTeacherError) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FORM_TEACHER', message: formTeacherError } });
      }

      const existing = await findClassByName(req.params.schoolId, name);
      if (existing) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_CLASS', message: `A class named "${name}" already exists in this school` } });
      }

      const cls = await insertClass(req.params.schoolId, name, level, stream ?? null, form_teacher_id ?? null);
      cache.del(`roster:${req.params.schoolId}:classes`);
      return res.status(201).json({ success: true, data: cls });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/classes ─────────────────────────────────────────────────────

router.get(
  '/:schoolId/classes',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `roster:${req.params.schoolId}:classes`;
      const classes = await cache.wrap(key, cache.TTL.ROSTER, () => listClasses(req.params.schoolId));
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({ success: true, data: classes });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/classes/:classId ──────────────────────────────────────────

router.patch(
  '/:schoolId/classes/:classId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findClassById(req.params.classId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const { name, level, stream, form_teacher_id } = parsed.data;

      const formTeacherError = await validateFormTeacher(req.params.schoolId, form_teacher_id);
      if (formTeacherError) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FORM_TEACHER', message: formTeacherError } });
      }

      const duplicate = await findClassByName(req.params.schoolId, name);
      if (duplicate && duplicate.id !== existing.id) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_CLASS', message: `A class named "${name}" already exists in this school` } });
      }

      const cls = await updateClass(req.params.classId, req.params.schoolId, {
        name, level, stream: stream ?? null, form_teacher_id: form_teacher_id ?? null,
      });
      cache.del(`roster:${req.params.schoolId}:classes`);
      return res.json({ success: true, data: cls });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/classes/:classId ────────────────────────────────────────

router.delete(
  '/:schoolId/classes/:classId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cls = await findClassById(req.params.classId, req.params.schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const hasRefs = await classHasReferences(req.params.classId, req.params.schoolId);
      if (hasRefs) {
        return res.status(409).json({
          success: false,
          error: { code: 'CLASS_HAS_REFERENCES', message: 'Cannot delete class: students or teacher assignments exist for this class' },
        });
      }

      await deleteClass(req.params.classId, req.params.schoolId);
      cache.del(`roster:${req.params.schoolId}:classes`);
      return res.json({ success: true, data: { message: 'Class deleted' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/subjects ───────────────────────────────────────────────────

router.post(
  '/:schoolId/subjects',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = subjectSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { name, code } = parsed.data;
      const upperCode = code.toUpperCase();

      const existing = await findSubjectByCode(req.params.schoolId, upperCode);
      if (existing) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_SUBJECT_CODE', message: `Subject code "${upperCode}" already exists in this school` } });
      }

      const subject = await insertSubject(req.params.schoolId, name, upperCode);
      cache.del(`roster:${req.params.schoolId}:subjects`);
      return res.status(201).json({ success: true, data: subject });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/subjects ────────────────────────────────────────────────────

router.get(
  '/:schoolId/subjects',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `roster:${req.params.schoolId}:subjects`;
      const subjects = await cache.wrap(key, cache.TTL.ROSTER, () => listActiveSubjects(req.params.schoolId));
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({ success: true, data: subjects });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/subjects/:subjectId ───────────────────────────────────────

router.patch(
  '/:schoolId/subjects/:subjectId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = subjectSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findSubjectById(req.params.subjectId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Subject not found' } });
      }

      const { name, code } = parsed.data;
      const upperCode = code.toUpperCase();

      const duplicate = await findSubjectByCode(req.params.schoolId, upperCode);
      if (duplicate && duplicate.id !== existing.id) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_SUBJECT_CODE', message: `Subject code "${upperCode}" already exists in this school` } });
      }

      const subject = await updateSubject(req.params.subjectId, req.params.schoolId, { name, code: upperCode });
      cache.del(`roster:${req.params.schoolId}:subjects`);
      return res.json({ success: true, data: subject });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/subjects/:subjectId ─────────────────────────────────────

router.delete(
  '/:schoolId/subjects/:subjectId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subject = await findSubjectById(req.params.subjectId, req.params.schoolId);
      if (!subject) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Subject not found' } });
      }

      const hasRefs = await subjectHasReferences(req.params.subjectId, req.params.schoolId);
      if (hasRefs) {
        return res.status(409).json({
          success: false,
          error: { code: 'SUBJECT_HAS_REFERENCES', message: 'Cannot delete subject: teacher assignments, scores, or assessment configs reference this subject' },
        });
      }

      await deleteSubject(req.params.subjectId, req.params.schoolId);
      cache.del(`roster:${req.params.schoolId}:subjects`);
      return res.json({ success: true, data: { message: 'Subject deleted' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/teacher-assignments ───────────────────────────────────────

router.post(
  '/:schoolId/teacher-assignments',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = assignmentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { teacher_id, class_id, subject_id } = parsed.data;

      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school. Activate a session and term first.' } });
      }

      const isDuplicate = await findDuplicateAssignment(teacher_id, class_id, subject_id, term.id);
      if (isDuplicate) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_ASSIGNMENT', message: 'This teacher is already assigned to this class and subject for the current term' } });
      }

      const teacher = await findUserById(teacher_id, req.params.schoolId);
      if (!teacher || teacher.role !== 'teacher') {
        return res.status(404).json({ success: false, error: { code: 'TEACHER_NOT_FOUND', message: 'Teacher not found in this school' } });
      }

      const assignment = await insertTeacherAssignment(teacher_id, class_id, subject_id, term.id, req.params.schoolId);
      cache.del(`roster:${req.params.schoolId}:assignments:${teacher_id}`);
      return res.status(201).json({ success: true, data: assignment });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/teachers/:teacherId/assignments ─────────────────────────────

router.get(
  '/:schoolId/teachers/:teacherId/assignments',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `roster:${req.params.schoolId}:assignments:${req.params.teacherId}`;
      const result = await cache.wrap(key, cache.TTL.ROSTER, async () => {
        const term = await getActiveTerm(req.params.schoolId);
        if (!term) return { teacher_mode: 'subject', assignments: [] };
        return listTeacherAssignments(req.params.teacherId, req.params.schoolId, term.id);
      });
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({ success: true, data: result });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/teacher-assignments/:id ──────────────────────────────────

router.delete(
  '/:schoolId/teacher-assignments/:id',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assignment = await findAssignmentById(req.params.id, req.params.schoolId);
      if (!assignment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
      }

      const hasScores = await scoresExistForAssignment(assignment.subject_id, assignment.class_id, assignment.term_id);
      if (hasScores) {
        return res.status(409).json({ success: false, error: { code: 'SCORES_EXIST', message: 'Cannot remove assignment: scores have been entered for this teacher, subject, and class in the current term' } });
      }

      await deleteTeacherAssignment(req.params.id, req.params.schoolId);
      cache.del(`roster:${req.params.schoolId}:assignments:${assignment.teacher_id}`);
      return res.json({ success: true, data: { message: 'Assignment removed' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/roster-bulk-import/preview ──────────────────────────────
// Parses and validates a 3-sheet workbook without writing anything — the
// principal confirms via /roster-bulk-import/commit afterward. See
// docs/superpowers/specs/2026-08-20-roster-bulk-import-design.md for the
// full design rationale, including why Teacher Assignment rows never
// resolve against same-file Classes/Subjects rows.

const MAX_ROSTER_BULK_IMPORT_ROWS = 300;
const rosterBulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/roster-bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  rosterBulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      // Verify actual file content via magic bytes before trusting the client-supplied
      // filename extension — mirrors the same check on the Students bulk import route.
      const detected = await fileTypeFromBuffer(file.buffer);
      const allowedXlsxMimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'];
      if (!detected || !allowedXlsxMimes.includes(detected.mime)) {
        return res.status(400).json({
          success: false,
          error: { code: 'PARSE_ERROR', message: 'This file could not be read as an Excel spreadsheet.' },
        });
      }

      let parsed;
      try {
        parsed = await parseRosterBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof RosterBulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx file.' } });
      }

      const totalRows = parsed.classes.length + parsed.subjects.length + parsed.assignments.length;
      if (totalRows === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No rows were found in any sheet of this file.' } });
      }
      if (totalRows > MAX_ROSTER_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${totalRows} rows across all sheets — the maximum per import is ${MAX_ROSTER_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const [existingClasses, existingSubjects, activeTerm] = await Promise.all([
        listClassNamesAndIds(req.params.schoolId),
        listSubjectCodesAndIds(req.params.schoolId),
        getActiveTerm(req.params.schoolId),
      ]);

      const results = await runFullRosterValidation(parsed, {
        existingClasses,
        existingSubjects,
        activeTerm,
        lookupTeachersByEmails: (emails) => findTeachersByEmails(req.params.schoolId, emails),
        findDuplicateAssignment: (teacherId, classId, subjectId, termId) => findDuplicateAssignment(teacherId, classId, subjectId, termId),
      });

      const summarize = (rows: { status: 'valid' | 'error' }[]) => ({
        total: rows.length,
        valid: rows.filter(r => r.status === 'valid').length,
        invalid: rows.filter(r => r.status === 'error').length,
      });

      return res.json({
        success: true,
        data: {
          classes: { rows: results.classes, summary: summarize(results.classes) },
          subjects: { rows: results.subjects, summary: summarize(results.subjects) },
          assignments: { rows: results.assignments, summary: summarize(results.assignments) },
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/roster-bulk-import/commit ───────────────────────────────
// Fetches ONE fresh snapshot of existing classes/subjects/active-term before
// any inserts happen, and validates every sheet against that single
// snapshot — this is what guarantees a Teacher Assignment row never
// resolves against a class/subject this same commit just created, per the
// design decision. Commits in order: Classes, then Subjects, then
// Assignments, one insert per row, wrapped in its own try/catch.

const rosterBulkImportRowSchema = z.object({
  row_number: z.number(),
  status: z.enum(['valid', 'error']),
  errors: z.array(z.string()),
});

const rosterBulkImportCommitSchema = z.object({
  classes: z.array(rosterBulkImportRowSchema.extend({
    class: z.object({
      row_number: z.number(),
      name: z.string(),
      level: z.string(),
      stream: z.string().nullable(),
      form_teacher_email: z.string().nullable(),
    }),
    resolved_form_teacher_id: z.string().nullable(),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
  subjects: z.array(rosterBulkImportRowSchema.extend({
    subject: z.object({
      row_number: z.number(),
      name: z.string(),
      code: z.string(),
    }),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
  assignments: z.array(rosterBulkImportRowSchema.extend({
    assignment: z.object({
      row_number: z.number(),
      teacher_email: z.string(),
      class_name: z.string(),
      subject_code: z.string(),
    }),
    resolved_teacher_id: z.string().nullable(),
    resolved_class_id: z.string().nullable(),
    resolved_subject_id: z.string().nullable(),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/roster-bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = rosterBulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedClasses = parsed.data.classes.map(r => r.class);
      const submittedSubjects = parsed.data.subjects.map(r => r.subject);
      const submittedAssignments = parsed.data.assignments.map(r => r.assignment);

      // One snapshot, fetched once, before any insert in this request.
      const [existingClasses, existingSubjects, activeTerm] = await Promise.all([
        listClassNamesAndIds(req.params.schoolId),
        listSubjectCodesAndIds(req.params.schoolId),
        getActiveTerm(req.params.schoolId),
      ]);

      const revalidated = await runFullRosterValidation(
        { classes: submittedClasses, subjects: submittedSubjects, assignments: submittedAssignments },
        {
          existingClasses,
          existingSubjects,
          activeTerm,
          lookupTeachersByEmails: (emails) => findTeachersByEmails(req.params.schoolId, emails),
          findDuplicateAssignment: (teacherId, classId, subjectId, termId) => findDuplicateAssignment(teacherId, classId, subjectId, termId),
        }
      );

      // ── Classes ──
      const classResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdClasses: CreatedClassRecord[] = [];
      for (const row of revalidated.classes) {
        if (row.status === 'error') {
          classResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }
        try {
          await insertClass(req.params.schoolId, row.class.name, row.class.level, row.class.stream, row.resolved_form_teacher_id);
          classResults.push({ row_number: row.row_number, status: 'created' });
          createdClasses.push({ row_number: row.row_number, name: row.class.name, level: row.class.level });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'A class with this name already exists.'
            : 'Failed to create this class.';
          classResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      if (createdClasses.length > 0) cache.del(`roster:${req.params.schoolId}:classes`);

      // ── Subjects ──
      const subjectResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdSubjects: CreatedSubjectRecord[] = [];
      for (const row of revalidated.subjects) {
        if (row.status === 'error') {
          subjectResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }
        try {
          await insertSubject(req.params.schoolId, row.subject.name, row.subject.code);
          subjectResults.push({ row_number: row.row_number, status: 'created' });
          createdSubjects.push({ row_number: row.row_number, name: row.subject.name, code: row.subject.code });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'A subject with this code already exists.'
            : 'Failed to create this subject.';
          subjectResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      if (createdSubjects.length > 0) cache.del(`roster:${req.params.schoolId}:subjects`);

      // ── Teacher Assignments ──
      const assignmentResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdAssignments: CreatedAssignmentRecord[] = [];
      const teachersToInvalidate = new Set<string>();
      for (const row of revalidated.assignments) {
        if (row.status === 'error' || !row.resolved_teacher_id || !row.resolved_class_id || !row.resolved_subject_id || !activeTerm) {
          assignmentResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') || 'Could not be created.' });
          continue;
        }
        try {
          await insertTeacherAssignment(row.resolved_teacher_id, row.resolved_class_id, row.resolved_subject_id, activeTerm.id, req.params.schoolId);
          assignmentResults.push({ row_number: row.row_number, status: 'created' });
          createdAssignments.push({
            row_number: row.row_number,
            teacher_email: row.assignment.teacher_email,
            class_name: row.assignment.class_name,
            subject_code: row.assignment.subject_code,
          });
          teachersToInvalidate.add(row.resolved_teacher_id);
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'This assignment already exists.'
            : 'Failed to create this assignment.';
          assignmentResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      teachersToInvalidate.forEach(teacherId => cache.del(`roster:${req.params.schoolId}:assignments:${teacherId}`));

      // Never let a results-file failure turn an already-successful commit into
      // an apparent 500 — every class/subject/assignment has already been
      // written by this point, so a principal seeing an error here would
      // reasonably re-upload the file, risking duplicate records. Degrade
      // gracefully.
      let resultsFile: Buffer | null = null;
      try {
        resultsFile = await generateRosterBulkImportResultsFile(createdClasses, createdSubjects, createdAssignments);
      } catch (err) {
        logger.error('roster_bulk_import_results_file_failed', { schoolId: req.params.schoolId, err });
      }

      return res.json({
        success: true,
        data: {
          classes: { created: createdClasses.length, failed: classResults.filter(r => r.status === 'failed').length, results: classResults },
          subjects: { created: createdSubjects.length, failed: subjectResults.filter(r => r.status === 'failed').length, results: subjectResults },
          assignments: { created: createdAssignments.length, failed: assignmentResults.filter(r => r.status === 'failed').length, results: assignmentResults },
          download_base64: resultsFile ? resultsFile.toString('base64') : null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
