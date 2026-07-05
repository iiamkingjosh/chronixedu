import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { logger } from '../config/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.user) {
      Sentry.setTag('school_id', req.user.school_id ?? 'none');
      Sentry.setTag('user_role', req.user.role ?? 'anonymous');
      Sentry.setUser({ id: req.user.user_id, email: req.user.email });
    }
    logger.info('http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
}
