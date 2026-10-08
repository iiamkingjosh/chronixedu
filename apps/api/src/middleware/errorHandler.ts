import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // An upload refused by multer (too large, too many files, an unexpected field) is the person's file,
  // not a fault: it was a 500 that alerted, with "An unexpected error occurred" on screen (audit,
  // 8 Oct 2026). Each upload form states its own size limit.
  if (err instanceof Error && err.name === 'MulterError') {
    const code = (err as { code?: string }).code;
    logger.warn('upload_refused', { code, method: req.method, path: req.originalUrl });
    const tooLarge = code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: tooLarge
        ? { code: 'FILE_TOO_LARGE', message: 'That file is too large to upload. Choose a smaller file.' }
        : { code: 'UPLOAD_REFUSED', message: 'That upload could not be accepted. Choose one file and try again.' },
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  const status = (err as { status?: number })?.status ?? 500;
  logger.error('unhandled_error', {
    message,
    stack: err instanceof Error ? err.stack : undefined,
    method: req.method,
    path: req.originalUrl,
  });
  const isProduction = process.env.NODE_ENV === 'production';
  const isDev = process.env.NODE_ENV === 'development';
  res.status(status).json({
    success: false,
    error: {
      code: (err as { code?: string })?.code ?? 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : message,
      ...(isDev && { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
}
