/**
 * seed-child-prime.js
 * Wipes all test data and seeds a complete realistic Child Prime school.
 * Run from repo root: node apps/api/scripts/seed-child-prime.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const DB_URL = process.env.DATABASE_URL;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ADMIN_PWD  = 'RealTech2018$';
const SCHOOL_PWD = 'ChildPrime@2026';

// ── Account definitions ──────────────────────────────────────────────────────

const PLATFORM_ADMIN = { email: 'info@chronixtechnology.com', password: ADMIN_PWD, first_name: 'Chronix', last_name: 'Technology', role: 'super_admin' };

const STAFF = [
  { email: 'principal@childprime.edu.ng',    password: SCHOOL_PWD, first_name: 'Adaobi',      last_name: 'Okonkwo', role: 'principal', title: 'Mrs.' },
  { email: 'registrar@childprime.edu.ng',    password: SCHOOL_PWD, first_name: 'Emeka',        last_name: 'Nwosu',   role: 'registrar', title: 'Mr.'  },
  { email: 'bursar@childprime.edu.ng',       password: SCHOOL_PWD, first_name: 'Chidinma',     last_name: 'Eze',     role: 'bursar',    title: 'Mrs.' },
  { email: 'teacher.jss1@childprime.edu.ng', password: SCHOOL_PWD, first_name: 'Tunde',        last_name: 'Adeyemi', role: 'teacher',   title: 'Mr.',  class: 'JSS 1' },
  { email: 'teacher.jss2@childprime.edu.ng', password: SCHOOL_PWD, first_name: 'Ngozi',        last_name: 'Obi',     role: 'teacher',   title: 'Mrs.', class: 'JSS 2' },
  { email: 'teacher.jss3@childprime.edu.ng', password: SCHOOL_PWD, first_name: 'Aminu',        last_name: 'Sule',    role: 'teacher',   title: 'Mr.',  class: 'JSS 3' },
];

const PARENTS = [
  { email: 'parent.adeyemi@gmail.com', password: SCHOOL_PWD, first_name: 'Kayode', last_name: 'Adeyemi', title: 'Mr.'    },
  { email: 'parent.okafor@gmail.com',  password: SCHOOL_PWD, first_name: 'Ngozi',  last_name: 'Okafor',  title: 'Mrs.'   },
  { email: 'parent.musa@gmail.com',    password: SCHOOL_PWD, first_name: 'Sani',   last_name: 'Musa',    title: 'Alhaji' },
];

// 5 per class; parent_key → parent email
const STUDENTS = [
  // JSS 1
  { fn: 'Oluwafemi', ln: 'Adeyemi', g: 'male',   dob: '2013-03-14', cls: 'JSS 1', pk: 'parent.adeyemi@gmail.com', email: 'oluwafemi.adeyemi@childprime.edu.ng' },
  { fn: 'Sola',      ln: 'Adeyemi', g: 'female', dob: '2013-07-22', cls: 'JSS 1', pk: 'parent.adeyemi@gmail.com', email: 'sola.adeyemi@childprime.edu.ng'      },
  { fn: 'Chidera',   ln: 'Okafor',  g: 'male',   dob: '2013-11-05', cls: 'JSS 1', pk: 'parent.okafor@gmail.com',  email: 'chidera.okafor@childprime.edu.ng'    },
  { fn: 'Fatima',    ln: 'Musa',    g: 'female', dob: '2013-01-18', cls: 'JSS 1', pk: 'parent.musa@gmail.com',    email: 'fatima.musa@childprime.edu.ng'       },
  { fn: 'Abubakar',  ln: 'Musa',    g: 'male',   dob: '2013-09-30', cls: 'JSS 1', pk: 'parent.musa@gmail.com',    email: 'abubakar.musa@childprime.edu.ng'     },
  // JSS 2  — Taiwo & Kehinde deliberately tie on Mathematics
  { fn: 'Taiwo',    ln: 'Adeyemi', g: 'male',   dob: '2012-04-11', cls: 'JSS 2', pk: 'parent.adeyemi@gmail.com', email: 'taiwo.adeyemi@childprime.edu.ng'     },
  { fn: 'Kehinde',  ln: 'Adeyemi', g: 'male',   dob: '2012-04-11', cls: 'JSS 2', pk: 'parent.adeyemi@gmail.com', email: 'kehinde.adeyemi@childprime.edu.ng'   },
  { fn: 'Adaeze',   ln: 'Okafor',  g: 'female', dob: '2012-06-25', cls: 'JSS 2', pk: 'parent.okafor@gmail.com',  email: 'adaeze.okafor@childprime.edu.ng'     },
  { fn: 'Chiamaka', ln: 'Okafor',  g: 'female', dob: '2012-02-09', cls: 'JSS 2', pk: 'parent.okafor@gmail.com',  email: 'chiamaka.okafor@childprime.edu.ng'   },
  { fn: 'Yusuf',    ln: 'Musa',    g: 'male',   dob: '2012-11-17', cls: 'JSS 2', pk: 'parent.musa@gmail.com',    email: 'yusuf.musa@childprime.edu.ng'        },
  // JSS 3
  { fn: 'Bimpe',    ln: 'Adeyemi', g: 'female', dob: '2011-08-03', cls: 'JSS 3', pk: 'parent.adeyemi@gmail.com', email: 'bimpe.adeyemi@childprime.edu.ng'     },
  { fn: 'Emeka',    ln: 'Okafor',  g: 'male',   dob: '2011-05-19', cls: 'JSS 3', pk: 'parent.okafor@gmail.com',  email: 'emeka.okafor@childprime.edu.ng'      },
  { fn: 'Chukwudi', ln: 'Okafor',  g: 'male',   dob: '2011-12-28', cls: 'JSS 3', pk: 'parent.okafor@gmail.com',  email: 'chukwudi.okafor@childprime.edu.ng'   },
  { fn: 'Halima',   ln: 'Musa',    g: 'female', dob: '2011-03-07', cls: 'JSS 3', pk: 'parent.musa@gmail.com',    email: 'halima.musa@childprime.edu.ng'       },
  { fn: 'Ibrahim',  ln: 'Musa',    g: 'male',   dob: '2011-10-15', cls: 'JSS 3', pk: 'parent.musa@gmail.com',    email: 'ibrahim.musa@childprime.edu.ng'      },
];

const SUBJECTS = [
  'English Language', 'Mathematics', 'Basic Science', 'Basic Technology',
  'Social Studies', 'Civic Education', 'Christian Religious Studies',
  'French Language', 'Agricultural Science', 'Physical & Health Education',
  'Computer Studies', 'Home Economics',
];

// Scores: [ca1, ca2, midterm, exam] per subject (indices match SUBJECTS array)
// Total = ca1+ca2+midterm+exam out of 100
// JSS2 TIE: Taiwo & Kehinde both score 75 on Mathematics (index 1)
// Taiwo  Maths: 8+8+7+52 = 75   Kehinde Maths: 7+8+8+52 = 75

const RAW_SCORES = {
  // JSS 1
  'Oluwafemi Adeyemi': [[8,8,7,54],[8,7,8,52],[7,8,7,54],[8,8,8,56],[7,7,6,49],[7,8,7,51],[8,7,8,55],[6,6,5,43],[7,8,7,53],[9,8,8,58],[7,7,7,50],[7,8,7,51]],
  'Sola Adeyemi':      [[7,6,6,47],[6,6,5,42],[7,6,6,49],[7,7,6,47],[7,7,7,49],[7,6,6,47],[7,7,7,52],[5,5,5,38],[6,6,6,47],[8,7,7,53],[6,6,5,44],[7,6,6,47]],
  'Chidera Okafor':    [[9,8,8,58],[9,9,8,60],[8,8,8,56],[9,8,9,58],[8,8,7,55],[9,8,8,57],[9,9,9,62],[7,7,7,51],[8,8,8,57],[10,9,9,64],[9,8,8,59],[8,8,7,55]],
  'Fatima Musa':       [[7,7,6,49],[7,7,7,51],[7,6,6,46],[7,7,7,50],[7,6,6,48],[7,7,6,49],[7,7,7,51],[5,5,5,42],[6,6,6,46],[8,7,7,52],[7,6,6,47],[7,7,6,49]],
  'Abubakar Musa':     [[6,5,5,39],[6,5,5,41],[6,6,5,41],[6,6,5,42],[6,5,5,40],[6,5,5,41],[6,6,6,44],[5,4,4,35],[5,5,5,40],[7,6,6,47],[5,5,5,38],[6,5,5,41]],
  // JSS 2 — deliberate Maths tie between Taiwo & Kehinde (both 75 total)
  'Taiwo Adeyemi':     [[8,7,7,51],[8,8,7,52],[8,7,7,52],[8,7,7,50],[7,7,6,48],[7,7,7,51],[8,7,7,51],[6,6,5,43],[7,7,6,49],[9,8,8,57],[7,7,7,51],[7,7,7,51]],
  'Kehinde Adeyemi':   [[7,8,7,50],[7,8,8,52],[7,8,7,51],[7,8,7,50],[6,7,7,47],[7,7,6,50],[7,8,7,51],[6,5,6,42],[7,6,7,48],[8,9,8,56],[7,7,6,50],[7,7,6,50]],
  'Adaeze Okafor':     [[9,9,8,59],[9,8,9,58],[9,9,8,59],[9,9,8,58],[8,8,8,56],[9,8,9,58],[9,9,8,59],[7,7,7,52],[9,8,8,57],[10,9,9,63],[9,8,8,59],[8,9,8,58]],
  'Chiamaka Okafor':   [[7,7,7,51],[7,6,7,47],[7,7,6,49],[7,7,6,48],[6,7,6,46],[7,6,7,48],[7,7,7,50],[5,5,5,39],[6,7,6,47],[8,7,7,53],[6,6,6,46],[7,6,7,48]],
  'Yusuf Musa':        [[6,6,5,42],[6,6,6,44],[6,5,6,42],[6,6,5,41],[5,6,5,41],[6,5,6,42],[6,6,6,44],[5,4,5,36],[6,5,5,41],[7,6,6,48],[5,6,5,42],[6,5,6,42]],
  // JSS 3
  'Bimpe Adeyemi':     [[8,8,7,53],[8,8,8,54],[8,7,8,51],[8,8,8,54],[7,8,7,52],[8,7,8,53],[9,8,8,57],[6,7,6,45],[8,7,7,52],[9,9,8,59],[8,8,7,54],[8,7,8,53]],
  'Emeka Okafor':      [[9,9,9,62],[10,9,9,63],[9,9,8,60],[9,9,9,61],[9,8,9,58],[9,9,8,61],[10,9,9,64],[8,7,8,55],[9,8,9,60],[10,10,9,66],[9,9,8,61],[9,9,8,60]],
  'Chukwudi Okafor':   [[8,7,7,51],[7,7,8,50],[7,7,7,49],[8,7,7,50],[7,7,6,48],[7,7,7,50],[8,7,8,52],[6,6,6,43],[7,7,6,49],[8,8,7,55],[7,7,7,51],[7,7,7,50]],
  'Halima Musa':       [[7,7,6,47],[7,7,6,49],[7,6,6,46],[7,7,6,47],[6,7,6,46],[7,6,7,47],[7,7,7,50],[5,5,5,40],[6,6,6,46],[8,7,7,52],[7,6,6,47],[7,6,7,47]],
  'Ibrahim Musa':      [[6,6,6,43],[6,6,6,44],[6,6,5,42],[6,6,6,44],[6,5,6,42],[6,6,5,43],[7,6,6,46],[5,5,4,37],[6,5,6,41],[7,7,6,49],[6,5,6,42],[6,6,5,43]],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSupabaseUser(email, password, meta = {}) {
  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existing = (list?.users ?? []).find(u => u.email === email);
  if (existing) {
    await supabase.auth.admin.updateUserById(existing.id, { password, user_metadata: meta });
    return existing.id;
  }
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
  if (error) throw new Error(`Supabase createUser(${email}): ${error.message}`);
  return data.user.id;
}

async function hash(pwd) { return bcrypt.hashSync(pwd, 10); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // Disable triggers for entire session so weight_percent validation doesn't fire mid-insert
  await pg.query(`SET session_replication_role = replica`);
  console.log('Connected.\n');

  // ── 1. Wipe ───────────────────────────────────────────────────────────────
  console.log('Step 1 — Wiping test data...');
  // Disable triggers to bypass weight_percent validation during bulk delete
  await pg.query(`SET session_replication_role = replica`);
  await pg.query('DELETE FROM scores');
  await pg.query('DELETE FROM attendance');
  await pg.query('DELETE FROM behaviour_records');
  await pg.query('DELETE FROM class_teacher_comments');
  await pg.query('DELETE FROM report_cards');
  await pg.query('DELETE FROM result_status');
  await pg.query('DELETE FROM payments');
  await pg.query('DELETE FROM fee_invoices');
  await pg.query('DELETE FROM student_classes');
  await pg.query('DELETE FROM parent_students');
  await pg.query('DELETE FROM students');
  await pg.query('DELETE FROM teacher_assignments');
  await pg.query('DELETE FROM assessment_components');
  await pg.query('DELETE FROM assessment_configs');
  await pg.query('DELETE FROM timetable_slots');
  await pg.query(`DELETE FROM subjects`);
  await pg.query(`UPDATE classes SET form_teacher_id = NULL`);
  await pg.query(`DELETE FROM classes`);
  await pg.query('DELETE FROM terms');
  await pg.query('DELETE FROM academic_sessions');
  await pg.query('DELETE FROM fee_structures');
  await pg.query('DELETE FROM users');
  await pg.query(`DELETE FROM school_settings`);
  await pg.query(`DELETE FROM schools`);
  // Wipe all Supabase Auth users
  const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  for (const u of (authList?.users ?? [])) {
    await supabase.auth.admin.deleteUser(u.id);
  }
  console.log('  Done.\n');

  // ── 2. School ─────────────────────────────────────────────────────────────
  console.log('Step 2 — Creating Child Prime school...');
  const { rows: [school] } = await pg.query(
    `INSERT INTO schools (name, slug, is_active) VALUES ('Child Prime','child-prime',true) RETURNING id`
  );
  const SCHOOL_ID = school.id;
  await pg.query(
    `INSERT INTO school_settings (school_id, identity_config, academic_config)
     VALUES ($1,
       $2::jsonb,
       $3::jsonb
     )`,
    [
      SCHOOL_ID,
      JSON.stringify({ school_name: 'Child Prime', address: 'Lagos, Nigeria', phone: '', email: 'admin@childprime.edu.ng' }),
      JSON.stringify({
        grading_scale: [
          { label: 'A1', min: 75, max: 100, remark: 'Excellent'  },
          { label: 'B2', min: 70, max: 74,  remark: 'Very Good'  },
          { label: 'B3', min: 65, max: 69,  remark: 'Good'       },
          { label: 'C4', min: 60, max: 64,  remark: 'Credit'     },
          { label: 'C5', min: 55, max: 59,  remark: 'Credit'     },
          { label: 'C6', min: 50, max: 54,  remark: 'Credit'     },
          { label: 'D7', min: 45, max: 49,  remark: 'Pass'       },
          { label: 'E8', min: 40, max: 44,  remark: 'Pass'       },
          { label: 'F9', min: 0,  max: 39,  remark: 'Fail'       },
        ],
      }),
    ]
  );
  console.log(`  School ID: ${SCHOOL_ID}\n`);

  // ── 3. Academic structure ─────────────────────────────────────────────────
  console.log('Step 3 — Academic structure...');
  const { rows: [session] } = await pg.query(
    `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current) VALUES ($1,'2025/2026','2025-09-01','2026-07-31',true) RETURNING id`,
    [SCHOOL_ID]
  );
  const SESSION_ID = session.id;

  const { rows: [term] } = await pg.query(
    `INSERT INTO terms (school_id, session_id, name, start_date, end_date, is_current) VALUES ($1,$2,'First Term','2025-09-08','2025-12-19',true) RETURNING id`,
    [SCHOOL_ID, SESSION_ID]
  );
  const TERM_ID = term.id;

  // Classes
  const classIds = {};
  for (const name of ['JSS 1', 'JSS 2', 'JSS 3']) {
    const { rows: [cls] } = await pg.query(
      `INSERT INTO classes (school_id, name, level) VALUES ($1,$2,$2) RETURNING id`,
      [SCHOOL_ID, name]
    );
    classIds[name] = cls.id;
  }

  // Subjects
  const subjectCodes = { 'English Language': 'ENG', 'Mathematics': 'MTH', 'Basic Science': 'BSC', 'Basic Technology': 'BTC', 'Social Studies': 'SST', 'Civic Education': 'CVE', 'Christian Religious Studies': 'CRS', 'French Language': 'FRN', 'Agricultural Science': 'AGR', 'Physical & Health Education': 'PHE', 'Computer Studies': 'CST', 'Home Economics': 'HEC' };
  const subjectIds = {};
  for (const name of SUBJECTS) {
    const { rows: [subj] } = await pg.query(
      `INSERT INTO subjects (school_id, name, code, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [SCHOOL_ID, name, subjectCodes[name] ?? name.substring(0, 3).toUpperCase()]
    );
    subjectIds[name] = subj.id;
  }

  // Assessment config: one config PER SUBJECT (unique constraint on scores is per component_id,
  // so each subject needs its own CA1/CA2/Mid-Term/Exam component IDs)
  const compDefs = [
    { name: 'CA1',      max_score: 10, weight_percent: 10, display_order: 1 },
    { name: 'CA2',      max_score: 10, weight_percent: 10, display_order: 2 },
    { name: 'Mid-Term', max_score: 10, weight_percent: 10, display_order: 3 },
    { name: 'Exam',     max_score: 70, weight_percent: 70, display_order: 4 },
  ];
  // componentIds[subjectName][compName] = uuid
  const componentIds = {};
  for (const subjectName of SUBJECTS) {
    const { rows: [cfg] } = await pg.query(
      `INSERT INTO assessment_configs (school_id, term_id, subject_id, is_default) VALUES ($1,$2,$3,false) RETURNING id`,
      [SCHOOL_ID, TERM_ID, subjectIds[subjectName]]
    );
    componentIds[subjectName] = {};
    for (const comp of compDefs) {
      const { rows: [c] } = await pg.query(
        `INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [cfg.id, comp.name, comp.max_score, comp.weight_percent, comp.display_order]
      );
      componentIds[subjectName][comp.name] = c.id;
    }
  }

  // Fee structures
  const feeAmounts = { 'JSS 1': 45000, 'JSS 2': 45000, 'JSS 3': 50000 };
  const feeComponents = ['School Fees', 'PTA Levy', 'Development Levy'];
  const feeRatios = [0.80, 0.10, 0.10];
  const feeStructuresByClass = {};
  for (const [className, total] of Object.entries(feeAmounts)) {
    feeStructuresByClass[className] = total;
    for (let i = 0; i < feeComponents.length; i++) {
      await pg.query(
        `INSERT INTO fee_structures (school_id, class_id, term_id, component_name, amount, is_mandatory) VALUES ($1,$2,$3,$4,$5,true)`,
        [SCHOOL_ID, classIds[className], TERM_ID, feeComponents[i], Math.round(total * feeRatios[i])]
      );
    }
  }
  console.log('  Academic structure done.\n');

  // ── 4. Platform admin ─────────────────────────────────────────────────────
  console.log('Step 4 — Platform admin...');
  const adminUid = await upsertSupabaseUser(PLATFORM_ADMIN.email, PLATFORM_ADMIN.password, { first_name: PLATFORM_ADMIN.first_name, last_name: PLATFORM_ADMIN.last_name, role: 'super_admin' });
  await pg.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name) VALUES ($1,NULL,$2,$3,'super_admin',$4,$5)`,
    [adminUid, PLATFORM_ADMIN.email, await hash(PLATFORM_ADMIN.password), PLATFORM_ADMIN.first_name, PLATFORM_ADMIN.last_name]
  );
  console.log(`  ${PLATFORM_ADMIN.email}\n`);

  // ── 5. Staff ──────────────────────────────────────────────────────────────
  console.log('Step 5 — Staff...');
  const staffIds = {};
  for (const s of STAFF) {
    const uid = await upsertSupabaseUser(s.email, s.password, { first_name: s.first_name, last_name: s.last_name, role: s.role, school_id: SCHOOL_ID });
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uid, SCHOOL_ID, s.email, await hash(s.password), s.role, s.first_name, s.last_name, s.title ?? null]
    );
    staffIds[s.email] = uid;
    // Set form teacher on class
    if (s.class) {
      await pg.query(`UPDATE classes SET form_teacher_id = $1 WHERE id = $2`, [uid, classIds[s.class]]);
    }
    console.log(`  ${s.role}: ${s.first_name} ${s.last_name}`);
  }

  // Assign each class teacher to all subjects in their class for this term
  for (const s of STAFF.filter(x => x.class)) {
    const classId = classIds[s.class];
    const teacherId = staffIds[s.email];
    for (const subjectId of Object.values(subjectIds)) {
      await pg.query(
        `INSERT INTO teacher_assignments (school_id, class_id, subject_id, teacher_id, term_id) VALUES ($1,$2,$3,$4,$5)`,
        [SCHOOL_ID, classId, subjectId, teacherId, TERM_ID]
      );
    }
  }
  console.log('  Teacher assignments done.\n');

  // ── 6. Parents ────────────────────────────────────────────────────────────
  console.log('Step 6 — Parents...');
  const parentIds = {};
  for (const p of PARENTS) {
    const uid = await upsertSupabaseUser(p.email, p.password, { first_name: p.first_name, last_name: p.last_name, role: 'parent', school_id: SCHOOL_ID });
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title) VALUES ($1,$2,$3,$4,'parent',$5,$6,$7)`,
      [uid, SCHOOL_ID, p.email, await hash(p.password), p.first_name, p.last_name, p.title ?? null]
    );
    parentIds[p.email] = uid;
    console.log(`  Parent: ${p.first_name} ${p.last_name} (${p.email})`);
  }
  console.log();

  // ── 7. Students ───────────────────────────────────────────────────────────
  console.log('Step 7 — Students...');
  const studentIds = {}; // key: "Firstname Lastname"
  let counter = 1;

  for (const s of STUDENTS) {
    const uid = await upsertSupabaseUser(s.email, SCHOOL_PWD, { first_name: s.fn, last_name: s.ln, role: 'student', school_id: SCHOOL_ID });
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name) VALUES ($1,$2,$3,$4,'student',$5,$6)`,
      [uid, SCHOOL_ID, s.email, await hash(SCHOOL_PWD), s.fn, s.ln]
    );

    const admNo = `CP/2025/${String(counter++).padStart(3, '0')}`;
    const { rows: [stu] } = await pg.query(
      `INSERT INTO students (school_id, user_id, admission_no, dob, gender) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [SCHOOL_ID, uid, admNo, s.dob, s.g]
    );
    const studentId = stu.id;
    studentIds[`${s.fn} ${s.ln}`] = studentId;

    // Enroll in class
    await pg.query(
      `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1,$2,$3)`,
      [studentId, classIds[s.cls], SESSION_ID]
    );

    // Link parent
    await pg.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact) VALUES ($1,$2,'parent',true)`,
      [parentIds[s.pk], studentId]
    );

    console.log(`  ${s.cls}: ${s.fn} ${s.ln} [${admNo}]`);
  }
  console.log();

  // ── 8. Fee invoices ───────────────────────────────────────────────────────
  console.log('Step 8 — Fee invoices...');
  // Students whose fees are fully paid (testing outstanding view)
  const paidSet = new Set(['Oluwafemi Adeyemi', 'Chidera Okafor', 'Adaeze Okafor', 'Emeka Okafor', 'Bimpe Adeyemi']);
  for (const s of STUDENTS) {
    const key = `${s.fn} ${s.ln}`;
    const studentId = studentIds[key];
    const total = feeStructuresByClass[s.cls];
    const paid = paidSet.has(key) ? total : 0;
    const status = paidSet.has(key) ? 'paid' : 'unpaid';
    await pg.query(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [SCHOOL_ID, studentId, TERM_ID, total, paid, total - paid, status]
    );
  }
  console.log('  5 paid, 10 outstanding.\n');

  // ── 9. Scores ────────────────────────────────────────────────────────────
  console.log('Step 9 — Entering scores...');
  const principalId = staffIds['principal@childprime.edu.ng'];

  for (const [studentName, subjectScores] of Object.entries(RAW_SCORES)) {
    const studentId = studentIds[studentName];
    if (!studentId) { console.warn(`  WARN: no student found for "${studentName}"`); continue; }

    for (let si = 0; si < SUBJECTS.length; si++) {
      const subjectName = SUBJECTS[si];
      const subjectId = subjectIds[subjectName];
      const [ca1, ca2, mid, exam] = subjectScores[si];
      const comps = componentIds[subjectName];

      for (const [compName, score] of [['CA1', ca1], ['CA2', ca2], ['Mid-Term', mid], ['Exam', exam]]) {
        await pg.query(
          `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score, entered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (student_id, term_id, component_id) DO UPDATE SET score=$6`,
          [SCHOOL_ID, studentId, subjectId, TERM_ID, comps[compName], score, principalId]
        );
      }
    }
    console.log(`  Scores entered: ${studentName}`);
  }

  await pg.query(`SET session_replication_role = DEFAULT`);
  await pg.end();
  console.log('\n✅  Seed complete!\n');
  console.log('══════════════════════════════════════════════════════');
  console.log(' LOGIN CREDENTIALS');
  console.log('══════════════════════════════════════════════════════');
  console.log(` Platform Admin  │ info@chronixtechnology.com       │ RealTech2018$`);
  console.log(` Principal       │ principal@childprime.edu.ng      │ ChildPrime@2026`);
  console.log(` Registrar       │ registrar@childprime.edu.ng      │ ChildPrime@2026`);
  console.log(` Bursar          │ bursar@childprime.edu.ng         │ ChildPrime@2026`);
  console.log(` Teacher JSS 1   │ teacher.jss1@childprime.edu.ng   │ ChildPrime@2026`);
  console.log(` Teacher JSS 2   │ teacher.jss2@childprime.edu.ng   │ ChildPrime@2026`);
  console.log(` Teacher JSS 3   │ teacher.jss3@childprime.edu.ng   │ ChildPrime@2026`);
  console.log(` Parent Adeyemi  │ parent.adeyemi@gmail.com         │ ChildPrime@2026`);
  console.log(` Parent Okafor   │ parent.okafor@gmail.com          │ ChildPrime@2026`);
  console.log(` Parent Musa     │ parent.musa@gmail.com            │ ChildPrime@2026`);
  console.log(` Students        │ e.g. taiwo.adeyemi@childprime... │ ChildPrime@2026`);
  console.log('──────────────────────────────────────────────────────');
  console.log(' JSS 2 TIE: Taiwo & Kehinde Adeyemi both score 75 on Mathematics');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌  SEED FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
