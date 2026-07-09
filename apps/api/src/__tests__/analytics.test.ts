import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import analyticsRouter from '../routes/analytics';
import { errorHandler } from '../middleware/errorHandler';
import * as analyticsQueries from '../db/queries/analytics';
import * as rosterQueries from '../db/queries/roster';
import * as analyticsService from '../services/analyticsService';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [{ is_active: true }] }), end: jest.fn() },
}));
jest.mock('../db/queries/analytics');
jest.mock('../db/queries/roster');
jest.mock('../services/analyticsService');

const mockAnalytics = analyticsQueries as jest.Mocked<typeof analyticsQueries>;
const mockRoster = rosterQueries as jest.Mocked<typeof rosterQueries>;
const mockService = analyticsService as jest.Mocked<typeof analyticsService>;

process.env.JWT_SECRET = 'test-secret';

function makeToken(role: string, schoolId?: string) {
  return jwt.sign(
    { user_id: 'user-uuid-001', role, school_id: schoolId ?? null, email: 'test@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

const app = express();
app.use(express.json());
app.use('/api/schools', analyticsRouter);
app.use(errorHandler);

const SCHOOL_ID = 'school-uuid-001';
const TERM_ID = 'term-uuid-001';

beforeEach(() => jest.clearAllMocks());

const SNAPSHOT = {
  id: 'snap-2',
  school_id: SCHOOL_ID,
  term_id: TERM_ID,
  snapshot_date: '2026-06-11',
  overall_performance: { total_students: 50, students_with_scores: 48, school_average: 67.5, pass_rate: 80 },
  subject_performance: [{ subject_id: 's1', subject_name: 'Maths', average: 72.3, pass_rate: 90, students_count: 20 }],
  attendance_summary: { total: 100, present: 80, absent: 10, late: 5, excused: 5, percentage: 85 },
  fee_collection: { total_expected: 100000, total_collected: 75000, total_outstanding: 25000, counts: { unpaid: 2, partial: 3, paid: 10 } },
  created_at: '2026-06-11T02:00:00.000Z',
};

const PREVIOUS_SNAPSHOT = {
  ...SNAPSHOT,
  id: 'snap-1',
  snapshot_date: '2026-06-10',
  overall_performance: { ...SNAPSHOT.overall_performance, school_average: 65 },
  attendance_summary: { ...SNAPSHOT.attendance_summary, percentage: 80 },
  fee_collection: { ...SNAPSHOT.fee_collection, total_collected: 70000, total_outstanding: 30000 },
};

describe('GET /api/schools/:schoolId/analytics/overview', () => {
  it('returns the latest snapshot with a trend comparison against the previous one', async () => {
    mockAnalytics.getLatestSnapshot.mockResolvedValueOnce(SNAPSHOT as never);
    mockAnalytics.getPreviousSnapshot.mockResolvedValueOnce(PREVIOUS_SNAPSHOT as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.overall_performance).toEqual(SNAPSHOT.overall_performance);
    expect(res.body.data.subject_performance).toEqual(SNAPSHOT.subject_performance);
    expect(res.body.data.trend).toEqual({
      school_average: { current: 67.5, previous: 65, delta: 2.5 },
      attendance_percentage: { current: 85, previous: 80, delta: 5 },
      fee_collected: { current: 75000, previous: 70000, delta: 5000 },
      fee_outstanding: { current: 25000, previous: 30000, delta: -5000 },
    });
    expect(mockAnalytics.getLatestSnapshot).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID);
    expect(mockAnalytics.getPreviousSnapshot).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, SNAPSHOT.snapshot_date);
    expect(mockService.generateSnapshot).not.toHaveBeenCalled();
  });

  it('generates a snapshot on demand when none exists yet, with null trend deltas', async () => {
    mockAnalytics.getLatestSnapshot.mockResolvedValueOnce(null);
    mockService.generateSnapshot.mockResolvedValueOnce(SNAPSHOT as never);
    mockAnalytics.getPreviousSnapshot.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(mockService.generateSnapshot).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID);
    expect(res.body.data.trend).toEqual({
      school_average: { current: 67.5, previous: null, delta: null },
      attendance_percentage: { current: 85, previous: null, delta: null },
      fee_collected: { current: 75000, previous: null, delta: null },
      fee_outstanding: { current: 25000, previous: null, delta: null },
    });
  });

  it('falls back to the active term when term_id is not provided', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce({ id: TERM_ID, name: 'Term 1', session_id: 'session-1' } as never);
    mockAnalytics.getLatestSnapshot.mockResolvedValueOnce(SNAPSHOT as never);
    mockAnalytics.getPreviousSnapshot.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(mockAnalytics.getLatestSnapshot).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID);
  });

  it('returns null data when there is no active term and no term_id given', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });
  });

  it('rejects users from other schools', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', 'other-school')}`);

    expect(res.status).toBe(403);
  });

  it('rejects roles other than principal/super_admin', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
  });

  it('allows super_admin to access any school', async () => {
    mockAnalytics.getLatestSnapshot.mockResolvedValueOnce(SNAPSHOT as never);
    mockAnalytics.getPreviousSnapshot.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/analytics/overview?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);

    expect(res.status).toBe(200);
  });
});
