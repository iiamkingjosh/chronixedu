/**
 * The notices board — the write path `notices` never had.
 *
 * `GET /:schoolId/student/notices` has read this table since migration 007 and nothing
 * in the codebase ever inserted a row, so the board students see could only ever be
 * empty. Same defect as `principal_remarks`, one notch more visible: a student opens
 * Notices and is told none have been posted, which is true and will stay true.
 *
 * ## Why this exists alongside `announcements`
 *
 * `announcements` (migration 010) is the school-wide broadcast: principal-only,
 * rate-limited, targeted by ROLE, and it fans out notifications and email. It cannot
 * target a class. `notices` can, and that is the only thing it adds — "JSS 2A: bring your
 * maths textbook tomorrow" has no home anywhere else in the product. So this route is
 * deliberately the class-scoped board, not a second announcements, and school-wide
 * notices stay a principal's act here for the same reason they are one there.
 *
 * ## The three decisions, settled before the route was written
 *
 * **Create + delete, not create + expiry.** The student read is already
 * `ORDER BY created_at DESC LIMIT 20`, so the newest notice is never buried — what
 * ordering cannot fix is a notice that is *wrong*, a cancelled event or a changed date,
 * and that needs removal by intent rather than by clock. An `expires_at` would also fail
 * doctrine 8: an unset one is indistinguishable from an author who did not think about
 * it, so the board fills up anyway, and it would put
 * `AND (expires_at IS NULL OR expires_at > now())` on every reader forever — where a bug
 * HIDES notices, failing in the direction nobody reports. Deleting is an act, so it is
 * auditable; expiring is not.
 *
 * **No edit, and therefore no `updated_at`** — stated here because its absence should
 * look deliberate rather than forgotten. A notice is immutable once posted: what a
 * student read is what was posted. Correcting one is delete + repost, which is one
 * intent, two audit rows, and no "this changed under you after you read it" problem to
 * disclose. If editing is ever wanted, it needs `updated_at` in the same migration and
 * the student read needs to surface it.
 *
 * **Teachers may post to their own classes. There is no school-wide notice at all.**
 * Keeping `class_id: null` for principals left the product with two mechanisms for one
 * intent and materially different delivery — an announcement notifies and emails; a
 * school-wide notice appeared on a page and told nobody — with nothing at the moment of
 * posting to tell them apart. Both returned success; only one made "I've told the school"
 * true. Migration 043 makes `class_id` NOT NULL, so this is enforced in the column rather
 * than asserted in this file, and `getNoticesForClass` lost its `class_id IS NULL` branch
 * in the same change: a reader keeping a case nothing can write is the same defect as a
 * writer nothing can read. School-wide has one home, `announcements`, where the fan-out
 * lives; the posting screen links to it rather than explaining its absence.
 *
 * ## The guard that matters
 *
 * Not a teacher reaching another school — that is `requireSchoolAccess`, a 403, ordinary.
 * It is a teacher **on their own school's path** posting to a class they do not teach:
 * the tenant check passes cleanly and only the class check stands between them and every
 * student in that class. Identical in shape to the behaviour-record defect (AUDIT R10-M2),
 * so it is checked the same way — `form_teacher_id` OR an assignment for the current term
 * — with the same `NOT_ASSIGNED` code, and it is covered by the first test in the file.
 *
 * Delete carries the same check as create. A route that guards the write and leaves the
 * un-write open has guarded half the operation (doctrine 7).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { verifyToken, requireRole } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { getActiveTerm, findClassById, listClasses } from '../db/queries/roster';
import { isTeacherAssignedToClass } from '../db/queries/attendance';
import { createNotice, deleteNotice, findNoticeById, listNoticesForStaff } from '../db/queries/notices';
import { logAudit } from '../db/queries/auditLog';

const router = Router();

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

const createSchema = z.object({
  // Required. A notice without a class has no meaning here any more — that intent is an
  // announcement, and it is a different endpoint with different delivery.
  class_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});

/** Same ceiling and the same stripping as announcements — students read this rendered. */
function clean(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
}

function isStaffAdmin(role: string | undefined): boolean {
  return role === 'principal' || role === 'super_admin';
}

/**
 * May this caller address this class?
 *
 * Returns an error shape rather than a boolean so create and delete answer identically —
 * the two must not be able to drift apart, because "I can post it but not remove it" and
 * "I can remove yours but not post mine" are both wrong in ways nobody would notice until
 * a teacher hit them.
 */
