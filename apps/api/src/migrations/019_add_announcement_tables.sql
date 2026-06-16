-- Migration 019: Announcements & Platform Metrics Snapshots (Phase 4 — Analytics, Health & Announcements API)
-- Run in Supabase SQL Editor before deploying code changes
-- Safe to run multiple times (IF NOT EXISTS throughout)

CREATE TABLE IF NOT EXISTS platform_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'warning', 'critical', 'maintenance')),
  target_plans TEXT[] NOT NULL DEFAULT ARRAY['basic', 'professional', 'enterprise', 'trial'],
  scheduled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_announcements_published
  ON platform_announcements(published_at);
CREATE INDEX IF NOT EXISTS idx_platform_announcements_created_by
  ON platform_announcements(created_by);

ALTER TABLE platform_announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_announcements_super_admin
  ON platform_announcements FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_announcements
  TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS platform_metrics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL UNIQUE,
  total_schools INTEGER DEFAULT 0,
  active_schools INTEGER DEFAULT 0,
  total_students INTEGER DEFAULT 0,
  total_mrr_naira NUMERIC(12,2) DEFAULT 0,
  new_schools_this_month INTEGER DEFAULT 0,
  churned_schools_this_month INTEGER DEFAULT 0,
  api_errors_24h INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_metrics_snapshots_date
  ON platform_metrics_snapshots(snapshot_date);

ALTER TABLE platform_metrics_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_metrics_snapshots_super_admin
  ON platform_metrics_snapshots FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON platform_metrics_snapshots
  TO authenticated, service_role;

-- End of migration 019
