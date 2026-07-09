import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const message = err instanceof Error ? err.message : 'Internal server error';
  const status = (err as { status?: number })?.status ?? 500;
  logger.error('unhandled_error', {
    message,
    stack: err instanceof Error ? err.stack : undefined,
    method: req.method,
    path: req.originalUrl,
  });
  const isDev = process.env.NODE_ENV === 'development';
  res.status(status).json({
    success: false,
    error: {
      code: (err as { code?: string })?.code ?? 'INTERNAL_ERROR',
      message: isDev ? message : 'An unexpected error occurred',
      ...(isDev && { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
}
