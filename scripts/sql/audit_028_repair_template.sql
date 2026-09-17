-- AUDIT C-1 — repair TEMPLATE for rows found by audit_028_detect_overwrites.sql.
--
-- Run ONLY after migration 028 (the old unique key would block the fix).
-- Ends in ROLLBACK: read the output, then change the last line to COMMIT.
--
-- What it does, for each flagged row whose last teacher teaches exactly ONE
-- subject in that student's class: re-labels the row to that teacher's
-- subject (the value really is theirs). The ORIGINAL subject's score for that
-- component is lost — it must be re-entered by its teacher. The script lists
-- exactly which (student, subject, component) cells need re-entry.
--
-- Rows whose teacher teaches several subjects in the class are NOT touched;
-- resolve those by hand with the teacher.

BEGIN;

CREATE TEMP TABLE c1_candidates ON COMMIT DROP AS
WITH enrol AS (
  SELECT sc.student_id, sc.class_id, t.id AS term_id
  FROM student_classes sc JOIN terms t ON t.session_id = sc.session_id
)
SELECT s.id AS score_id, s.school_id, s.student_id, s.term_id, s.component_id,
       s.subject_id AS wrong_subject_id, e.class_id,
       (SELECT min(ta.subject_id::text)::uuid FROM teacher_assignments ta
         WHERE ta.teacher_id = s.entered_by AND ta.class_id = e.class_id AND ta.term_id = s.term_id) AS right_subject_id,
       (SELECT count(DISTINCT ta.subject_id) FROM teacher_assignments ta
         WHERE ta.teacher_id = s.entered_by AND ta.class_id = e.class_id AND ta.term_id = s.term_id) AS teacher_subject_count
FROM scores s
JOIN enrol e ON e.student_id = s.student_id AND e.term_id = s.term_id
JOIN users u ON u.id = s.entered_by AND u.role = 'teacher'
WHERE NOT EXISTS (SELECT 1 FROM teacher_assignments ta
                  WHERE ta.teacher_id = s.entered_by AND ta.subject_id = s.subject_id
                    AND ta.class_id = e.class_id AND ta.term_id = s.term_id)
  AND EXISTS (SELECT 1 FROM teacher_assignments ta
              WHERE ta.teacher_id = s.entered_by AND ta.class_id = e.class_id AND ta.term_id = s.term_id);

-- Needs manual review (teacher teaches >1 subject in the class, or target cell already exists)
SELECT c.*, 'MANUAL' AS action FROM c1_candidates c
WHERE c.teacher_subject_count <> 1
   OR EXISTS (SELECT 1 FROM scores x WHERE x.student_id = c.student_id AND x.term_id = c.term_id
              AND x.component_id = c.component_id AND x.subject_id = c.right_subject_id);

-- Re-label the safe ones
WITH fixed AS (
  UPDATE scores s
  SET subject_id = c.right_subject_id, updated_at = now()
  FROM c1_candidates c
  WHERE s.id = c.score_id
    AND c.teacher_subject_count = 1
    AND NOT EXISTS (SELECT 1 FROM scores x WHERE x.student_id = c.student_id AND x.term_id = c.term_id
                    AND x.component_id = c.component_id AND x.subject_id = c.right_subject_id)
  RETURNING s.id, s.school_id, c.wrong_subject_id, c.right_subject_id, s.student_id, s.component_id
),
logged AS (
  INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, old_value, new_value)
  SELECT f.school_id, NULL, 'SCORE_SUBJECT_REPAIRED', 'scores', f.id,
         jsonb_build_object('subject_id', f.wrong_subject_id),
         jsonb_build_object('subject_id', f.right_subject_id, 'reason', 'AUDIT C-1 cross-subject overwrite repair')
  FROM fixed f
  RETURNING entity_id
)
-- Cells that must now be RE-ENTERED by the original subject teacher
SELECT st.admission_no, cl.name AS class, sub.name AS subject_to_reenter, comp.name AS component
FROM fixed f
JOIN students st ON st.id = f.student_id
JOIN c1_candidates c ON c.score_id = f.id
JOIN classes cl ON cl.id = c.class_id
JOIN subjects sub ON sub.id = f.wrong_subject_id
JOIN assessment_components comp ON comp.id = f.component_id
ORDER BY cl.name, st.admission_no, sub.name;

ROLLBACK;  -- change to COMMIT after reviewing the output
