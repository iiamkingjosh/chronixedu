-- Internal messaging, announcements, and in-app notifications.
-- messages: direct, threaded messages between school users (role-pair rules
-- enforced at the application layer).
-- announcements: principal broadcasts targeted by role.
-- notifications: in-app notification feed, populated immediately for
-- messages/announcements and drained from the existing
-- PARENT_NOTIFICATION_QUEUED/SENT audit-log queue (behaviour, attendance) by
-- the notification worker. audit_logs.processed_at tracks worker progress.
-- Run after migration 009.

BEGIN;

CREATE TYPE chronixedu_announcement_target AS ENUM ('all', 'teacher', 'parent', 'student');

CREATE TABLE messages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    UUID         NOT NULL REFERENCES schools(id),
  sender_id    UUID         NOT NULL REFERENCES users(id),
  recipient_id UUID         NOT NULL REFERENCES users(id),
  subject      TEXT,
  body         TEXT         NOT NULL,
  sent_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
  thread_id    UUID         NOT NULL DEFAULT gen_random_uuid()
);

CREATE INDEX idx_messages_thread     ON messages (thread_id, sent_at);
CREATE INDEX idx_messages_recipient  ON messages (school_id, recipient_id, sent_at DESC);
CREATE INDEX idx_messages_sender     ON messages (school_id, sender_id, sent_at DESC);

CREATE TABLE announcements (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    UUID         NOT NULL REFERENCES schools(id),
  author_id    UUID         NOT NULL REFERENCES users(id),
  title        TEXT         NOT NULL,
  body         TEXT         NOT NULL,
  target_role  chronixedu_announcement_target NOT NULL DEFAULT 'all',
  published_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_announcements_school ON announcements (school_id, published_at DESC);

CREATE TABLE notifications (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id),
  type       TEXT         NOT NULL,
  title      TEXT         NOT NULL,
  body       TEXT,
  payload    JSONB,
  is_read    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);

ALTER TABLE audit_logs ADD COLUMN processed_at TIMESTAMPTZ;

COMMIT;
