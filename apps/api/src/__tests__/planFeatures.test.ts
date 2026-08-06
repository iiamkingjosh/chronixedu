import pool from '../db/client';
import { planIncludesFeature, schoolAllowsFeature } from '../services/planFeatures';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('planIncludesFeature', () => {
  const features = ['sms', 'online_payments', 'analytics'] as const;

  it.each(features)('returns false for basic on %s', (feature) => {
    expect(planIncludesFeature('basic', feature)).toBe(false);
  });

  it.each(features)('returns true for premium on %s', (feature) => {
    expect(planIncludesFeature('premium', feature)).toBe(true);
  });

  it.each(features)('returns true for trial on %s', (feature) => {
    expect(planIncludesFeature('trial', feature)).toBe(true);
  });

  it.each(features)('returns true for enterprise on %s', (feature) => {
    expect(planIncludesFeature('enterprise', feature)).toBe(true);
  });

  it.each(features)('fails open (returns true) for null on %s', (feature) => {
    expect(planIncludesFeature(null, feature)).toBe(true);
  });

  it.each(features)('fails open (returns true) for an unrecognized value on %s', (feature) => {
    expect(planIncludesFeature('some-future-plan', feature)).toBe(true);
  });
});

describe('schoolAllowsFeature', () => {
  it('returns false when the school is on basic', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'basic' }] });

    const result = await schoolAllowsFeature('school-1', 'sms');

    expect(result).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('subscription_tier'),
      ['school-1']
    );
  });

  it('returns true when the school is on premium', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'premium' }] });

    const result = await schoolAllowsFeature('school-1', 'sms');

    expect(result).toBe(true);
  });

  it('fails open (returns true) when the school row is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await schoolAllowsFeature('missing-school', 'sms');

    expect(result).toBe(true);
  });
});
