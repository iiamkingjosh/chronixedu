-- 002_schools_settings.sql
-- NOTE: schools, school_settings, and audit_logs are already defined in
-- migrations/001_create_chronix_edu_schema.sql (root-level migration).
-- This file adds any missing columns and documents the real schema used by
-- the schools API.

-- Add updated_at to schools if missing (001 does not include it)
ALTER TABLE schools ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure index for audit log entity queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);

-- ─── Real schema reference (from 001_create_chronix_edu_schema.sql) ─────────
--
-- schools: id UUID PK, name TEXT, slug TEXT NOT NULL UNIQUE,
--   logo_url TEXT, stamp_url TEXT, address TEXT, phone TEXT, email TEXT,
--   primary_colour TEXT, secondary_colour TEXT, subscription_tier TEXT,
--   is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ,
--   [updated_at — added above]
--
-- school_settings: id UUID PK, school_id UUID UNIQUE FK→schools,
--   identity_config JSONB DEFAULT '{}', academic_config JSONB DEFAULT '{}',
--   report_config JSONB DEFAULT '{}', notification_config JSONB DEFAULT '{}',
--   updated_at TIMESTAMPTZ, updated_by UUID FK→users
--
-- audit_logs: id UUID PK, school_id UUID NOT NULL FK→schools,
--   user_id UUID FK→users, action_type TEXT NOT NULL, entity TEXT NOT NULL,
--   entity_id UUID, old_value JSONB, new_value JSONB, ip_address TEXT,
--   created_at TIMESTAMPTZ
--
-- result_status: id UUID PK, student_id UUID FK→students,
--   term_id UUID FK→terms, school_id UUID FK→schools,
--   status chronixedu_result_status DEFAULT 'draft',
--   updated_by UUID FK→users, updated_at TIMESTAMPTZ
