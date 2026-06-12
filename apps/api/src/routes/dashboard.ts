import { Router, Request, Response, NextFunction } from 'express';
import NodeCache from 'node-cache';
import { verifyToken, requireRole } from '../middleware/auth';
import { getActiveTerm, listClasses } from '../db/queries/roster';
import { getApprovalDashboard } from '../db/queries/results';
import { getDashboardStats, getUserName, getTeacherActivity } from '../db/queries/dashboard';
import { getStudentsAtRisk } from '../services/resultEngine';

const router = Router();

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  const data = await fn();
  cache.set(key, data);
  return data;
}

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

const guard = [verifyToken, requireSchoolAccess, requireRole('principal', 'super_admin')];

// ── (1) GET /overview ─────────────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/overview',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      // Stats are cached; greeting is per-user so always fresh
      const stats = await withCache(`${schoolId}:overview`, () => getDashboardStats(schoolId));

      const user    = req.user!;
      const nameRow = await getUserName(user.user_id);
      const name    = user.title && nameRow
        ? `${user.title} ${nameRow.last_name}`
        : nameRow
          ? `${nameRow.first_name} ${nameRow.last_name}`
          : user.email ?? '';

      const hour = new Date().getHours(); // server local time, 0–23
      const salutation =
        hour >=  5 && hour < 12 ? 'Good morning'   :
        hour >= 12 && hour < 17 ? 'Good afternoon'  :
        hour >= 17 && hour < 21 ? 'Good evening'    :
                                   'Good night';

      const greeting = `${salutation}, ${name}`;

      return res.json({
        success: true,
        data: {
          greeting,
          total_students:  stats.total_students,
          total_teachers:  stats.total_teachers,
          total_classes:   stats.total_classes,
          current_session: stats.session_name,
          current_term:    stats.term_name,
          school_average:  stats.school_average,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (2) GET /result-status ────────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/result-status',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      const data = await withCache(`${schoolId}:result-status`, async () => {
        const term = await getActiveTerm(schoolId);
        if (!term) return [];
        return getApprovalDashboard(schoolId, term.id);
      });

      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (3) GET /students-at-risk ─────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/students-at-risk',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      const data = await withCache(`${schoolId}:students-at-risk`, async () => {
        const term = await getActiveTerm(schoolId);
        if (!term) return [];
        return getStudentsAtRisk(term.id, schoolId);
      });

      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (4) GET /teacher-activity ─────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/teacher-activity',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      const data = await withCache(`${schoolId}:teacher-activity`, async () => {
        const term = await getActiveTerm(schoolId);
        if (!term) return [];
        return getTeacherActivity(schoolId, term.id);
      });

      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (5) GET /class-selector ───────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/class-selector',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      const data = await withCache(`${schoolId}:class-selector`, () => listClasses(schoolId));

      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
