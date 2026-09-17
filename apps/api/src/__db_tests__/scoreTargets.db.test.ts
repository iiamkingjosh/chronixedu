/** AUDIT H-1 / H-2 / H-bulk-leak regression. */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

beforeEach(seed);
afterAll(() => pool.end());

const entry = (student_id: string, component_id = I.exam, score = 50) =>
  request(app).post(`${base}/scores/entry`).set('Authorization', tokens.math())
    .send({ student_id, subject_id: I.math, class_id: I.jss2a, term_id: I.termA, component_id, score });

const bulk = (entries: Array<{ student_id: string; component_id: string; score: number }>) =>
  request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tokens.math())
    .send({ subject_id: I.math, class_id: I.jss2a, term_id: I.termA, entries });

describe('H-1: score targets are validated', () => {
  it('rejects a student from another class', async () => {
    const r = await entry(I.s3OtherClass);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('STUDENT_NOT_ENROLLED');
  });

  it("rejects another school's student", async () => {
    const r = await entry(I.sOtherSchool);
    expect(r.status).toBe(400);
    const b = await bulk([{ student_id: I.sOtherSchool, component_id: I.exam, score: 5 }]);
    expect(b.status).toBe(422);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM scores WHERE student_id = $1`, [I.sOtherSchool]);
    expect(rows[0].n).toBe(0);
  });

  it('rejects scores above max_score and duplicate bulk rows', async () => {
    expect((await entry(I.s1, I.ca1, 31)).status).toBe(400);
    const b = await bulk([
      { student_id: I.s1, component_id: I.exam, score: 5 },
      { student_id: I.s1, component_id: I.exam, score: 6 },
    ]);
    expect(b.status).toBe(422);
  });

  it('database trigger blocks a cross-tenant score row even if the API is bypassed', async () => {
    await expect(pool.query(
      `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [I.schoolA, I.sOtherSchool, I.math, I.termA, I.exam]
    )).rejects.toThrow(/does not match student school/);
  });
});

describe('H-2: bulk score saves are audited', () => {
  it('writes one audit row per changed score, none for unchanged', async () => {
    const entries = [
      { student_id: I.s1, component_id: I.exam, score: 60 },
      { student_id: I.s2, component_id: I.exam, score: 40 },
    ];
    expect((await bulk(entries)).status).toBe(201);
    const count = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity = 'scores'`)).rows[0].n as number;
    expect(await count()).toBe(2);

    expect((await bulk(entries)).status).toBe(201);
    expect(await count()).toBe(2);

    expect((await bulk([{ student_id: I.s1, component_id: I.exam, score: 61 }])).status).toBe(201);
    const { rows } = await pool.query(
      `SELECT action_type, old_value, new_value FROM audit_logs WHERE entity = 'scores' ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].action_type).toBe('SCORE_UPDATED');
    expect(Number(rows[0].old_value.score)).toBe(60);
    expect(rows[0].new_value).toMatchObject({ score: 61, subject_id: I.math, class_id: I.jss2a, source: 'bulk' });
  });
});

describe('bulk validation failures do not leak pool connections', () => {
  it('stays healthy after more rejected requests than the pool size', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await bulk([{ student_id: I.s1, component_id: I.exam, score: 999 }]);
      expect(r.status).toBe(422);
    }
    const ok = await bulk([{ student_id: I.s1, component_id: I.exam, score: 50 }]);
    expect(ok.status).toBe(201);
  }, 20_000);
});
