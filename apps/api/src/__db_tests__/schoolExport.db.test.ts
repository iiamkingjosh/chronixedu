/**
 * The school's own data export (db/queries/schoolExport.ts).
 *
 * "Complete" is the promise (DPA; Terms §22), so completeness is what this tests first:
 * every table in the database must be either an export source or named in NOT_EXPORTED
 * with a reason. A table added without that decision fails here. Then the export is checked
 * for the thing an export must never do — carry another school's rows — and for the gate:
 * a teacher is refused, and a read-only school can still take its data.
 */
import request from 'supertest';
import { buildApp, seed, IDS as I, pool, tokens } from './helpers';
import { EXPORT_DATASETS, NOT_EXPORTED } from '../db/queries/schoolExport';
import { cache, schoolCacheKey } from '../services/cacheService';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

beforeEach(async () => {
  await seed();
  cache.del(schoolCacheKey(I.schoolA, 'data'));
});
afterAll(async () => { await pool.end(); });

describe('completeness — every table is either exported or excluded with a reason', () => {
  it('no table is unclassified, and none is both', async () => {
    const { rows } = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    const all = rows.map(r => r.t);
    expect(all.length).toBeGreaterThan(40); // the control: the real schema was read
    const exported = new Set(EXPORT_DATASETS.flatMap(d => d.tables));
    const excluded = new Set(Object.keys(NOT_EXPORTED));
    expect(all.filter(t => !exported.has(t) && !excluded.has(t))).toEqual([]);
    expect([...exported].filter(t => excluded.has(t))).toEqual([]);
    expect([...exported, ...excluded].filter(t => !all.includes(t))).toEqual([]); // no stale names
  });

  it('every exclusion says why', () => {
    for (const [table, why] of Object.entries(NOT_EXPORTED)) expect(`${table}: ${why}`.length).toBeGreaterThan(table.length + 20);
  });
});

describe('what the principal downloads', () => {
  const summary = async () => (await request(app).get(`${base}/export`).set('Authorization', tokens.principalA())).body.data.datasets as Array<{ key: string; rows: number }>;
  const csv = (key: string) => request(app).get(`${base}/export/${key}`).set('Authorization', tokens.principalA());

  it('lists every dataset with its row count, and the seeded rows are there', async () => {
    const list = await summary();
    expect(list.map(d => d.key)).toEqual(EXPORT_DATASETS.map(d => d.key));
    expect(list.find(d => d.key === 'students')!.rows).toBe(3);
    expect(list.find(d => d.key === 'enrolments')!.rows).toBe(3);
  });

  it("carries none of another school's rows — every dataset, checked for school B's ids", async () => {
    const foreign = [I.schoolB, I.sOtherSchool, I.principalB, I.sessionB, I.termB];
    for (const d of EXPORT_DATASETS) {
      const res = await csv(d.key);
      expect(res.status).toBe(200);
      for (const id of foreign) expect(`${d.key}: ${res.text.includes(id)}`).toBe(`${d.key}: false`);
    }
  });

  it('is CSV with a header row, and leaves password hashes out', async () => {
    const res = await csv('people');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const header = res.text.split('\n')[0];
    expect(header).toContain('email');
    expect(res.text).not.toMatch(/password/i);
  });

  it('each download is audited', async () => {
    await csv('scores');
    const { rows } = await pool.query(`SELECT new_value FROM audit_logs WHERE action_type = 'SCHOOL_DATA_EXPORTED' AND school_id = $1`, [I.schoolA]);
    expect(rows).toHaveLength(1);
    expect(rows[0].new_value).toMatchObject({ dataset: 'scores' });
  });

  it('a teacher cannot export the school, and an unknown dataset is a 404', async () => {
    expect((await request(app).get(`${base}/export`).set('Authorization', tokens.math())).status).toBe(403);
    expect((await csv('no-such-thing')).status).toBe(404);
  });

  it('a read-only school can still take its data — the export is a GET', async () => {
    await pool.query(`INSERT INTO platform_subscriptions (school_id, plan, subscription_status) VALUES ($1, 'trial', 'read_only')`, [I.schoolA]);
    cache.del(schoolCacheKey(I.schoolA, 'data'));
    // The gate is on: a write is refused…
    const write = await request(app).post(`${base}/notices`).set('Authorization', tokens.principalA()).send({ class_id: I.jss2a, title: 'x', body: 'y' });
    expect(write.status).toBe(423);
    // …and the export still answers.
    expect((await csv('students')).status).toBe(200);
  });
});
