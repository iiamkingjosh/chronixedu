-- Migration 017: Platform Subscriptions (Phase 4 — Super Admin Platform Foundation)
-- Run in Supabase SQL Editor before deploying code changes
-- Safe to run multiple times (IF NOT EXISTS throughout)

CREATE TABLE IF NOT EXISTS platform_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'trial',
  subscription_status TEXT NOT NULL DEFAULT 'active',
  amount_naira NUMERIC(12,2),
  next_billing_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_subscriptions_school
  ON platform_subscriptions(school_id);
CREATE INDEX IF NOT EXISTS idx_platform_subscriptions_plan
  ON platform_subscriptions(plan);

ALTER TABLE platform_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_subscriptions_super_admin ON platform_subscriptions
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON platform_subscriptions TO authenticated, service_role;

-- End of migration 017
