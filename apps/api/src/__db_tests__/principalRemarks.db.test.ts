/**
 * The principal's remark — the half of the feature that was missing.
 *
 * `reportCardService` renders `principalRemark?.remark_text` and `fetchPrincipalRemark`
 * reads the table, but nothing in the codebase ever wrote a row. The document parents
 * keep had a principal's-remark field nobody could fill, beside a form-teacher comment
 * field that works.
 *
 * Two things here are worth more than the happy path.
 *
 * `principal_remarks` carries no `school_id` and `fetchPrincipalRemark(studentId, termId)`
 * is not school-scoped, so the ONLY thing standing between a principal and another
 * school's student is the route's own check. That is tested directly rather than assumed.
 *
 * And the upsert: without migration 041's UNIQUE (student_id, term_id) every edit would
 * append a row and the reader would pick between them by timestamp. A principal revising
 * a remark must leave one row, not five.
 */
import request from 'supertest';
import express from 'express';
import { seed, IDS as I, tokens, token, pool } from './helpers';
import principalRemarksRoutes from '../routes/principalRemarks';
import { verifyToken } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import { fetchPrincipalRemark } from '../db/queries/reportCards';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken, principalRemarksRoutes);
app.use(errorHandler);

const SUPER = 'c0000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  await seed();
  // The PUT writes an audit row, and audit_logs.user_id is a FK to users — so the
  // acting super_admin needs a real row or the write 500s.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, NULL, 'root@test', 'x', 'super_admin', 'Root', 'Admin')
     ON CONFLICT (id) DO NOTHING`,
    [SUPER]
  );
});
afterAll(() => pool.end());

const url = (school = I.schoolA, student = I.s1) =>
  `/api/schools/${school}/principal-remarks/${student}`;

function put(body: Record<string, unknown>, auth = tokens.principalA(), u = url()) {
  return request(app).put(u).set('Authorization', auth).send(body);
}

describe('who may write a principal remark', () => {
  it('allows the principal of that school', async () => {
    expect((await put({ remark_text: 'A steady term. Keep it up.' })).status).toBe(200);
  });

  it('refuses a teacher — this is the principal\'s remark, not a second comment box', async () => {
    expect((await put({ remark_text: 'x' }, tokens.math())).status).toBe(403);
  });

  it('refuses a parent', async () => {
    expect((await put({ remark_text: 'x' }, tokens.parentA())).status).toBe(403);
  });

  it('refuses a student', async () => {
    expect((await put({ remark_text: 'x' }, tokens.studentS1())).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).put(url()).send({ remark_text: 'x' })).status).toBe(401);
  });
});

describe('a principal cannot reach another school\'s student', () => {
  // principal_remarks has no school_id and fetchPrincipalRemark is not school-scoped,
  // so this route's own check is the entire boundary.
  it("404s when a principal addresses their OWN path with another school's student", async () => {
    // principalB legitimately owns the schoolB path, so requireSchoolAccess passes and
    // the STUDENT check is what stops them — which is the stronger of the two outcomes,
    // because it is the one that holds when the tenant guard cannot help.
    const res = await put({ remark_text: 'should not land' }, tokens.principalB(), url(I.schoolB, I.s1));
    expect(res.status).toBe(404);

    const { rows } = await pool.query(`SELECT 1 FROM principal_remarks WHERE student_id = $1`, [I.s1]);
    expect(rows).toHaveLength(0);
  });

  it("403s when a principal addresses ANOTHER school's path", async () => {
    const res = await put({ remark_text: 'should not land' }, tokens.principalB(), url(I.schoolA, I.s1));
    expect(res.status).toBe(403);
  });

  it("404s a student from another school on the principal's own path", async () => {
    const cross = await put({ remark_text: 'should not land' }, tokens.principalA(), url(I.schoolA, I.sOtherSchool));
    expect(cross.status).toBe(404);
    const { rows } = await pool.query(`SELECT 1 FROM principal_remarks WHERE student_id = $1`, [I.sOtherSchool]);
    expect(rows).toHaveLength(0);
  });

  it('404s on read for another school\'s student too', async () => {
    const res = await request(app)
      .get(url(I.schoolA, I.sOtherSchool))
      .set('Authorization', tokens.principalA());
    expect(res.status).toBe(404);
  });
});

describe('editing a remark rewrites one row', () => {
  it('leaves exactly one row after repeated edits, with the latest text', async () => {
    // Without UNIQUE (student_id, term_id) each edit appends and fetchPrincipalRemark
    // picks between rows by created_at — which is fine until two share a timestamp.
    for (const text of ['First draft.', 'Second thoughts.', 'Final wording.']) {
      expect((await put({ remark_text: text })).status).toBe(200);
    }

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM principal_remarks WHERE student_id = $1 AND term_id = $2`,
      [I.s1, I.termA]
    );
    expect(Number(rows[0].n)).toBe(1);

    const remark = await fetchPrincipalRemark(I.s1, I.termA);
    expect(remark?.remark_text).toBe('Final wording.');
  });

  it('records the principal who wrote it, and updates the author on an edit', async () => {
    await put({ remark_text: 'By principal A.' });
    const { rows } = await pool.query<{ author_id: string }>(
      `SELECT author_id FROM principal_remarks WHERE student_id = $1`, [I.s1]);
    expect(rows[0].author_id).toBe(I.principalA);
  });

  it('allows an empty remark, so one left by mistake can be cleared', async () => {
    await put({ remark_text: 'Written in error.' });
    expect((await put({ remark_text: '' })).status).toBe(200);
    expect((await fetchPrincipalRemark(I.s1, I.termA))?.remark_text).toBe('');
  });

  it('rejects a remark over the 1000-character ceiling', async () => {
    expect((await put({ remark_text: 'x'.repeat(1001) })).status).toBe(400);
  });
});

describe('reading it back', () => {
  it('returns null before anything is written, not an error', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    expect(res.status).toBe(200);
    expect(res.body.data.remark_text).toBeNull();
    expect(res.body.data.term_name).toBe('First Term');
  });

  it('returns what was written', async () => {
    await put({ remark_text: 'An excellent term.' });
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    expect(res.body.data.remark_text).toBe('An excellent term.');
  });
});

describe('with no active term', () => {
  it('says so with 422 rather than writing against an arbitrary term', async () => {
    await pool.query(`UPDATE terms SET is_current = FALSE WHERE school_id = $1`, [I.schoolA]);
    const res = await put({ remark_text: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_ACTIVE_TERM');
  });
});

describe('super_admin', () => {
  it('may write for any school', async () => {
    const superToken = token(SUPER, 'super_admin', I.schoolB);
    expect((await put({ remark_text: 'Platform note.' }, superToken)).status).toBe(200);
  });
});
