-- Migration 018: Onboarding Sessions (Phase 4 — Onboarding Wizard API)
-- Run in Supabase SQL Editor before deploying code changes
-- Safe to run multiple times (IF NOT EXISTS throughout)

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) NOT NULL,
  created_by UUID REFERENCES users(id) NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  steps_completed JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_school
  ON onboarding_sessions(school_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_status
  ON onboarding_sessions(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_created_by
  ON onboarding_sessions(created_by);

ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY onboarding_sessions_super_admin
  ON onboarding_sessions FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON onboarding_sessions
  TO authenticated, service_role;

-- End of migration 018
