-- Chronix Edu PostgreSQL schema migration
-- UUID primary keys, tenant-scoped school_id in every school-scoped table,
-- partial unique indexes for single current session/term, and component-sum validation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enum types
CREATE TYPE chronixedu_user_role AS ENUM (
  'super_admin',
  'principal',
  'teacher',
  'parent',
  'student',
  'registrar',
  'bursar'
);

CREATE TYPE chronixedu_teacher_mode AS ENUM (
  'class',
  'subject'
);

CREATE TYPE chronixedu_result_status AS ENUM (
  'draft',
  'submitted',
  'approved',
  'published'
);

-- 1) schools
CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  stamp_url TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  primary_colour TEXT,
  secondary_colour TEXT,
  subscription_tier TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) school_settings
CREATE TABLE school_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL UNIQUE REFERENCES schools(id),
  identity_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  academic_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

CREATE INDEX idx_school_settings_school_id ON school_settings (school_id);

-- 3) academic_sessions
CREATE TABLE academic_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_academic_sessions_school_id ON academic_sessions (school_id);
CREATE UNIQUE INDEX one_current_session ON academic_sessions (school_id) WHERE is_current = TRUE;

-- 4) terms
CREATE TABLE terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES academic_sessions(id),
  school_id UUID NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_terms_school_id ON terms (school_id);
CREATE UNIQUE INDEX one_current_term ON terms (session_id) WHERE is_current = TRUE;

-- 5) classes
CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  stream TEXT
);

CREATE INDEX idx_classes_school_id ON classes (school_id);

-- 6) subjects
CREATE TABLE subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_subjects_school_id ON subjects (school_id);

-- 7) users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role chronixedu_user_role NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  title VARCHAR(20),
  teacher_mode chronixedu_teacher_mode NOT NULL DEFAULT 'subject',
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_school_id ON users (school_id);

ALTER TABLE school_settings
  ADD CONSTRAINT fk_school_settings_updated_by
  FOREIGN KEY (updated_by) REFERENCES users(id);

-- 8) students
CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  user_id UUID NOT NULL REFERENCES users(id),
  admission_no TEXT NOT NULL UNIQUE,
  dob DATE,
  gender TEXT,
  address TEXT,
  photo_url TEXT,
  blood_group TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT
);

CREATE INDEX idx_students_school_id ON students (school_id);

-- 9) parent_students
CREATE TABLE parent_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID NOT NULL REFERENCES users(id),
  student_id UUID NOT NULL REFERENCES students(id),
  relationship_type TEXT NOT NULL,
  is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_parent_students_student_id ON parent_students (student_id);
CREATE INDEX idx_parent_students_parent_id ON parent_students (parent_id);

-- 10) student_classes
CREATE TABLE student_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  class_id UUID NOT NULL REFERENCES classes(id),
  session_id UUID NOT NULL REFERENCES academic_sessions(id),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_student_classes_student_id ON student_classes (student_id);
CREATE INDEX idx_student_classes_class_id ON student_classes (class_id);
CREATE INDEX idx_student_classes_session_id ON student_classes (session_id);

-- 11) teacher_assignments
CREATE TABLE teacher_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES users(id),
  class_id UUID NOT NULL REFERENCES classes(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  term_id UUID NOT NULL REFERENCES terms(id),
  school_id UUID NOT NULL REFERENCES schools(id)
);

CREATE INDEX idx_teacher_assignments_school_id ON teacher_assignments (school_id);
CREATE INDEX idx_teacher_assignments_teacher_id ON teacher_assignments (teacher_id);

-- 12) assessment_configs
CREATE TABLE assessment_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  term_id UUID NOT NULL REFERENCES terms(id),
  subject_id UUID REFERENCES subjects(id),
  class_level VARCHAR(50),
  is_default BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_assessment_configs_school_id ON assessment_configs (school_id);
CREATE INDEX idx_assessment_configs_term_id ON assessment_configs (term_id);
CREATE INDEX idx_assessment_configs_subject_id ON assessment_configs (subject_id);

-- 13) assessment_components
CREATE TABLE assessment_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES assessment_configs(id),
  name TEXT NOT NULL,
  max_score NUMERIC(10,2) NOT NULL,
  weight_percent NUMERIC(5,2) NOT NULL,
  display_order INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_assessment_components_config_id ON assessment_components (config_id);

