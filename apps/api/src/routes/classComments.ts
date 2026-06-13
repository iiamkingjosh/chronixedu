import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken } from '../middleware/auth';
import { getActiveTerm } from '../db/queries/roster';
import {
  findClassByFormTeacher,
  listClassStudentsForComments,
  findStudentClassForTerm,
  upsertClassTeacherComment,
} from '../db/queries/classComments';

const router = Router();

const commentSchema = z.object({
  comment_text: z.string().max(1000),
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

// ── GET /:schoolId/class-comments ──────────────────────────────────────────────

router.get(
  '/:schoolId/class-comments',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school. Activate a session and term first.' } });
      }

      const cls = await findClassByFormTeacher(req.user!.user_id, req.params.schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FORM_TEACHER', message: 'You are not assigned as a form teacher for any class.' } });
      }

      const students = await listClassStudentsForComments(cls.id, term.id, term.session_id);

      return res.json({
        success: true,
        data: {
          class: cls,
          term: { id: term.id, name: term.name },
          students: students.map(s => ({
            student_id:   s.student_id,
            full_name:    `${s.first_name} ${s.last_name}`,
            admission_no: s.admission_no,
            comment_text: s.comment_text,
          })),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PUT /:schoolId/class-comments/:studentId ───────────────────────────────────

router.put(
  '/:schoolId/class-comments/:studentId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = commentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school. Activate a session and term first.' } });
      }

      const enrollment = await findStudentClassForTerm(req.params.studentId, term.session_id);
      if (!enrollment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student is not enrolled in a class for the active term' } });
      }

      const cls = await findClassByFormTeacher(req.user!.user_id, req.params.schoolId);
      const isFormTeacher = cls?.id === enrollment.class_id;
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'principal';
      if (!isFormTeacher && !isAdmin) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the class\'s form teacher can leave this comment' } });
      }

      await upsertClassTeacherComment(req.params.studentId, term.id, req.user!.user_id, parsed.data.comment_text);
      return res.json({ success: true, data: { message: 'Comment saved' } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
