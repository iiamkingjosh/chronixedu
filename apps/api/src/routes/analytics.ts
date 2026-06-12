import { Router, Request, Response, NextFunction } from 'express';
import { verifyToken, requireRole } from '../middleware/auth';
import { getActiveTerm } from '../db/queries/roster';
import { getLatestSnapshot, getPreviousSnapshot, AnalyticsSnapshotRow } from '../db/queries/analytics';
import { generateSnapshot } from '../services/analyticsService';

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

const guard = [verifyToken, requireSchoolAccess, requireRole('principal', 'super_admin')];

interface TrendItem {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

function trendItem(current: number | null, previous: number | null): TrendItem {
  return {
    current,
    previous,
    delta: current !== null && previous !== null ? Math.round((current - previous) * 100) / 100 : null,
  };
}

function buildTrend(latest: AnalyticsSnapshotRow, previous: AnalyticsSnapshotRow | null) {
  return {
    school_average: trendItem(latest.overall_performance.school_average, previous?.overall_performance.school_average ?? null),
    attendance_percentage: trendItem(latest.attendance_summary.percentage, previous?.attendance_summary.percentage ?? null),
    fee_collected: trendItem(latest.fee_collection.total_collected, previous?.fee_collection.total_collected ?? null),
    fee_outstanding: trendItem(latest.fee_collection.total_outstanding, previous?.fee_collection.total_outstanding ?? null),
  };
}

// ── GET /overview — latest analytics snapshot with trend vs previous snapshot ──

router.get(
  '/:schoolId/analytics/overview',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const termId = (req.query.term_id as string | undefined) ?? (await getActiveTerm(schoolId))?.id;

      if (!termId) {
        return res.json({ success: true, data: null });
      }

      let latest = await getLatestSnapshot(schoolId, termId);
      if (!latest) {
        latest = await generateSnapshot(schoolId, termId);
      }

      const previous = await getPreviousSnapshot(schoolId, termId, latest.snapshot_date);

      return res.json({
        success: true,
        data: { ...latest, trend: buildTrend(latest, previous) },
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