CREATE OR REPLACE FUNCTION validate_assessment_components_total() RETURNS trigger AS $$
DECLARE
  config_uuid UUID;
  total NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    config_uuid := OLD.config_id;
  ELSE
    config_uuid := NEW.config_id;
  END IF;

  SELECT COALESCE(SUM(weight_percent), 0) INTO total
  FROM assessment_components
  WHERE config_id = config_uuid;

  IF total <> 100 THEN
    RAISE EXCEPTION 'Total weight_percent for assessment_components for config % must equal 100; got %', config_uuid, total;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.config_id IS DISTINCT FROM NEW.config_id THEN
    SELECT COALESCE(SUM(weight_percent), 0) INTO total
    FROM assessment_components
    WHERE config_id = OLD.config_id;

    IF total <> 100 THEN
      RAISE EXCEPTION 'Total weight_percent for assessment_components for config % must equal 100; got %', OLD.config_id, total;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assessment_components_total_check
  AFTER INSERT OR UPDATE OR DELETE ON assessment_components
  FOR EACH ROW
  EXECUTE FUNCTION validate_assessment_components_total();

-- 14) scores
CREATE TABLE scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  student_id UUID NOT NULL REFERENCES students(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  term_id UUID NOT NULL REFERENCES terms(id),
  component_id UUID NOT NULL REFERENCES assessment_components(id),
  score NUMERIC(10,2) NOT NULL,
  entered_by UUID REFERENCES users(id),
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_scores_school_id ON scores (school_id);
CREATE INDEX idx_scores_student_term ON scores (student_id, term_id);

-- 15) result_status
CREATE TABLE result_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  term_id UUID NOT NULL REFERENCES terms(id),
  school_id UUID NOT NULL REFERENCES schools(id),
  status chronixedu_result_status NOT NULL DEFAULT 'draft',
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_result_status_school_id ON result_status (school_id);
CREATE INDEX idx_result_status_student_term ON result_status (student_id, term_id);

-- 16) audit_logs
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id),
  user_id UUID REFERENCES users(id),
  action_type TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_school_id ON audit_logs (school_id);

-- Row Level Security policies for tenant isolation

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY schools_tenant_isolation ON schools
  FOR ALL
  USING (id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE school_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY school_settings_tenant_isolation ON school_settings
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE academic_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY academic_sessions_tenant_isolation ON academic_sessions
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY terms_tenant_isolation ON terms
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
CREATE POLICY classes_tenant_isolation ON classes
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY subjects_tenant_isolation ON subjects
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  FOR ALL
  USING (
    school_id = (auth.jwt() ->> 'school_id')::uuid
    OR id = auth.uid()
  )
  WITH CHECK (
    school_id = (auth.jwt() ->> 'school_id')::uuid
    OR id = auth.uid()
  );

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
CREATE POLICY students_tenant_isolation ON students
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE parent_students ENABLE ROW LEVEL SECURITY;
CREATE POLICY parent_students_tenant_isolation ON parent_students
  FOR ALL
  USING (
    parent_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM students s
      WHERE s.id = parent_students.student_id
        AND s.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  )
  WITH CHECK (
    parent_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM students s
      WHERE s.id = parent_students.student_id
        AND s.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  );

ALTER TABLE student_classes ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_classes_tenant_isolation ON student_classes
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM students s
      WHERE s.id = student_classes.student_id
        AND s.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM students s
      WHERE s.id = student_classes.student_id
        AND s.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  );

ALTER TABLE teacher_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY teacher_assignments_tenant_isolation ON teacher_assignments
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE assessment_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_configs_tenant_isolation ON assessment_configs
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE assessment_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_components_tenant_isolation ON assessment_components
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM assessment_configs ac
      WHERE ac.id = assessment_components.config_id
        AND ac.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assessment_configs ac
      WHERE ac.id = assessment_components.config_id
        AND ac.school_id = (auth.jwt() ->> 'school_id')::uuid
    )
  );

ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY scores_tenant_isolation ON scores
  FOR SELECT
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid);
CREATE POLICY scores_school_write ON scores
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

ALTER TABLE result_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY result_status_tenant_isolation ON result_status
  FOR ALL
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);
CREATE POLICY result_status_approval_restrictions ON result_status
  FOR UPDATE
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid)
  WITH CHECK (
    (status NOT IN ('approved', 'published'))
    OR (auth.jwt() ->> 'role') IN ('principal', 'super_admin')
  );

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  FOR SELECT
  USING (school_id = (auth.jwt() ->> 'school_id')::uuid);
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT
  WITH CHECK (school_id = (auth.jwt() ->> 'school_id')::uuid);

COMMIT;
