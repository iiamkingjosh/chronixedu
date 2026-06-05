const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbUrl = process.env.DATABASE_URL;
const isDatabaseAvailable = Boolean(dbUrl);

const ids = {
  schoolA: crypto.randomUUID(),
  schoolB: crypto.randomUUID(),
  userA: crypto.randomUUID(),
  userB: crypto.randomUUID(),
  studentA: crypto.randomUUID(),
  studentB: crypto.randomUUID()
};

if (!isDatabaseAvailable) {
  test('RLS migration file includes tenant isolation policies and authorisation helpers', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_create_chronix_edu_schema.sql'), 'utf8');
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY .*students_tenant_isolation/);
    expect(sql).toMatch(/CREATE POLICY .*result_status_approval_restrictions/);
    expect(sql).toMatch(/auth\.jwt\(\)/);
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS auth/);
  });
} else {
  const { Client } = require('pg');
  const connectionString = dbUrl;
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO schools (id, name, slug, email, is_active) VALUES
        ($1, $2, $3, $4, TRUE),
        ($5, $6, $7, $8, TRUE)`,
      [
        ids.schoolA,
        'School A',
        `school-a-${ids.schoolA.slice(0, 8)}`,
        'a@example.com',
        ids.schoolB,
        'School B',
        `school-b-${ids.schoolB.slice(0, 8)}`,
        'b@example.com'
      ]
    );

    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, teacher_mode, is_active)
       VALUES
        ($1, $2, $3, $4, 'student', 'Student', 'A', 'subject', TRUE),
        ($5, $6, $7, $8, 'student', 'Student', 'B', 'subject', TRUE)`,
      [
        ids.userA,
        ids.schoolA,
        'student.a@example.com',
        'hash-a',
        ids.userB,
        ids.schoolB,
        'student.b@example.com',
        'hash-b'
      ]
    );

    await client.query(
      `INSERT INTO students (id, school_id, user_id, admission_no)
       VALUES
        ($1, $2, $3, $4),
        ($5, $6, $7, $8)`,
      [
        ids.studentA,
        ids.schoolA,
        ids.userA,
        `ADM-A-${ids.studentA.slice(0, 8)}`,
        ids.studentB,
        ids.schoolB,
        ids.userB,
        `ADM-B-${ids.studentB.slice(0, 8)}`
      ]
    );

    await client.query('COMMIT');
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('BEGIN');
    await client.query('DELETE FROM students WHERE id = ANY($1)', [[ids.studentA, ids.studentB]]);
    await client.query('DELETE FROM users WHERE id = ANY($1)', [[ids.userA, ids.userB]]);
    await client.query('DELETE FROM schools WHERE id = ANY($1)', [[ids.schoolA, ids.schoolB]]);
    await client.query('COMMIT');
    await client.end();
  });

  test('School B JWT cannot read School A student data under RLS', async () => {
    await client.query('BEGIN');
    await client.query('SET LOCAL jwt.claims = $1', [
      JSON.stringify({
        sub: ids.userB,
        school_id: ids.schoolB,
        role: 'student'
      })
    ]);

    const result = await client.query('SELECT id, school_id, admission_no FROM students WHERE id = $1', [ids.studentA]);
    await client.query('ROLLBACK');

    expect(result.rows).toHaveLength(0);
  });
}
