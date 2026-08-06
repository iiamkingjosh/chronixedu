-- Migration 024: School payout config — Paystack subaccount details for direct fee settlement
-- Safe to run multiple times (IF NOT EXISTS throughout)

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS payout_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Fast lookup for "which schools still need payout setup" (super-admin dashboard, launch tracking)
CREATE INDEX IF NOT EXISTS idx_schools_payout_settlement_status
  ON schools ((payout_config->>'settlement_status'));

-- End of migration 024
