import { Request, Response, NextFunction } from 'express';
import { planIncludesFeature, PlanFeature } from '../services/planFeatures';

export function requireFeature(feature: PlanFeature) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const school = res.locals.school as { subscription_tier?: string | null; subscription_status?: string | null } | undefined;
    if (!planIncludesFeature(school?.subscription_tier, feature, school?.subscription_status)) {
      res.status(403).json({
        success: false,
        error: { code: 'FEATURE_NOT_IN_PLAN', message: "This feature isn't available on your school's current plan" },
      });
      return;
    }
    next();
  };
}