async function classAccessError(
  req: Request,
  schoolId: string,
  classId: string
): Promise<{ status: number; code: string; message: string } | null> {
  const role = req.user!.role;

  // Validate the target, not just the caller (doctrine 3): the class must be in THIS
  // school before any question about the caller's relationship to it is meaningful.
  const cls = await findClassById(classId, schoolId);
  if (!cls) {
    return { status: 404, code: 'CLASS_NOT_FOUND', message: 'Class not found in this school' };
  }

  if (isStaffAdmin(role)) return null;

  const userId = req.user!.user_id;
  if (cls.form_teacher_id === userId) return null;

  // Assignments are term-scoped, so this needs the current term. No active term means no
  // assignment can be confirmed — refuse rather than fall through to allowing it.
  const term = await getActiveTerm(schoolId);
  if (term && (await isTeacherAssignedToClass(userId, classId, schoolId, term.id))) return null;

  return {
    status: 403,
    code: 'NOT_ASSIGNED',
    message: 'You are not assigned to this class for the current term',
  };
}

// ── GET /:schoolId/notices — what this member of staff may post to and take down ─

// Returns the postable CLASSES alongside the notices, deliberately. If the screen built
// its class picker from some other endpoint, the form could offer a class the API will
// refuse — the caller would meet the NOT_ASSIGNED guard as a bug report rather than as a
// rule. One source means the picker cannot disagree with the guard.

router.get(
  '/:schoolId/notices',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const classes = await listClasses(schoolId);

      if (isStaffAdmin(req.user!.role)) {
        return res.json({
          success: true,
          data: { notices: await listNoticesForStaff(schoolId, null), classes },
        });
      }

      // A teacher sees exactly the set they may post to: the classes they form-teach or
      // are assigned to this term.
      const userId = req.user!.user_id;
      const term = await getActiveTerm(schoolId);
      const mine = [];
      for (const cls of classes) {
        if (cls.form_teacher_id === userId) { mine.push(cls); continue; }
        if (term && (await isTeacherAssignedToClass(userId, cls.id, schoolId, term.id))) mine.push(cls);
      }
      return res.json({
        success: true,
        data: { notices: await listNoticesForStaff(schoolId, mine.map(c => c.id)), classes: mine },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/notices ────────────────────────────────────────────────────

router.post(
  '/:schoolId/notices',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const { class_id } = parsed.data;

      const denied = await classAccessError(req, schoolId, class_id);
      if (denied) {
        return res.status(denied.status).json({ success: false, error: { code: denied.code, message: denied.message } });
      }

      const title = clean(parsed.data.title);
      const body = clean(parsed.data.body);
      if (!title || !body) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Title and body must contain text' },
        });
      }

      const notice = await createNotice({
        school_id: schoolId,
        class_id,
        title,
        body,
        created_by: req.user!.user_id,
      });

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        schoolId,
        userId: req.user!.user_id,
        actionType: 'NOTICE_CREATED',
        entity: 'notice',
        entityId: notice.id,
        newValue: { class_id, title },
        supportSession: req.supportSession,
      });

      return res.status(201).json({ success: true, data: notice });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/notices/:noticeId ────────────────────────────────────────

router.delete(
  '/:schoolId/notices/:noticeId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, noticeId } = req.params;

      const notice = await findNoticeById(noticeId, schoolId);
      if (!notice) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notice not found in this school' } });
      }

      // The notice's own class decides who may take it down — not the caller's claim
      // about it. Same check as create, same codes.
      const denied = await classAccessError(req, schoolId, notice.class_id);
      if (denied) {
        return res.status(denied.status).json({ success: false, error: { code: denied.code, message: denied.message } });
      }

      await deleteNotice(noticeId, schoolId);

      // The row is gone, so the audit entry is the only remaining record of what it said.
      // It carries the content rather than just the id for that reason.
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        schoolId,
        userId: req.user!.user_id,
        actionType: 'NOTICE_DELETED',
        entity: 'notice',
        entityId: noticeId,
        oldValue: { class_id: notice.class_id, title: notice.title, body: notice.body, created_by: notice.created_by },
        supportSession: req.supportSession,
      });

      return res.json({ success: true, data: { id: noticeId } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
