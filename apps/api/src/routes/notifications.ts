import { Router, Request, Response, NextFunction } from 'express';
import { verifyToken } from '../middleware/auth';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../db/queries/notifications';

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

// ── GET /:schoolId/notifications — recent notifications + unread count ─────────

router.get(
  '/:schoolId/notifications',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
      const { notifications, unread_count } = await listNotifications(req.user!.user_id, limit);
      return res.json({ success: true, data: { notifications, unread_count } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/notifications/:id/read — mark one notification as read ────

router.patch(
  '/:schoolId/notifications/:id/read',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await markNotificationRead(req.params.id, req.user!.user_id);
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/notifications/read-all — mark all as read ─────────────────

router.patch(
  '/:schoolId/notifications/read-all',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await markAllNotificationsRead(req.user!.user_id);
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
