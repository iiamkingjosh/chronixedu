import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

import { Client } from 'pg';

const SCHOOL_ID   = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID    = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID  = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';
const SESSION_ID  = 'e3e62132-16e4-4c1c-ad8b-9118579323c5';
const TERM_ID     = '3df9f000-f173-4307-a986-64516372c2a0';
const SUBJECT_ID  = '9ddb5e1d-c3ce-4205-ad0e-9ec584656e2d';
const FATIMA_ID   = '483dc14c-b865-45eb-99f9-fde8b2dbf16e';
const FATIMA_USER = 'ffffffff-0000-0000-0000-000000000001';

export default async function globalTeardown(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Delete in FK-safe order (children before parents).
    // Each DELETE is best-effort: we ignore errors if other test data still references these rows.
    await client.query(`DELETE FROM students        WHERE id = $1`,          [FATIMA_ID]).catch(() => {});
    await client.query(`DELETE FROM users           WHERE id = $1`,          [FATIMA_USER]).catch(() => {});
    await client.query(`DELETE FROM terms           WHERE id = $1`,          [TERM_ID]).catch(() => {});
    await client.query(`DELETE FROM academic_sessions WHERE id = $1`,        [SESSION_ID]).catch(() => {});
    await client.query(`DELETE FROM subjects        WHERE id = $1`,          [SUBJECT_ID]).catch(() => {});
    await client.query(`DELETE FROM classes         WHERE id = $1`,          [CLASS_ID]).catch(() => {});
    await client.query(`DELETE FROM users           WHERE id = $1`,          [TEACHER_ID]).catch(() => {});
    await client.query(`DELETE FROM school_settings WHERE school_id = $1`,   [SCHOOL_ID]).catch(() => {});
    await client.query(`DELETE FROM schools         WHERE id = $1`,          [SCHOOL_ID]).catch(() => {});
  } finally {
    await client.end();
  }
}
