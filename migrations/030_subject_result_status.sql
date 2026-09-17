-- Migration 030: per-class, per-subject submission status.
--
-- AUDIT C-2. result_status is one row per (student, term). Submitting ONE
-- subject flipped every student in the class to 'submitted', which
--   (a) locked every other teacher out of their own subject (423), and
--   (b) let the principal approve + publish with other subjects unscored.
--
-- New model:
--   subject_result_status (class, subject, term): draft | submitted
--       — teacher submit / score lock / principal return act here.
--   result_status (student, term): draft | approved | published
--       — principal approve / publish act here. 'submitted' is no longer written.
--
-- Backfill: every (class, subject, term) submitted via the old endpoint is
-- reconstructed from RESULTS_SUBMITTED audit rows, unless a later
-- RESULTS_RETURNED for that class+term reset it. Then student-level
-- 'submitted' rows are downgraded to 'draft' (their lock now lives on the
-- subject rows, so nothing that was locked becomes editable).

BEGIN;

CREATE TABLE IF NOT EXISTS subject_result_status (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id),
  class_id        uuid NOT NULL REFERENCES classes(id),
  subject_id      uuid NOT NULL REFERENCES subjects(id),
  term_id         uuid NOT NULL REFERENCES terms(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_by    uuid REFERENCES users(id),
  submitted_at    timestamptz,
  returned_by     uuid REFERENCES users(id),
  returned_at     timestamptz,
  return_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subject_result_status_unique UNIQUE (class_id, subject_id, term_id)
);

CREATE INDEX IF NOT EXISTS idx_subject_result_status_school_term
  ON subject_result_status (school_id, term_id);

ALTER TABLE subject_result_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON subject_result_status;
CREATE POLICY service_role_bypass ON subject_result_status
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS subject_result_status_tenant ON subject_result_status;
CREATE POLICY subject_result_status_tenant ON subject_result_status
  FOR ALL USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

-- ── Backfill from audit history ───────────────────────────────────────────────
INSERT INTO subject_result_status
  (school_id, class_id, subject_id, term_id, status, submitted_by, submitted_at, updated_at)
SELECT DISTINCT ON (s.class_id, s.subject_id, s.term_id)
       s.school_id, s.class_id, s.subject_id, s.term_id, 'submitted', s.user_id, s.created_at, s.created_at
FROM (
  SELECT al.school_id,
         al.entity_id                           AS class_id,
         (al.new_value ->> 'subject_id')::uuid  AS subject_id,
         (al.new_value ->> 'term_id')::uuid     AS term_id,
         al.user_id,
         al.created_at
  FROM audit_logs al
  WHERE al.action_type = 'RESULTS_SUBMITTED'
    AND al.entity_id IS NOT NULL
    AND al.new_value ? 'subject_id'
    AND al.new_value ? 'term_id'
) s
JOIN classes  c ON c.id  = s.class_id   AND c.school_id  = s.school_id
JOIN subjects sb ON sb.id = s.subject_id AND sb.school_id = s.school_id
JOIN terms    t ON t.id  = s.term_id    AND t.school_id  = s.school_id
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs r
  WHERE r.action_type = 'RESULTS_RETURNED'
    AND r.entity_id = s.class_id
    AND r.new_value ->> 'term_id' = s.term_id::text
    AND r.created_at > s.created_at
)
ORDER BY s.class_id, s.subject_id, s.term_id, s.created_at DESC
ON CONFLICT (class_id, subject_id, term_id) DO NOTHING;

UPDATE result_status SET status = 'draft', updated_at = now() WHERE status = 'submitted';

COMMIT;
