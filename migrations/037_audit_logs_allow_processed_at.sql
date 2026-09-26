-- 037: narrow migration 036's UPDATE ban so it stops breaking the notification worker.
--
-- 036 made audit_logs reject every UPDATE. That was too broad: audit_logs is not only
-- an audit trail, it is also the notification pipeline's work queue.
-- notificationWorker.ts:115 stamps `UPDATE audit_logs SET processed_at = NOW()` after
-- delivering each row, so 036 made every notification fail — and fail QUIETLY, because
-- the worker logs notification_worker_row_failed and moves on. Parents and teachers
-- would simply have stopped receiving notifications, with a green deploy and no alarm.
--
-- Caught by the integration suite before release, which is the argument for running it
-- rather than reasoning about blast radius: nothing about "make the audit trail
-- append-only" suggests it would silence notifications.
--
-- The invariant that actually matters is that the RECORD cannot be rewritten — who did
-- what, to which entity, with which old and new values. `processed_at` is delivery
-- bookkeeping, not part of that record. So UPDATE is now allowed only when every other
-- column is unchanged, compared through to_jsonb so that a column added later is
-- protected automatically rather than silently escaping the check.
--
-- DELETE remains forbidden outright, statement-level, so a zero-row DELETE still
-- raises and the rule cannot be probed.

CREATE OR REPLACE FUNCTION audit_logs_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (CLAUDE.md doctrine 6): DELETE is not permitted'
    USING HINT = 'If a retention or erasure policy genuinely requires this, drop trigger audit_logs_no_delete in its own migration so the decision is recorded.';
END;
$$;

CREATE OR REPLACE FUNCTION audit_logs_forbid_content_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD) - 'processed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'processed_at') THEN
    RAISE EXCEPTION 'audit_logs is append-only (CLAUDE.md doctrine 6): only processed_at may be updated'
      USING HINT = 'The audit record itself cannot be rewritten. processed_at is delivery bookkeeping for the notification worker.';
  END IF;
  RETURN NEW;
END;
$$;

-- Replace 036's combined trigger with the two narrower ones.
DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
DROP TRIGGER IF EXISTS audit_logs_no_content_change ON audit_logs;

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_forbid_delete();

CREATE TRIGGER audit_logs_no_content_change
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_forbid_content_change();

DROP FUNCTION IF EXISTS audit_logs_forbid_mutation();
