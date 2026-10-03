/**
 * The principal's remark on a student's report card.
 *
 * `reportCardService` has always rendered `principalRemark?.remark_text` and
 * `fetchPrincipalRemark` has always read the table — but nothing in the codebase ever
 * wrote a row. The document parents keep carried a principal's-remark field nobody could
 * fill, beside a form-teacher comment field that works. This is the missing half.
 *
 * Deliberately mirrors routes/classComments.ts: same shape, same active-term handling,
 * same 422 when no term is active. The difference is who may write — a class comment
 * belongs to the form teacher, this belongs to the principal — and that difference is
 * stated with an explicit requireRole at the call site rather than left to the reader to
 * infer from the file (doctrine 1).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { getActiveTerm } from '../db/queries/roster';
import { findStudentById } from '../db/queries/students';
import { fetchPrincipalRemark, upsertPrincipalRemark } from '../db/queries/reportCards';
import { logAudit } from '../db/queries/auditLog';

const router = Router();

const remarkSchema = z.object({
  // Same ceiling as a class comment. Empty is allowed and clears the remark, so a
  // principal can remove one they did not mean to leave.
  remark_text: z.string().max(1000),
});

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

// ── GET /:schoolId/principal-remarks/:studentId ────────────────────────────────

router.get(
  '/:schoolId/principal-remarks/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // principal_remarks carries no school_id and fetchPrincipalRemark is not
      // school-scoped, so the tenancy check happens HERE, on the student (doctrine 3:
      // validate the target, not just the caller).
      const student = await findStudentById(req.params.studentId, req.params.schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found in this school' } });
      }

      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school. Activate a session and term first.' } });
      }

      const remark = await fetchPrincipalRemark(req.params.studentId, term.id);
      return res.json({
        success: true,
        data: { remark_text: remark?.remark_text ?? null, term_id: term.id, term_name: term.name },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PUT /:schoolId/principal-remarks/:studentId ────────────────────────────────

router.put(
  '/:schoolId/principal-remarks/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = remarkSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const student = await findStudentById(req.params.studentId, req.params.schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found in this school' } });
      }

      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school. Activate a session and term first.' } });
      }

      const previous = await fetchPrincipalRemark(req.params.studentId, term.id);
      await upsertPrincipalRemark(req.params.studentId, term.id, req.user!.user_id, parsed.data.remark_text);

      // Doctrine 9: this lands on a document a parent keeps, so it is a sensitive write.
      // old + new, like scores.
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'PRINCIPAL_REMARK_SAVED',
        entity: 'principal_remarks',
        entityId: req.params.studentId,
        oldValue: { remark_text: previous?.remark_text ?? null },
        newValue: { remark_text: parsed.data.remark_text, term_id: term.id },
      });

      return res.json({ success: true, data: { message: 'Remark saved' } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
