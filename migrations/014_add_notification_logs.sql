-- Logs every SMS delivery attempt made by the notification worker
-- (sent / failed / throttled), used for auditing and enforcing the
-- per-user daily SMS throttle.
-- Run after migration 013.

BEGIN;

CREATE TABLE notification_logs (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  UUID         NOT NULL REFERENCES schools(id),
  user_id    UUID         NOT NULL REFERENCES users(id),
  channel    TEXT         NOT NULL,
  type       TEXT         NOT NULL,
  status     TEXT         NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_logs_user_channel ON notification_logs (user_id, channel, created_at DESC);
CREATE INDEX idx_notification_logs_school        ON notification_logs (school_id, created_at DESC);

COMMIT;
