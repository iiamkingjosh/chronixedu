-- Migration 016: Super Admin Platform Foundation Tables
-- Run in Supabase SQL Editor before deploying code changes
-- Safe to run multiple times (IF NOT EXISTS throughout)

CREATE TABLE IF NOT EXISTS support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id UUID REFERENCES users(id) NOT NULL,
  school_id UUID REFERENCES schools(id) NOT NULL,
  impersonated_user_id UUID REFERENCES users(id) NOT NULL,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  actions_taken JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id UUID REFERENCES users(id) NOT NULL,
  action_type TEXT NOT NULL,
  target_school_id UUID REFERENCES schools(id),
  target_user_id UUID REFERENCES users(id),
  metadata JSONB,
  ip_address TEXT,
  support_session_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_admin
  ON support_sessions(platform_admin_id);
CREATE INDEX IF NOT EXISTS idx_support_sessions_school
  ON support_sessions(school_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_school
  ON platform_audit_logs(target_school_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_action
  ON platform_audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_session
  ON platform_audit_logs(support_session_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created
  ON platform_audit_logs(created_at DESC);

ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_sessions_super_admin ON support_sessions
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

CREATE POLICY platform_audit_logs_super_admin ON platform_audit_logs
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON support_sessions TO authenticated, service_role;
GRANT SELECT, INSERT ON platform_audit_logs TO authenticated, service_role;

-- End of migration 016
