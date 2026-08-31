-- Fix admission_no uniqueness scope.
--
-- students.admission_no was declared globally UNIQUE, but registerStudent()'s
-- sequence generator (apps/api/src/db/queries/students.ts) only computes the
-- "next" admission number by scanning the CURRENT school's own students
-- (WHERE school_id = $1) — matching the actual product intent: admission
-- numbers are meant to be unique within a school, via a configurable
-- per-school prefix (school_settings.identity_config.admission_prefix),
-- not unique across the whole platform.
--
-- Two different schools that both use the default "SCH" prefix (the
-- fallback whenever no custom prefix is configured) can independently
-- compute the same "next available" admission number for the same year,
-- and the global UNIQUE constraint then rejects one school's genuinely
-- valid, non-conflicting registration with a spurious duplicate-key error.
--
-- No code in this codebase looks up a student by admission_no alone,
-- without already being scoped to a school (via school_id, a specific
-- student id, or a school-scoped join) — verified by inspecting every
-- reference to admission_no in apps/api/src before writing this migration.
-- Composite uniqueness is therefore a safe, behavior-preserving fix that
-- matches what the generation logic and every existing lookup already
-- assume.

BEGIN;

ALTER TABLE students DROP CONSTRAINT students_admission_no_key;
ALTER TABLE students ADD CONSTRAINT students_school_id_admission_no_key UNIQUE (school_id, admission_no);

COMMIT;
