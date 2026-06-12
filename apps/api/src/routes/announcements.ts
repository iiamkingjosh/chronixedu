import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { createNotificationsBulk } from '../db/queries/notifications';
import { sendEmail } from '../services/emailService';
import { createAnnouncement, listAnnouncementsForRole, getTargetUsers } from '../db/queries/announcements';

const router = Router();

// ── Middleware ─────────────────────────────────────────────────────────────────

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

// ── Schemas ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  target_role: z.enum(['all', 'teacher', 'parent', 'student']).default('all'),
});

// ── POST /:schoolId/announcements — principal only ──────────────────────────────

router.post(
  '/:schoolId/announcements',
  verifyToken,
  requireSchoolAccess,
  requireRole('principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const { title, body, target_role } = parsed.data;

      const announcement = await createAnnouncement({
        school_id: schoolId,
        author_id: req.user!.user_id,
        title,
        body,
        target_role,
      });

      // Fan out in-app notifications + emails to everyone targeted (non-blocking).
      getTargetUsers(schoolId, target_role)
        .then(async targets => {
          await createNotificationsBulk(
            targets.map(t => t.id),
            { type: 'announcement', title: `Announcement: ${title}`, body }
          );
          for (const target of targets) {
            sendEmail(target.email, `Announcement: ${title}`, body).catch(() => {});
          }
        })
        .catch(() => {
          // Non-critical — do not surface notification errors to the caller
        });

      return res.status(201).json({ success: true, data: announcement });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/announcements — visible to all authenticated school users ───

router.get(
  '/:schoolId/announcements',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const announcements = await listAnnouncementsForRole(schoolId, req.user!.role!);
      return res.json({ success: true, data: announcements });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
