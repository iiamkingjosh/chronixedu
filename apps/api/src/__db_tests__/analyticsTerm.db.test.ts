/**
 * Analytics take only this school's term (audit, 8 Oct 2026, S1; doctrine 3).
 *
 * `GET /analytics/overview?term_id=` used the id as given: another school's term made a snapshot row for
 * this school under that term, and an id that is not a uuid was a 500.
 */
import express from 'express';
import request from 'supertest';
import { seed, tokens, IDS as I, pool } from './helpers';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import analyticsRoutes from '../routes/analytics';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, analyticsRoutes);
app.use(errorHandler);
const overview = (term?: string) => request(app).get(`/api/schools/${I.schoolA}/analytics/overview`)
  .set('Authorization', tokens.principalA()).query(term ? { term_id: term } : {});

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
});
afterAll(() => pool.end());

it("serves this school's term, and refuses another school's or a malformed one", async () => {
  const snapshots = (termId: string) =>
    pool.query(`SELECT 1 FROM school_analytics_snapshots WHERE school_id = $1 AND term_id = $2`, [I.schoolA, termId]);

  // The served term leaves its snapshot, so "no snapshot" below is a refusal, not a route that writes none.
  expect((await overview(I.termA)).status).toBe(200);
  expect((await snapshots(I.termA)).rowCount).toBe(1);

  expect((await overview(I.termB)).status).toBe(404);
  expect((await overview('not-a-term')).status).toBe(400);
  expect((await snapshots(I.termB)).rowCount).toBe(0);
});
