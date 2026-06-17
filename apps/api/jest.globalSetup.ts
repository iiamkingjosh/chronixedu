import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

import { Client } from 'pg';

// These fixture IDs are hardcoded across all integration tests.
// They must exist in the database before tests run.
const SCHOOL_ID   = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID    = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID  = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';
const SESSION_ID  = 'e3e62132-16e4-4c1c-ad8b-9118579323c5';
const TERM_ID     = '3df9f000-f173-4307-a986-64516372c2a0';
const SUBJECT_ID  = '9ddb5e1d-c3ce-4205-ad0e-9ec584656e2d';
const FATIMA_ID   = '483dc14c-b865-45eb-99f9-fde8b2dbf16e';
const FATIMA_USER = 'ffffffff-0000-0000-0000-000000000001';

export default async function globalSetup(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 1. School
    await client.query(
      `INSERT INTO schools (id, name, slug, is_active)
       VALUES ($1, 'Integration Test School', 'integration-test-school', true)
       ON CONFLICT DO NOTHING`,
      [SCHOOL_ID]
    );

    // 2. School settings (required by any route that reads academic/notification config)
    await client.query(
      `INSERT INTO school_settings (school_id, identity_config, academic_config, notification_config, report_config)
       VALUES (
         $1,
         '{"name":"Integration Test School","motto":"","logo_url":null,"stamp_url":null,"primary_colour":null,"secondary_colour":null}'::jsonb,
         '{"promotion_cutoff":40,"grading_scale":[{"grade":"A","min":70,"max":100,"label":"Excellent","remark":""},{"grade":"B","min":60,"max":69,"label":"Very Good","remark":""},{"grade":"C","min":50,"max":59,"label":"Good","remark":""},{"grade":"D","min":40,"max":49,"label":"Pass","remark":""},{"grade":"F","min":0,"max":39,"label":"Fail","remark":""}],"assessment_components":[{"name":"CA1","max_score":10,"weight":10,"display_order":1},{"name":"CA2","max_score":10,"weight":10,"display_order":2},{"name":"Mid-Term","max_score":10,"weight":10,"display_order":3},{"name":"Exam","max_score":70,"weight":70,"display_order":4}]}'::jsonb,
         '{}'::jsonb,
         '{"template":"classic","show_attendance":true}'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [SCHOOL_ID]
    );

    // 3. Teacher user (needed as FK for attendance, assignments, etc.)
    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode)
       VALUES ($1, $2, 'teacher.math@chronixedu-test.com', 'test-hash', 'teacher', 'Math', 'Teacher', true, 'subject')
       ON CONFLICT DO NOTHING`,
      [TEACHER_ID, SCHOOL_ID]
    );

    // 4. Class (needed as FK for attendance, assignments, student enrollment, etc.)
    await client.query(
      `INSERT INTO classes (id, school_id, name, level, stream, form_teacher_id)
       VALUES ($1, $2, 'JSS 1A', 'Junior', null, null)
       ON CONFLICT DO NOTHING`,
      [CLASS_ID, SCHOOL_ID]
    );

    // 5. Academic session (required by student_classes FK + active-term lookup)
    await client.query(
      `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, '2025/2026 Academic Year', '2025-08-31', '2026-06-30', true)
       ON CONFLICT DO NOTHING`,
      [SESSION_ID, SCHOOL_ID]
    );

    // 6. First Term (covers 2025-08-31..2025-12-20 — used by attendance + behaviour routes)
    //    is_current=true so getActiveTerm() returns this term
    await client.query(
      `INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, $3, 'First Term', '2025-08-31', '2025-12-20', true)
       ON CONFLICT DO NOTHING`,
      [TERM_ID, SESSION_ID, SCHOOL_ID]
    );

    // 7. Mathematics subject (SUBJECT_ID = MATH_ID used in assignments + resultEngine)
    await client.query(
      `INSERT INTO subjects (id, school_id, name, code)
       VALUES ($1, $2, 'Mathematics', 'MATH')
       ON CONFLICT DO NOTHING`,
      [SUBJECT_ID, SCHOOL_ID]
    );

    // 8. Fatima user + student (FATIMA_ID used in offlineSync to mark attendance)
    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode)
       VALUES ($1, $2, 'fatima.test@chronixedu-test.com', 'test-hash', 'student', 'Fatima', 'Test', true, 'subject')
       ON CONFLICT DO NOTHING`,
      [FATIMA_USER, SCHOOL_ID]
    );
    await client.query(
      `INSERT INTO students (id, school_id, user_id, admission_no)
       VALUES ($1, $2, $3, 'TEST-FATIMA-001')
       ON CONFLICT DO NOTHING`,
      [FATIMA_ID, SCHOOL_ID, FATIMA_USER]
    );
  } finally {
    await client.end();
  }
}
