import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';

import pool from '../src/db/client';
import { runTrialExpiryCheck } from '../src/services/subscriptionService';

describe('Subscription Trial Expiry', () => {
  let trialSchoolId: string;
  let trialSubscriptionId: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Trial Expiry School', `test-trial-expiry-${randomUUID()}`]
    );
    trialSchoolId = schoolResult.rows[0].id;

    const subResult = await pool.query<{ id: string }>(
      `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, amount_naira, subscription_status, trial_ends_at)
       VALUES ($1, 'trial', 'monthly', 0, 'trial', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [trialSchoolId]
    );
    trialSubscriptionId = subResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [trialSchoolId]).catch(() => {});
    await pool.query(`DELETE FROM platform_subscriptions WHERE id = $1`, [trialSubscriptionId]).catch(() => {});
    await pool.query(`DELETE FROM schools WHERE id = $1`, [trialSchoolId]).catch(() => {});
    await pool.end();
  }, 20000);

  it('runTrialExpiryCheck suspends expired trial subscription to "suspended"', async () => {
    await runTrialExpiryCheck();

    const result = await pool.query<{ subscription_status: string }>(
      `SELECT subscription_status FROM platform_subscriptions WHERE id = $1`,
      [trialSubscriptionId]
    );
    expect(result.rows[0].subscription_status).toBe('suspended');
  }, 20000);

  it('runTrialExpiryCheck sets school is_active = false', async () => {
    const result = await pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM schools WHERE id = $1`,
      [trialSchoolId]
    );
    expect(result.rows[0].is_active).toBe(false);
  });

  it('runTrialExpiryCheck creates a TRIAL_EXPIRED_AUTO_SUSPEND audit log entry', async () => {
    const result = await pool.query(
      `SELECT id FROM platform_audit_logs WHERE target_school_id = $1 AND action_type = 'TRIAL_EXPIRED_AUTO_SUSPEND'`,
      [trialSchoolId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });
});
