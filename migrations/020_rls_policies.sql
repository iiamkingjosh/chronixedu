-- Migration 001: Enable RLS and add tenant isolation policies on remaining tables
-- Run once. Safe to re-run (uses IF NOT EXISTS where possible).

-- ── Enable RLS on tables that are missing it ───────────────────────────────────

ALTER TABLE announcements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_submissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance              ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_alerts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE behaviour_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications           ENABLE ROW LEVEL SECURITY;

-- ── announcements ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass       ON announcements;
DROP POLICY IF EXISTS announcements_tenant      ON announcements;

CREATE POLICY service_role_bypass ON announcements
  FOR ALL TO service_role USING (true);

CREATE POLICY announcements_tenant ON announcements
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── assignments ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass  ON assignments;
DROP POLICY IF EXISTS assignments_tenant   ON assignments;

CREATE POLICY service_role_bypass ON assignments
  FOR ALL TO service_role USING (true);

CREATE POLICY assignments_tenant ON assignments
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── assignment_submissions ────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass              ON assignment_submissions;
DROP POLICY IF EXISTS assignment_submissions_tenant    ON assignment_submissions;

CREATE POLICY service_role_bypass ON assignment_submissions
  FOR ALL TO service_role USING (true);

CREATE POLICY assignment_submissions_tenant ON assignment_submissions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.id = assignment_submissions.assignment_id
        AND a.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  );

-- ── attendance ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass  ON attendance;
DROP POLICY IF EXISTS attendance_tenant    ON attendance;

CREATE POLICY service_role_bypass ON attendance
  FOR ALL TO service_role USING (true);

CREATE POLICY attendance_tenant ON attendance
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── attendance_alerts ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass      ON attendance_alerts;
DROP POLICY IF EXISTS attendance_alerts_tenant ON attendance_alerts;

CREATE POLICY service_role_bypass ON attendance_alerts
  FOR ALL TO service_role USING (true);

CREATE POLICY attendance_alerts_tenant ON attendance_alerts
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── behaviour_records ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass       ON behaviour_records;
DROP POLICY IF EXISTS behaviour_records_tenant  ON behaviour_records;

CREATE POLICY service_role_bypass ON behaviour_records
  FOR ALL TO service_role USING (true);

CREATE POLICY behaviour_records_tenant ON behaviour_records
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── messages ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass  ON messages;
DROP POLICY IF EXISTS messages_tenant      ON messages;

CREATE POLICY service_role_bypass ON messages
  FOR ALL TO service_role USING (true);

-- Messages: sender or recipient in the same school
CREATE POLICY messages_tenant ON messages
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── notices ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass  ON notices;
DROP POLICY IF EXISTS notices_tenant       ON notices;

CREATE POLICY service_role_bypass ON notices
  FOR ALL TO service_role USING (true);

CREATE POLICY notices_tenant ON notices
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── notifications ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass   ON notifications;
DROP POLICY IF EXISTS notifications_user    ON notifications;

CREATE POLICY service_role_bypass ON notifications
  FOR ALL TO service_role USING (true);

-- Notifications: only the recipient sees their own
CREATE POLICY notifications_user ON notifications
  FOR ALL USING (
    user_id = auth.uid()
  );

-- ── notification_logs ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS service_role_bypass        ON notification_logs;
DROP POLICY IF EXISTS notification_logs_tenant   ON notification_logs;

CREATE POLICY service_role_bypass ON notification_logs
  FOR ALL TO service_role USING (true);

CREATE POLICY notification_logs_tenant ON notification_logs
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

-- ── Add missing tenant isolation to tables that only had service_role_bypass ──
-- (fee_invoices, fee_structures, payments, timetable_slots)

DROP POLICY IF EXISTS fee_invoices_tenant  ON fee_invoices;
CREATE POLICY fee_invoices_tenant ON fee_invoices
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

DROP POLICY IF EXISTS fee_structures_tenant  ON fee_structures;
CREATE POLICY fee_structures_tenant ON fee_structures
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );

DROP POLICY IF EXISTS payments_tenant  ON payments;
CREATE POLICY payments_tenant ON payments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM fee_invoices fi
      WHERE fi.id = payments.invoice_id
        AND fi.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  );

DROP POLICY IF EXISTS timetable_slots_tenant  ON timetable_slots;
CREATE POLICY timetable_slots_tenant ON timetable_slots
  FOR ALL USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
  );
