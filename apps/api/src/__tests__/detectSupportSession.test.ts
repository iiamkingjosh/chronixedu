/**
 * The support-session token blacklist read (item G, 1 Oct 2026). It was a bare `redis.get` in a
 * silent `catch {}`: with Redis down, a revoked support token was accepted (fail open, by design)
 * and nothing anywhere said the check had been skipped. It now goes through bestEffort, like every
 * request-path Redis read: still fails open, but the failure is logged and raises the Redis alert.
 */
import jwt from 'jsonwebtoken';
import pool from '../db/client';
import { logger } from '../config/logger';
import { detectSupportSession } from '../middleware/detectSupportSession';

const mockRedisGet = jest.fn();
jest.mock('../middleware/rateLimit', () => ({
  ...jest.requireActual('../middleware/rateLimit'), // the real bestEffort
  redis: { get: (...args: unknown[]) => mockRedisGet(...args) },
}));
jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
  resolveSsl: jest.fn(),
}));
const mockQuery = (pool as unknown as { query: jest.Mock }).query;

process.env.JWT_SECRET = 'support-session-test-secret';
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const token = jwt.sign({
  support_session_id: SESSION_ID, is_support_session: true, real_admin_id: 'admin-1',
  impersonated_user_id: 'user-1', impersonated_school_id: 'school-1', impersonated_role: 'principal',
  impersonated_email: 'principal@school.test', impersonated_title: null,
}, process.env.JWT_SECRET);

function run() {
  const req = { headers: { 'x-support-session-id': SESSION_ID, authorization: `Bearer ${token}` } } as never;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return detectSupportSession(req, res as never, next).then(() => ({ res, next }));
}

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [{ id: SESSION_ID, ended_at: null, platform_admin_id: 'admin-1' }] });
  errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
});
afterEach(() => errorSpy.mockRestore());

const blacklistErrors = () => errorSpy.mock.calls.filter(([event]) => event === 'token_blacklist_unavailable');

it('refuses a revoked token while Redis answers (the control: the check does something)', async () => {
  mockRedisGet.mockResolvedValue('1');
  const { res, next } = await run();
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json.mock.calls[0][0].error.code).toBe('TOKEN_REVOKED');
  expect(next).not.toHaveBeenCalled();
});

it('with Redis down, still lets the session through (fail open) and SAYS the check was skipped', async () => {
  mockRedisGet.mockRejectedValue(new Error('Command timed out'));
  const { next } = await run();
  expect(next).toHaveBeenCalledTimes(1);
  expect(blacklistErrors()).toEqual([['token_blacklist_unavailable', { error: 'Command timed out' }]]);
});

it('with Redis healthy and the token not revoked, passes and logs nothing', async () => {
  mockRedisGet.mockResolvedValue(null);
  const { next } = await run();
  expect(next).toHaveBeenCalledTimes(1);
  expect(errorSpy).not.toHaveBeenCalled();
});
