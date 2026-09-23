-- Migration 033: tenant-consistency trigger on parent_students (AUDIT Round 10 L-01).
--
-- parent_students has no school_id column of its own — it links a parent user to a
-- student row, and each of those carries its own school. isParentLinkedToStudent()
-- therefore matched on (parent_id, student_id) alone, with no tenant filter. Not
-- exploitable today (every caller pairs it with requireSchoolAccess and a
-- school-scoped data query, and no cross-school link exists), but it means the
-- single most security-sensitive join in the parent portal has no tenant guarantee
-- of its own.
--
-- Rather than add a denormalised school_id that every insert would have to set
-- correctly, this enforces the invariant directly: a parent may only ever be linked
-- to a student in the parent's own school. Same approach as migration 029 for scores.
--
-- Safe to re-run. Verified before writing: zero existing rows violate this.

BEGIN;

CREATE OR REPLACE FUNCTION parent_students_enforce_tenant_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_school UUID;
  student_school UUID;
BEGIN
  SELECT school_id INTO parent_school  FROM users    WHERE id = NEW.parent_id;
  SELECT school_id INTO student_school FROM students WHERE id = NEW.student_id;

  IF parent_school IS NULL OR student_school IS NULL THEN
    RAISE EXCEPTION 'parent_students references a missing parent or student'
      USING ERRCODE = '23514';
  END IF;

  IF parent_school <> student_school THEN
    RAISE EXCEPTION 'parent school does not match student school'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_parent_students_tenant_consistency ON parent_students;
CREATE TRIGGER trg_parent_students_tenant_consistency
  BEFORE INSERT OR UPDATE OF parent_id, student_id ON parent_students
  FOR EACH ROW EXECUTE FUNCTION parent_students_enforce_tenant_consistency();

COMMIT;
