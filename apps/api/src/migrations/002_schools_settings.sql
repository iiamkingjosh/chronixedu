-- 002_schools_settings.sql
-- Schools, school_settings, and audit_logs tables

CREATE TABLE IF NOT EXISTS schools (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS school_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  identity_config JSONB       NOT NULL DEFAULT '{}',
  academic_config JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID        REFERENCES schools(id) ON DELETE SET NULL,
  user_id     UUID,
  action      TEXT        NOT NULL,
  entity      TEXT        NOT NULL,
  entity_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_school_id ON audit_logs(school_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
