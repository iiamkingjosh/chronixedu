import { Request, Response, NextFunction } from 'express';
import { findSchoolById } from '../db/queries/schools';
import { cache, schoolCacheKey } from '../services/cacheService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Applied at the Express app level for all /api/schools/:schoolId routes.
// Verifies the school exists and is active before any route handler runs.
// Super admins bypass so they can manage suspended schools.
// Stores the school on res.locals.school so handlers can reuse it without a
// second query (the result is also written into the shared in-memory cache so
// cache.wrap calls in route handlers get a cache hit on the same request).
export async function requireActiveSchool(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // req.path is relative to the /api/schools mount point: /:schoolId/...
  const segments = req.path.split('/');
  const schoolId = segments[1];

  if (!schoolId || !UUID_RE.test(schoolId)) {
    // No schoolId in path (e.g. POST /api/schools to create one) — skip.
    next();
    return;
  }

  // Super admins can always reach suspended or non-existent schools.
  if (req.user?.role === 'super_admin') {
    next();
    return;
  }

  try {
    const cacheKey = schoolCacheKey(schoolId, 'data');
    const school = await cache.wrap(cacheKey, cache.TTL.SCHOOL, () => findSchoolById(schoolId));

    if (!school) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      return;
    }

    if (!school.is_active) {
      res.status(403).json({ success: false, error: { code: 'SCHOOL_SUSPENDED', message: 'This school has been suspended' } });
      return;
    }

    res.locals.school = school;
    next();
  } catch (err) {
    next(err);
  }
}
