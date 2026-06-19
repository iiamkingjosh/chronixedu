-- Migration 022: Email Resilience — retry queue for failed SendGrid sends
-- Safe to run multiple times (IF NOT EXISTS throughout)

CREATE TABLE IF NOT EXISTS email_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  text_body       TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue (status);

-- End of migration 022
