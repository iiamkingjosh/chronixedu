-- Adds support for:
--   * Assigning a single "form teacher" (class teacher) to each class
--   * Storing a teacher's signature image (rendered on report cards)
--   * One overall class-teacher comment per student per term, replacing the
--     unused per-subject report_card_comments table (no write path existed).
--
-- Run after migration 015.

BEGIN;

ALTER TABLE classes ADD COLUMN form_teacher_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users ADD COLUMN signature_url TEXT;

-- Repurpose report_card_comments (migration 004) into class_teacher_comments:
-- one row per (student, term) instead of one row per (student, term, subject).
ALTER TABLE report_card_comments RENAME TO class_teacher_comments;
ALTER TABLE class_teacher_comments DROP CONSTRAINT report_card_comments_student_id_term_id_subject_id_key;
ALTER TABLE class_teacher_comments DROP COLUMN subject_id;
ALTER TABLE class_teacher_comments ADD CONSTRAINT class_teacher_comments_student_term_key UNIQUE (student_id, term_id);
ALTER TABLE class_teacher_comments ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMIT;
