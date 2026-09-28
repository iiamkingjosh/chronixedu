/**
 * The notices write path.
 *
 * `notices` had a read path (`GET /:schoolId/student/notices`) and nothing that ever
 * wrote a row — the student-facing board could only ever be empty.
 *
 * The guard that matters here is NOT a teacher reaching another school. That is
 * `requireSchoolAccess`, it returns 403, and it is the ordinary case. The interesting
 * one is a teacher **on their own school's path** posting to a class they do not teach:
 * the tenant check passes cleanly and only a class-assignment check stands between them
 * and every student in that class. It is the same shape as the behaviour-record defect
 * (AUDIT R10-M2) one level over, so those cases are written first and deliberately.
 *
 * There is no school-wide notice: migration 043 made `class_id` NOT NULL. Keeping one
 * meant two mechanisms for one intent with different delivery — an announcement notifies
 * and emails, a school-wide notice told nobody — and both returned success. School-wide
 * is `announcements`, and a request here without a class is a 400, not a privilege
 * question.
 */
import request from 'supertest';
import { seed, IDS as I, tokens, buildApp, pool } from './helpers';

const app = buildApp();

beforeEach(async () => {
  await seed();
  await pool.query(`DELETE FROM notices`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM notices`);
  await pool.end();
});

const post = (schoolId: string, tok: string, body: object) =>
  request(app).post(`/api/schools/${schoolId}/notices`).set('Authorization', tok).send(body);

const CLASS_NOTICE = { class_id: I.jss2a, title: 'Textbooks', body: 'Bring your maths textbook tomorrow.' };

describe('who may post to a class', () => {
  it('REFUSES a teacher posting to a class in their own school that they do not teach', async () => {
    // The whole point. mathTeacher belongs to School A and is posting on School A's
    // path, so requireSchoolAccess passes. jss3b is a School A class they hold no
    // assignment for and are not form teacher of.
    const res = await post(I.schoolA, tokens.math(), { ...CLASS_NOTICE, class_id: I.jss3b });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ASSIGNED');
    expect((await pool.query(`SELECT count(*) FROM notices`)).rows[0].count).toBe('0');
  });

  it('REFUSES a notice with no class — from a teacher AND from a principal', async () => {
    // Not a privilege question any more. A notice without a class has no meaning: that
    // intent is an announcement, which is a different endpoint with real delivery. The
    // principal case is asserted too, because the old failure mode was precisely that a
    // principal COULD do this and reach nobody.
    for (const tok of [tokens.math(), tokens.principalA()]) {
      const res = await post(I.schoolA, tok, { class_id: null, title: 'All', body: 'Everyone read this.' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const omitted = await post(I.schoolA, tokens.principalA(), { title: 'All', body: 'Everyone.' });
    expect(omitted.status).toBe(400);
    expect((await pool.query(`SELECT count(*) FROM notices`)).rows[0].count).toBe('0');
  });

  it('allows a teacher assigned to the class for the current term', async () => {
    const res = await post(I.schoolA, tokens.math(), CLASS_NOTICE);
    expect(res.status).toBe(201);
    expect(res.body.data.class_id).toBe(I.jss2a);
    expect(res.body.data.created_by).toBe(I.mathTeacher);
  });

  it('allows the form teacher of a class they hold no subject assignment for', async () => {
    // Mirrors behaviour.ts: form_teacher_id OR an assignment, not both. A form teacher
    // with no subject in their own class must still be able to address it.
    await pool.query(`UPDATE classes SET form_teacher_id = $1 WHERE id = $2`, [I.engTeacher, I.jss3b]);
    await pool.query(`DELETE FROM teacher_assignments WHERE teacher_id = $1 AND class_id = $2`, [I.engTeacher, I.jss3b]);
    const res = await post(I.schoolA, tokens.english(), { ...CLASS_NOTICE, class_id: I.jss3b });
    expect(res.status).toBe(201);
  });

  it('allows a principal to post to any class in their own school', async () => {
    const res = await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b });
    expect(res.status).toBe(201);
  });

  it('the database refuses a school-wide notice even if a route ever stopped doing so', async () => {
    // Migration 043. The route's zod schema is the first line and this is the last one:
    // a convention living in one route file is one edit away from gone, and the failure
    // it would let back in is invisible — a notice that reaches a page and notifies
    // nobody.
    await expect(
      pool.query(
        `INSERT INTO notices (school_id, class_id, title, body, created_by) VALUES ($1, NULL, 'x', 'y', $2)`,
        [I.schoolA, I.principalA]
      )
    ).rejects.toThrow();
  });

  it('REFUSES a class that belongs to another school — 404, not 403', async () => {
    // The class exists, so "not found in this school" is the honest answer; saying
    // "you are not assigned" would confirm it exists somewhere.
    const res = await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b });
    expect(res.status).toBe(201); // control: jss3b IS in school A
    const foreign = await post(I.schoolB, tokens.principalB(), { ...CLASS_NOTICE, class_id: I.jss2a });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('CLASS_NOT_FOUND');
  });

  it('REFUSES a principal on another school’s path', async () => {
    const res = await post(I.schoolB, tokens.principalA(), CLASS_NOTICE);
    expect(res.status).toBe(403);
  });

  it('REFUSES a parent and a student outright', async () => {
    expect((await post(I.schoolA, tokens.parentA(), CLASS_NOTICE)).status).toBe(403);
    expect((await post(I.schoolA, tokens.studentS1(), CLASS_NOTICE)).status).toBe(403);
  });
});

describe('what reaches the student', () => {
  it('a student sees their own class and nothing else', async () => {
    await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss2a });
    await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b, title: 'Other class' });

    const res = await request(app)
      .get(`/api/schools/${I.schoolA}/student/notices`)
      .set('Authorization', tokens.studentS1());

    expect(res.status).toBe(200);
    const titles = res.body.data.map((n: { title: string }) => n.title);
    expect(titles).toContain('Textbooks');
    // s1 is in jss2a. The other class's notice must not reach them.
    expect(titles).not.toContain('Other class');
  });
});

describe('taking a notice down', () => {
  const del = (schoolId: string, id: string, tok: string) =>
    request(app).delete(`/api/schools/${schoolId}/notices/${id}`).set('Authorization', tok);

  async function postAs(tok: string, body: object): Promise<string> {
    const res = await post(I.schoolA, tok, body);
    expect(res.status).toBe(201);
    return res.body.data.id;
  }

  it('lets a principal delete a notice', async () => {
    const id = await postAs(tokens.principalA(), CLASS_NOTICE);
    expect((await del(I.schoolA, id, tokens.principalA())).status).toBe(200);
    expect((await pool.query(`SELECT count(*) FROM notices`)).rows[0].count).toBe('0');
  });

  it('lets a teacher delete a notice for a class they teach', async () => {
    const id = await postAs(tokens.math(), CLASS_NOTICE);
    expect((await del(I.schoolA, id, tokens.math())).status).toBe(200);
  });

  it('REFUSES a teacher deleting a notice for a class they do not teach', async () => {
    // Delete is governed by the same class check as create. A route that guards the
    // write and leaves the un-write open has guarded half of the operation.
    const id = await postAs(tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b });
    const res = await del(I.schoolA, id, tokens.math());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ASSIGNED');
    expect((await pool.query(`SELECT count(*) FROM notices`)).rows[0].count).toBe('1');
  });

  it('404s on a notice belonging to another school, leaving it in place', async () => {
    const id = await postAs(tokens.principalA(), CLASS_NOTICE);
    const res = await del(I.schoolB, id, tokens.principalB());
    expect(res.status).toBe(404);
    expect((await pool.query(`SELECT count(*) FROM notices`)).rows[0].count).toBe('1');
  });

  it('404s on an id that does not exist', async () => {
    const res = await del(I.schoolA, '00000000-0000-4000-8000-000000000999', tokens.principalA());
    expect(res.status).toBe(404);
  });
});

describe('the audit trail', () => {
  it('records both posting and taking down, with the notice named', async () => {
    const created = await post(I.schoolA, tokens.principalA(), CLASS_NOTICE);
    const id = created.body.data.id;
    await request(app)
      .delete(`/api/schools/${I.schoolA}/notices/${id}`)
      .set('Authorization', tokens.principalA());

    const rows = await pool.query(
      `SELECT action_type, entity_id FROM audit_logs
        WHERE school_id = $1 AND action_type IN ('NOTICE_CREATED', 'NOTICE_DELETED')
        ORDER BY created_at`,
      [I.schoolA]
    );
    expect(rows.rows.map(r => r.action_type)).toEqual(['NOTICE_CREATED', 'NOTICE_DELETED']);
    expect(rows.rows.every(r => r.entity_id === id)).toBe(true);
  });
});

describe('staff can see what they may take down', () => {
  it('a teacher lists their own classes and not other classes', async () => {
    await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss2a });
    await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b, title: 'Other class' });

    const res = await request(app)
      .get(`/api/schools/${I.schoolA}/notices`)
      .set('Authorization', tokens.math());

    expect(res.status).toBe(200);
    const titles = res.body.data.notices.map((n: { title: string }) => n.title);
    expect(titles).toContain('Textbooks');
    expect(titles).not.toContain('Other class');
    // The picker offers exactly what the guard accepts — jss2a yes, jss3b no.
    const classIds = res.body.data.classes.map((c: { id: string }) => c.id);
    expect(classIds).toContain(I.jss2a);
    expect(classIds).not.toContain(I.jss3b);
  });

  it('a principal lists every notice in the school', async () => {
    await post(I.schoolA, tokens.principalA(), { ...CLASS_NOTICE, class_id: I.jss3b, title: 'Other class' });
    const res = await request(app)
      .get(`/api/schools/${I.schoolA}/notices`)
      .set('Authorization', tokens.principalA());
    expect(res.body.data.notices.map((n: { title: string }) => n.title)).toContain('Other class');
  });
});
