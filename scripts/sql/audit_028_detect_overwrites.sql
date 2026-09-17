-- AUDIT C-1 — detect score rows damaged by the cross-subject overwrite bug.
-- READ-ONLY. Run in the Supabase SQL editor BEFORE applying migration 028,
-- and keep the output. Nothing here modifies data.
--
-- How the bug damaged data: with a shared (class-level or school-wide)
-- assessment config, subject B's upsert for (student, term, component) hit
-- subject A's row and replaced score + entered_by, but left subject_id = A.
-- So a damaged row usually shows: entered_by is a teacher who is NOT assigned
-- to the row's subject for that student's class, but IS assigned to another
-- subject in that class.
--
-- Blind spot: a class teacher assigned to every subject leaves no fingerprint.
-- For those classes use query 3 (missing rows) and ask the teacher.

-- 1. Exposure: shared configs that make the bug possible (0 = never exposed).
SELECT s.name AS school, t.name AS term, count(*) AS shared_configs
FROM assessment_configs ac
JOIN schools s ON s.id = ac.school_id
JOIN terms   t ON t.id = ac.term_id
WHERE ac.subject_id IS NULL
GROUP BY s.name, t.name
ORDER BY s.name, t.name;

-- 2. Likely overwritten rows (score now belongs to a different subject's teacher).
WITH enrol AS (
  SELECT sc.student_id, sc.class_id, t.id AS term_id
  FROM student_classes sc
  JOIN terms t ON t.session_id = sc.session_id
)
SELECT sch.name           AS school,
       c.name             AS class,
       st.admission_no,
       sub.name           AS stored_subject,
       comp.name          AS component,
       s.score,
       u.email            AS last_entered_by,
       (SELECT string_agg(DISTINCT sb2.name, ', ')
          FROM teacher_assignments ta2
          JOIN subjects sb2 ON sb2.id = ta2.subject_id
         WHERE ta2.teacher_id = s.entered_by AND ta2.class_id = e.class_id AND ta2.term_id = s.term_id
       )                  AS subjects_that_teacher_actually_teaches,
       s.updated_at,
       s.id               AS score_id
FROM scores s
JOIN enrol e      ON e.student_id = s.student_id AND e.term_id = s.term_id
JOIN users u      ON u.id = s.entered_by AND u.role = 'teacher'
JOIN schools sch  ON sch.id = s.school_id
JOIN classes c    ON c.id = e.class_id
JOIN students st  ON st.id = s.student_id
JOIN subjects sub ON sub.id = s.subject_id
JOIN assessment_components comp ON comp.id = s.component_id
WHERE NOT EXISTS (
        SELECT 1 FROM teacher_assignments ta
        WHERE ta.teacher_id = s.entered_by AND ta.subject_id = s.subject_id
          AND ta.class_id = e.class_id AND ta.term_id = s.term_id)
  AND EXISTS (
        SELECT 1 FROM teacher_assignments ta
        WHERE ta.teacher_id = s.entered_by AND ta.class_id = e.class_id AND ta.term_id = s.term_id)
ORDER BY sch.name, c.name, st.admission_no, sub.name, comp.name;

-- 3. Missing rows: compare score_rows with students × (components in that
--    class's assessment config). After an overwrite, the second subject's row
--    simply does not exist. (Also flags genuinely unfinished entry.)
WITH enrol AS (
  SELECT sc.class_id, t.id AS term_id, count(*) AS students
  FROM student_classes sc
  JOIN terms t ON t.session_id = sc.session_id
  GROUP BY sc.class_id, t.id
)
SELECT c.name AS class, sub.name AS subject, u.email AS teacher,
       e.students,
       (SELECT count(*) FROM scores s
         JOIN student_classes sc2 ON sc2.student_id = s.student_id AND sc2.class_id = ta.class_id
         JOIN terms t2 ON t2.id = s.term_id AND t2.session_id = sc2.session_id
        WHERE s.subject_id = ta.subject_id AND s.term_id = ta.term_id) AS score_rows
FROM teacher_assignments ta
JOIN enrol e      ON e.class_id = ta.class_id AND e.term_id = ta.term_id
JOIN classes c    ON c.id = ta.class_id
JOIN subjects sub ON sub.id = ta.subject_id
JOIN users u      ON u.id = ta.teacher_id
JOIN terms tt     ON tt.id = ta.term_id AND tt.is_current
ORDER BY c.name, sub.name;

-- 4. Audit-trail evidence from the single-entry route (the bulk route logged nothing).
SELECT al.created_at, u.email, al.action_type,
       al.old_value ->> 'score' AS old_score, al.new_value ->> 'score' AS new_score,
       sub.name AS row_subject_now
FROM audit_logs al
JOIN users u   ON u.id = al.user_id
JOIN scores s  ON s.id = al.entity_id
JOIN subjects sub ON sub.id = s.subject_id
WHERE al.entity = 'scores' AND al.action_type = 'SCORE_UPDATED'
  AND NOT EXISTS (SELECT 1 FROM teacher_assignments ta
                  WHERE ta.teacher_id = al.user_id AND ta.subject_id = s.subject_id AND ta.term_id = s.term_id)
ORDER BY al.created_at DESC;
