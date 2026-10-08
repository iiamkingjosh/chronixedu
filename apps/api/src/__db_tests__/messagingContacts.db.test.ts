/**
 * Who may message whom (audit, 8 Oct 2026).
 *
 * - A student could message their teacher, and the teacher could not answer: a teacher's
 *   contacts were parents, principals and teachers, never students (Fix first 2).
 * - A reply carrying a `thread_id` checked only that the SENDER was in the thread. Its
 *   recipient could be anyone in the sender's contacts, and once a message to them was in the
 *   thread they could read all of it. A teacher answering a student could pull the student's
 *   parent, or anyone else, into the student's conversation.
 * - Contacts read teacher assignments of any term, kept deactivated staff, and left out the
 *   form teacher, who teaches the class but may have no assignment row.
 *
 * Every refusal below is preceded by the same sender succeeding with an allowed recipient, so
 * a 403 means the rule and not a route that refuses everything (doctrine 16).
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import messagesRoutes from '../routes/messages';
import { seed, token, tokens, IDS as I, pool } from './helpers';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, messagesRoutes);
app.use(errorHandler);

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const base = `/api/schools/${I.schoolA}/messages`;

const S3_USER = '39000000-0000-4000-8000-000000000003';   // s3OtherClass's login (SSS 1B, no teacher of ours)
const FORM_TEACHER = '30000000-0000-4000-8000-000000000071';
const LAST_TERM_TEACHER = '30000000-0000-4000-8000-000000000072';
const OLD_STUDENT = '60000000-0000-4000-8000-000000000071';
const OLD_STUDENT_USER = '39000000-0000-4000-8000-000000000071';
const OLD_SESSION = '10000000-0000-4000-8000-000000000071';
const OTHER_TERM = '20000000-0000-4000-8000-000000000071';

const send = (tok: string, body: Record<string, unknown>) => request(app).post(base).set('Authorization', tok).send(body);
const contactIds = async (tok: string): Promise<string[]> => {
  const res = await request(app).get(`${base}/contacts`).set('Authorization', tok);
  expect(res.status).toBe(200);
  return res.body.data.map((c: { id: string }) => c.id);
};

beforeEach(async () => {
  await seed();
  const user = (id: string, role: string, first: string) => owner.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, $3, 'x', $4, $5, 'Test', true, 'subject', false)`, [id, I.schoolA, `${id}@test`, role, first]);
  // JSS 2A's form teacher, with no assignment row.
  await user(FORM_TEACHER, 'teacher', 'Form');
  await owner.query(`UPDATE classes SET form_teacher_id = $1 WHERE id = $2`, [FORM_TEACHER, I.jss2a]);
  // A teacher of JSS 2A in a term that is not the current one.
  await user(LAST_TERM_TEACHER, 'teacher', 'Former');
  await owner.query(
    `INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
     VALUES ($1, $2, $3, 'Second Term', '2027-01-05', '2027-04-02', false)`, [OTHER_TERM, I.sessionA, I.schoolA]);
  await owner.query(
    `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1, $2, $3, $4, $5)`,
    [LAST_TERM_TEACHER, I.jss2a, I.math, OTHER_TERM, I.schoolA]);
  // A student who was in JSS 2A last session only.
  await user(OLD_STUDENT_USER, 'student', 'Old');
  await owner.query(`INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, $3, 'ADM-71')`, [OLD_STUDENT, I.schoolA, OLD_STUDENT_USER]);
  await owner.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1, $2, '2025/2026', '2025-09-01', '2026-07-31', false)`, [OLD_SESSION, I.schoolA]);
  await owner.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [OLD_STUDENT, I.jss2a, OLD_SESSION]);
});

afterAll(async () => { await pool.end(); await owner.end(); });

describe('a teacher answering a student', () => {
  it('a student messages their teacher, and the teacher can reply', async () => {
    const asked = await send(tokens.studentS1(), { recipient_id: I.mathTeacher, body: 'Is the test on Friday?' });
    expect(asked.status).toBe(201);

    const reply = await send(tokens.math(), { recipient_id: I.s1User, body: 'Yes, Friday.', thread_id: asked.body.data.thread_id });
    expect(reply.status).toBe(201);
    expect(reply.body.data.thread_id).toBe(asked.body.data.thread_id);
  });

  it("a teacher's students are those in a class they teach this session, and no one else", async () => {
    const ids = await contactIds(tokens.math());
    expect(ids).toEqual(expect.arrayContaining([I.s1User, '39000000-0000-4000-8000-000000000002', I.parentA]));
    expect(ids).not.toContain(S3_USER);          // a class they do not teach
    expect(ids).not.toContain(OLD_STUDENT_USER); // their class, but last session

    const refused = await send(tokens.math(), { recipient_id: S3_USER, body: 'Hello' });
    expect(refused.status).toBe(403);
  });

  it('the form teacher can message the class and its parents, and they can message the form teacher', async () => {
    const formTok = token(FORM_TEACHER, 'teacher', I.schoolA);
    expect(await contactIds(formTok)).toEqual(expect.arrayContaining([I.s1User, I.parentA]));
    expect(await contactIds(tokens.parentA())).toContain(FORM_TEACHER);
    expect(await contactIds(tokens.studentS1())).toContain(FORM_TEACHER);
  });
});

describe('a reply stays between the people in its thread', () => {
  it('cannot be addressed to someone outside the thread, who then cannot read it', async () => {
    const asked = await send(tokens.studentS1(), { recipient_id: I.mathTeacher, body: 'Something private' });
    expect(asked.status).toBe(201);
    const thread = asked.body.data.thread_id;

    // parentA is a valid contact of the teacher, but not part of this conversation.
    const pulledIn = await send(tokens.math(), { recipient_id: I.parentA, body: 'Looping you in', thread_id: thread });
    expect(pulledIn.status).toBe(403);
    expect(pulledIn.body.error.code).toBe('NOT_IN_THREAD');

    const read = await request(app).get(`${base}/thread/${thread}`).set('Authorization', tokens.parentA());
    expect(read.status).toBe(403);

    // The same teacher may still message the parent in a conversation of their own.
    const fresh = await send(tokens.math(), { recipient_id: I.parentA, body: 'A separate note' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.thread_id).not.toBe(thread);
  });
});

describe('contacts are this term and active people', () => {
  it("a parent's and a student's teachers are this term's, active, with the form teacher", async () => {
    await owner.query(`UPDATE users SET is_active = false WHERE id = $1`, [I.engTeacher]);

    for (const tok of [tokens.parentA(), tokens.studentS1()]) {
      const ids = await contactIds(tok);
      expect(ids).toEqual(expect.arrayContaining([I.mathTeacher, FORM_TEACHER, I.principalA]));
      expect(ids).not.toContain(LAST_TERM_TEACHER);
      expect(ids).not.toContain(I.engTeacher);
    }
    const refused = await send(tokens.parentA(), { recipient_id: LAST_TERM_TEACHER, body: 'Hello' });
    expect(refused.status).toBe(403);
  });
});
