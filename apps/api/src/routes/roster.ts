import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  findClassByName, insertClass, updateClass, listClasses,
  findClassById, classHasReferences, deleteClass,
  findSubjectByCode, insertSubject, updateSubject, listActiveSubjects,
  findSubjectById, subjectHasReferences, deleteSubject,
  getActiveTerm,
  findDuplicateAssignment, insertTeacherAssignment, listTeacherAssignments,
  findAssignmentById, scoresExistForAssignment, deleteTeacherAssignment,
} from '../db/queries/roster';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const classSchema = z.object({
  name:   z.string().min(1).max(255),
  level:  z.string().min(1).max(100),
  stream: z.string().max(100).optional(),
});

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

      const { name, level, stream } = parsed.data;

      const existing = await findClassByName(req.params.schoolId, name);
      if (existing) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_CLASS', message: `A class named "${name}" already exists in this school` } });
      }

      const cls = await insertClass(req.params.schoolId, name, level, stream ?? null);
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
      const classes = await listClasses(req.params.schoolId);
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

      const { name, level, stream } = parsed.data;

      const duplicate = await findClassByName(req.params.schoolId, name);
      if (duplicate && duplicate.id !== existing.id) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_CLASS', message: `A class named "${name}" already exists in this school` } });
      }

      const cls = await updateClass(req.params.classId, req.params.schoolId, { name, level, stream: stream ?? null });
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
      const subjects = await listActiveSubjects(req.params.schoolId);
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

      const assignment = await insertTeacherAssignment(teacher_id, class_id, subject_id, term.id, req.params.schoolId);
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
      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.json({ success: true, data: { teacher_mode: 'subject', assignments: [] } });
      }

      const result = await listTeacherAssignments(req.params.teacherId, req.params.schoolId, term.id);
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
      return res.json({ success: true, data: { message: 'Assignment removed' } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
