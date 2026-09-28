import rateLimit, { Options } from 'express-rate-limit';
import { RedisStore, SendCommandFn } from 'rate-limit-redis';
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

/**
 * Build both limiters. `sendCommand` is the Redis transport; omitted, each limiter falls
 * back to its own in-process MemoryStore. Exported so tests can drive the Redis path —
 * production's only path — with a fake transport.
 */
export function createRateLimiters(sendCommand?: SendCommandFn) {
  // Each limiter needs its OWN prefix. Both key by client IP, and rate-limit-redis
  // defaults every store to 'rl:', so with the default they shared one counter: every
  // request anywhere under /api spent the 5-per-minute login allowance, and each login
  // spent it twice. A principal who logged in, used the dashboard and logged in again
  // was refused before their password was checked. See rateLimitRedis.test.ts.
  const store = (prefix: string) => (sendCommand ? new RedisStore({ sendCommand, prefix }) : undefined);

  // Agent File Rule S5: 100 req/min general, 5 req/min for auth
  const general = rateLimit({
    windowMs: 60_000,
    max: 100,
    store: store('rl:general:'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const auth = rateLimit({
    windowMs: 60_000,
    max: 5,
    store: store('rl:auth:'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  return { general, auth };
}

// ioredis.call returns Promise<unknown>; rate-limit-redis expects Promise<RedisReply>.
// The actual runtime value is always a valid RedisReply — the cast is safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const limiters = createRateLimiters(redisClient ? (...args: string[]) => (redisClient as any).call(...args) : undefined);

export const generalRateLimiter = limiters.general;
export const authRateLimiter = limiters.auth;
