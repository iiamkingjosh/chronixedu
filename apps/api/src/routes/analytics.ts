import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { findSchoolTerm } from '../db/queries/assessmentConfig';
import { verifyToken } from '../middleware/auth';
import { requireCapability } from '../middleware/requireCapability';
import { requireFeature } from '../middleware/requireFeature';
import { getActiveTerm } from '../db/queries/roster';
import { getLatestSnapshot, getPreviousSnapshot, AnalyticsSnapshotRow } from '../db/queries/analytics';
import { generateSnapshot } from '../services/analyticsService';

const router = Router();

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
  verifyToken,
  requireCapability('school.overview'),
  requireFeature('analytics'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      // A term named by the caller must be this school's (doctrine 3): it was used as given, so another
      // school's term made a snapshot here under it, and a malformed id was a 500 (audit, 8 Oct 2026).
      const asked = req.query.term_id as string | undefined;
      if (asked !== undefined) {
        if (!z.string().uuid().safeParse(asked).success) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'term_id must be a term id' } });
        }
        if (!(await findSchoolTerm(asked, schoolId))) {
          return res.status(404).json({ success: false, error: { code: 'TERM_NOT_FOUND', message: 'Term not found in this school' } });
        }
      }
      const termId = asked ?? (await getActiveTerm(schoolId))?.id;

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
