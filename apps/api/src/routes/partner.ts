/**
 * Machine-to-machine endpoints for the Chronix ERP.
 *
 * A separate file rather than a section of `superAdmin.ts` on purpose. That file's every
 * route carries `...guard` — `verifyToken` plus `requireRole('super_admin')` — and mixing
 * an API-key-gated route into it means one future edit that moves a route past the wrong
 * guard, in either direction: a partner route reachable with a human session, or a human
 * route reachable with the shared key. Keeping the two guards in two files makes that
 * mistake require moving a file, not moving a line.
 *
 * Mounted at `/api/partner`, outside `/api/schools` — so it never passes through
 * `detectSupportSession → verifyToken → requirePasswordChanged → requireActiveSchool`,
 * none of which have anything to say about a machine caller.
 *
 * Everything here is aggregate and zero-PII by design: no school names, no student or
 * parent data, no identifiers the ERP could use to address an individual. If a future
 * endpoint here needs to name a school, that is a different conversation about what the
 * ERP is entitled to, not a wider SELECT on this one.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireErpApiKey } from '../middleware/apiKeyAuth';
import { getPlatformRevenue } from '../db/queries/platformRevenue';
import { logger } from '../config/logger';

const router = Router();

// ── GET /api/partner/revenue ───────────────────────────────────────────────────
// Current platform MRR by plan. Same aggregate the super-admin dashboard shows —
// getPlatformRevenue is the single source, so the figure Chronix quotes internally and
// the figure the ERP pulls cannot drift apart.

router.get(
  '/revenue',
  requireErpApiKey,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const revenue = await getPlatformRevenue();
      logger.info('erp_revenue_pulled', { total_mrr: revenue.total_mrr });
      return res.json({
        success: true,
        data: {
          // The ERP is reading a live aggregate, so it needs to know when. Without this
          // a cached or retried response is indistinguishable from a current one.
          as_of: new Date().toISOString(),
          ...revenue,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
