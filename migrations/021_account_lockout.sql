-- Account lockout: track failed login attempts and temporary locks
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password   BOOLEAN     NOT NULL DEFAULT FALSE;

-- Fast lookup: email + lockout check at login time
CREATE INDEX IF NOT EXISTS idx_users_email_lockout
  ON users (email, locked_until, failed_login_attempts);
