-- 038: close three holes left by 036/037, and move the principal invariant into the
-- database.
--
-- The lesson from 036 is applied here directly. 036's header said "nothing in the
-- codebase deletes from audit_logs, so this breaks no existing path" — true, and
-- irrelevant, because 036 banned DELETE *and UPDATE* while the verification had only
-- covered DELETE. The guard forbade an operation nobody had checked for. So, for each
-- guard below, every operation it forbids is enumerated and checked separately:
--
--   TRUNCATE on audit_logs      — grepped src and tests: no occurrence in src, but the
--                                 DB suite's seed() truncates every table with CASCADE.
--                                 That is why the TRUNCATE guard is not here (see 1).
--   processed_at reset to NULL  — only notificationWorker.ts:115 writes the column, and
--                                 it writes NOW(), never NULL.
--   schools.is_active FALSE->TRUE — exactly two writers, both in superAdmin.ts:
--                                 /onboarding/:id/complete (line ~1621) and
--                                 /schools/:schoolId/reactivate (line ~733). INSERT is
--                                 not covered by the trigger, so fixtures that insert an
--                                 active school directly are unaffected.

-- ── 1. TRUNCATE is NOT guarded, deliberately — and this is the honest limit ──
-- TRUNCATE bypasses BEFORE DELETE entirely: Postgres fires DELETE triggers only for
-- DELETE, so `TRUNCATE audit_logs` empties the table with no guard running. A
-- BEFORE TRUNCATE trigger closes that, and it was written and then removed, because it
-- is incompatible with the test harness: the DB suite's seed() runs
-- `TRUNCATE <every table> CASCADE`, and CASCADE pulls audit_logs in through its FKs to
-- users and schools whether or not it is named. Excluding it from the list changes
-- nothing. The alternative — a flag that exempts disposable databases — converts the
-- invariant into a convention, which is the thing enforcing it was meant to prevent.
--
-- So the scope of doctrine 6's enforcement is, precisely: DELETE and content UPDATE are
-- blocked for every caller including the table owner; TRUNCATE is not. Nor is
-- `ALTER TABLE audit_logs DISABLE TRIGGER ALL`, or session_replication_role = 'replica',
-- both available to the owner the API connects as. This is accident-proofing, not
-- tamper-proofing. It stops a cleanup script and a careless migration; it does not stop
-- someone who means it.

-- ── 2. processed_at must be one-way ───────────────────────────────────────────
-- 037 allowed any value in processed_at, including NULL — and NULL is the notification
-- worker's queue predicate. `UPDATE audit_logs SET processed_at = NULL` would re-queue
-- every already-delivered notification, mass-redelivering old alerts to parents from
-- one plausible ops command. A stamp that can be un-stamped is not bookkeeping.

CREATE OR REPLACE FUNCTION audit_logs_forbid_content_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD) - 'processed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'processed_at') THEN
    RAISE EXCEPTION 'audit_logs is append-only (CLAUDE.md doctrine 6): only processed_at may be updated'
      USING HINT = 'The audit record itself cannot be rewritten. processed_at is delivery bookkeeping for the notification worker.';
  END IF;
  IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
    RAISE EXCEPTION 'audit_logs.processed_at is write-once: it cannot be changed or cleared once stamped'
      USING HINT = 'Clearing processed_at re-queues delivered notifications and would re-send old alerts to parents.';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. The notification queue's predicate had no index ────────────────────────
-- The worker scans audit_logs for two action types with processed_at IS NULL. ~99% of
-- the table is permanently NULL (ATTENDANCE_MARKED, SCORE_ENTERED and friends are never
-- selected by the worker and keep processed_at NULL by design), and the table only
-- grows, so the scan degrades quietly.

CREATE INDEX IF NOT EXISTS idx_audit_logs_notification_queue
  ON audit_logs (created_at)
  WHERE processed_at IS NULL
    AND action_type IN ('PARENT_NOTIFICATION_QUEUED', 'PARENT_NOTIFICATION_SENT');

-- ── 4. A school cannot be activated without a principal ───────────────────────
-- POST /onboarding/:id/complete now checks this, but /schools/:schoolId/reactivate did
-- not: create a dormant school with POST /api/schools, reactivate it one request later,
-- and you have a live tenant nobody can administer — the same outcome in two calls.
-- The invariant was spread across routes, which is the condition that produced the hole
-- in the first place. The routes keep their check so the caller gets a clean 400; this
-- is the backstop that a third writer cannot forget.
--
-- UPDATE only, and only on the FALSE -> TRUE transition: suspending, or any other
-- column change on an already-active school, is untouched, and fixtures that INSERT an
-- active school directly are unaffected.

CREATE OR REPLACE FUNCTION schools_require_principal_on_activate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active AND NOT OLD.is_active THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE school_id = NEW.id AND role = 'principal') THEN
      RAISE EXCEPTION 'school % cannot be activated: it has no principal account', NEW.id
        USING HINT = 'Create a principal for this school first — an active school with no principal is one nobody can administer.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schools_require_principal ON schools;
CREATE TRIGGER schools_require_principal
  BEFORE UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION schools_require_principal_on_activate();
