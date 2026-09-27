-- 041: give principal_remarks the shape its sibling already has.
--
-- The report card renders `principalRemark?.remark_text` and `fetchPrincipalRemark`
-- reads it, but NOTHING in the codebase ever wrote a row — so the document parents keep
-- has had a principal's-remark field nobody could fill, beside a form-teacher comment
-- field that works. This migration prepares the write path.
--
-- `class_teacher_comments` carries UNIQUE (student_id, term_id) and `updated_at`, so its
-- route upserts and a teacher editing a comment rewrites one row. `principal_remarks`
-- has neither, and `fetchPrincipalRemark` compensates with ORDER BY created_at DESC
-- LIMIT 1 — "latest wins". Without the constraint every edit would append, so a
-- principal revising a remark five times leaves five rows and the reader picks one by
-- timestamp. That works until two writes share a timestamp, and it is needless divergence
-- from the table right next to it.
--
-- Safe to add: the table holds 0 rows in production, verified before writing this, so
-- there are no duplicates for the unique index to reject. Checked because a UNIQUE on a
-- populated table is exactly the migration that fails at 3am.
--
-- Not added: `school_id`. principal_remarks is tenant data reached only through
-- student_id, which is a real gap — `fetchPrincipalRemark(studentId, termId)` is not
-- school-scoped either. The route therefore verifies the student belongs to the school
-- before writing, the same way the class-comment route does. Adding the column properly
-- means backfilling it and rewriting the reader, which belongs in its own change rather
-- than riding along with a feature fix.

ALTER TABLE principal_remarks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Found by columns, not by name: production constraints from 001-023 were partly applied
-- by hand, so a name-based IF NOT EXISTS would not be reliable here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'principal_remarks'::regclass
       AND contype = 'u'
       AND conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'principal_remarks'::regclass AND attname = 'student_id'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'principal_remarks'::regclass AND attname = 'term_id')
       ]::smallint[]
  ) THEN
    ALTER TABLE principal_remarks
      ADD CONSTRAINT principal_remarks_student_term_key UNIQUE (student_id, term_id);
  END IF;
END $$;
