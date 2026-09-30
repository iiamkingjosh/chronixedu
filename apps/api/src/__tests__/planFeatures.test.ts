/**
 * The plan → feature map (services/planFeatures.ts).
 *
 * The rule it replaced was one string comparison: false for 'basic', true for everything
 * else. With Basic removed that made every feature check decoration, and it had been
 * failing open in silence for trial all along. The ratchet below is the part that matters:
 * a plan that exists in the enum but not the map — or the reverse — fails here, and the
 * `Record<Plan, …>` type fails the build before this even runs.
 */
import fs from 'fs';
import path from 'path';
import pool from '../db/client';
import { logger } from '../config/logger';
import { PLANS, PLAN_FEATURES, PAID_PLANS, planEnum, planIncludesFeature, schoolAllowsFeature } from '../services/planFeatures';

jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../config/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;
const mockLogger = logger as jest.Mocked<typeof logger>;
beforeEach(() => jest.clearAllMocks());

const FEATURES = ['sms', 'online_payments', 'analytics'] as const;

describe('the ratchet: one plan list, and every plan decided', () => {
  it('the zod enum, the list and the feature map name exactly the same plans', () => {
    expect([...planEnum.options].sort()).toEqual([...PLANS].sort());
    expect(Object.keys(PLAN_FEATURES).sort()).toEqual([...PLANS].sort());
  });

  it('is trial, premium and enterprise — Basic is gone', () => {
    expect([...PLANS]).toEqual(['trial', 'premium', 'enterprise']);
    expect([...PAID_PLANS]).toEqual(['premium', 'enterprise']);
  });

  it('routes/superAdmin.ts spells no plan list of its own — every plan enum is planEnum', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/superAdmin.ts'), 'utf8');
    expect(src).not.toMatch(/z\.enum\(\s*\[\s*'trial'/);
    expect(src.match(/planEnum/g)!.length).toBeGreaterThanOrEqual(4);
  });
});

describe('planIncludesFeature', () => {
  for (const plan of PLANS) {
    it.each(FEATURES)(`${plan} has %s`, (feature) => {
      expect(planIncludesFeature(plan, feature, 'active')).toBe(true);
    });
  }

  it.each(FEATURES)('a read-only subscription has no %s, whatever its plan', (feature) => {
    for (const plan of PLANS) expect(planIncludesFeature(plan, feature, 'read_only')).toBe(false);
  });

  it.each(['trial', 'grace', 'active', null, undefined])('status %s leaves the plan decision alone', (status) => {
    expect(planIncludesFeature('premium', 'analytics', status as string | null | undefined)).toBe(true);
  });

  it('a null tier fails open — and is logged at error with the value, not silently', () => {
    expect(planIncludesFeature(null, 'sms')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith('plan_feature_unrecognised_tier', { tier: null, feature: 'sms' });
  });

  it("a removed or unknown tier ('basic') fails open and is logged at error", () => {
    expect(planIncludesFeature('basic', 'analytics')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith('plan_feature_unrecognised_tier', { tier: 'basic', feature: 'analytics' });
  });

  it('a known tier logs nothing', () => {
    planIncludesFeature('premium', 'sms');
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('schoolAllowsFeature reads the same map, and the subscription status', () => {
  it('true for a premium school with an active subscription, and asks for both columns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'premium', subscription_status: 'active' }] });
    expect(await schoolAllowsFeature('school-1', 'sms')).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringMatching(/subscription_tier[\s\S]*subscription_status/), ['school-1']);
  });

  it('false for a read-only school', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'trial', subscription_status: 'read_only' }] });
    expect(await schoolAllowsFeature('school-1', 'sms')).toBe(false);
  });

  it('fails open when the school row is not found, and says so at error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await schoolAllowsFeature('missing-school', 'sms')).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith('plan_feature_school_not_found', { school_id: 'missing-school', feature: 'sms' });
  });
});
