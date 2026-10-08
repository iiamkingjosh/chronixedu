import { Router, Request, Response, NextFunction } from 'express';
import NodeCache from 'node-cache';
import { verifyToken } from '../middleware/auth';
import { requireCapability } from '../middleware/requireCapability';
import { getActiveTerm, listClasses } from '../db/queries/roster';
import { getApprovalDashboard } from '../db/queries/results';
import { getDashboardStats, getUserName, getTeacherActivity } from '../db/queries/dashboard';
import { getStudentsAtRisk } from '../services/resultEngine';
import { cache as sharedCache, schoolCacheKey } from '../services/cacheService';

const router = Router();

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;
  const data = await fn();
  cache.set(key, data);
  return data;
}

// ── (1) GET /overview ─────────────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/principal/overview',
  verifyToken,
  requireCapability('school.overview'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      // Stats are cached (shared cacheService, so user-creation routes can
      // invalidate it — see cache.del(schoolCacheKey(schoolId, 'dashboard-stats'))
      // in users.ts); greeting is per-user so always fresh.
      const stats = await sharedCache.wrap(
        schoolCacheKey(schoolId, 'dashboard-stats'),
        sharedCache.TTL.STATS,
        () => getDashboardStats(schoolId)
      );

      const user    = req.user!;
      const nameRow = await getUserName(user.user_id);
      const name    = user.title && nameRow
        ? `${user.title} ${nameRow.last_name}`
        : nameRow
          ? `${nameRow.first_name} ${nameRow.last_name}`
          : user.email ?? '';

      // School-local hour (Railway runs UTC; schools run on Lagos time).
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Lagos' })
          .format(new Date())
      );
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
  verifyToken,
  requireCapability('school.overview'),
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
  verifyToken,
  requireCapability('school.overview'),
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
  verifyToken,
  requireCapability('school.overview'),
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
  verifyToken,
  requireCapability('school.overview'),
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
