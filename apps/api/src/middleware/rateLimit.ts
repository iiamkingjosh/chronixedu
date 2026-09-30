import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from './clientIp';
import { RedisStore, SendCommandFn } from 'rate-limit-redis';
import Redis from 'ioredis';
import { Express, Request, Response } from 'express';

// Every limiter keys on the client, not on req.ip — see clientIp.ts. ipKeyGenerator folds
// an IPv6 address to its /56 so one client cannot rotate through a whole allocation.
const keyGenerator = (req: Request) => ipKeyGenerator(clientIp(req) ?? '');

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
/** Relative to the /api/auth mount. Trailing slashes are the same route to Express. */
function isLogin(req: Request): boolean {
  return req.method === 'POST' && req.path.replace(/\/+$/, '') === '/login';
}

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
    keyGenerator,
    store: store('rl:general:'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  // Every other /api/auth route: forgot-password, reset, change-password. These keep
  // counting successes — forgot-password answers 200 whether or not the account exists
  // (so as not to reveal which emails are registered) and it sends email, so a limiter
  // that counted only failures would never count it at all.
  const auth = rateLimit({
    windowMs: 60_000,
    max: 5,
    keyGenerator,
    store: store('rl:auth:'),
    skip: (req) => isLogin(req),
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  // POST /login counts GUESSES, not logins: a response under 400 is taken back off the
  // count once it is sent. Counting successes refused a principal's sixth correct
  // password in 35 seconds in production — and six teachers behind one staff-room router
  // are the same event. Guessing one account is stopped by the per-email lockout in
  // routes/auth.ts (5 failures, 15 minutes); this is the per-address backstop. Rule S5
  // as amended: CLAUDE.md, "Spec drift".
  const login = rateLimit({
    windowMs: 60_000,
    max: 5,
    skipSuccessfulRequests: true,
    keyGenerator,
    store: store('rl:login:'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  return { general, auth, login };
}

// ioredis.call returns Promise<unknown>; rate-limit-redis expects Promise<RedisReply>.
// The actual runtime value is always a valid RedisReply — the cast is safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const limiters = createRateLimiters(redisClient ? (...args: string[]) => (redisClient as any).call(...args) : undefined);

export const generalRateLimiter = limiters.general;
export const authRateLimiter = limiters.auth;

/**
 * Mount the limiters, in order, before any route. index.ts and rateLimitRedis.test.ts
 * both call this, so the test exercises the production mounting rather than a copy of it.
 */
export function mountRateLimiters(app: Express, l: ReturnType<typeof createRateLimiters> = limiters) {
  app.use('/api/auth', (req, res, next) => (isLogin(req) ? l.login(req, res, next) : next()));
  app.use('/api/auth', l.auth);
  app.use('/api', l.general);
}
