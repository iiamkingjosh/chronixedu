import rateLimit, { Options } from 'express-rate-limit';
import { Request, Response } from 'express';

function rateLimitHandler(_req: Request, res: Response, _next: unknown, options: Options) {
  res.status(options.statusCode).json({
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' },
  });
}

// Agent File Rule S5: 100 req/min general, 5 req/min for auth
export const generalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  handler: rateLimitHandler,
});

export const authRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  handler: rateLimitHandler,
});
