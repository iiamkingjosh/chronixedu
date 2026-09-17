-- Migration 032: bring platform_subscriptions in line with what the code uses.
--
-- AUDIT M-drift. routes/superAdmin.ts and services/subscriptionService.ts read
-- and write billing_cycle and trial_ends_at, but no migration created them —
-- production was altered by hand. A database rebuilt from /migrations (disaster
-- recovery, staging, CI) therefore broke every subscription endpoint and the
-- trial-expiry cron.
--
-- IF NOT EXISTS makes this a no-op on production. If production's hand-made
-- columns differ in type, check with:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'platform_subscriptions';

BEGIN;

ALTER TABLE platform_subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_subscriptions_billing_cycle_check') THEN
    ALTER TABLE platform_subscriptions
      ADD CONSTRAINT platform_subscriptions_billing_cycle_check CHECK (billing_cycle IN ('monthly', 'annual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_platform_subscriptions_trial_expiry
  ON platform_subscriptions (trial_ends_at) WHERE subscription_status = 'trial';

COMMIT;
