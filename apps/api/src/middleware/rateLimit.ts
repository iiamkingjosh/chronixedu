import rateLimit, { Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { Request, Response } from 'express';

function rateLimitHandler(_req: Request, res: Response, _next: unknown, options: Options) {
  res.status(options.statusCode).json({
    success: false,
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' },
  });
}

// Connect to Redis when REDIS_URL is set; fall back to in-memory store in dev.
// NOTE: MemoryStore fallback is per-process. In a multi-replica deployment each instance
// maintains independent counters. The per-email Redis lockout in the login route is the
// stronger control and remains effective. If horizontal scaling is enabled, ensure
// REDIS_URL is always set so counters are shared across all instances.
const redisClient = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

/** Shared Redis client — null in dev when REDIS_URL is unset. Used by auth lockout and rate limiting. */
export const redis = redisClient;

if (redisClient) {
  redisClient.on('error', (err) => {
    console.error('Redis rate-limit client error:', err);
  });
}

function makeStore() {
  if (!redisClient) return undefined; // express-rate-limit defaults to MemoryStore
  return new RedisStore({
    // ioredis.call returns Promise<unknown>; rate-limit-redis expects Promise<RedisReply>.
    // The actual runtime value is always a valid RedisReply — the cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => (redisClient as any).call(...args),
  });
}

// Agent File Rule S5: 100 req/min general, 5 req/min for auth
export const generalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  store: makeStore(),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const authRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  store: makeStore(),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
