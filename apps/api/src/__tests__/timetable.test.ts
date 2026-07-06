import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import timetableRouter from '../routes/timetable';
import { errorHandler } from '../middleware/errorHandler';
import * as timetableQueries from '../db/queries/timetable';
import * as rosterQueries from '../db/queries/roster';
import * as userQueries from '../db/queries/users';

jest.mock('../db/queries/timetable');
jest.mock('../db/queries/roster');
jest.mock('../db/queries/users');

const mockTimetable = timetableQueries as jest.Mocked<typeof timetableQueries>;
const mockRoster = rosterQueries as jest.Mocked<typeof rosterQueries>;
const mockUsers = userQueries as jest.Mocked<typeof userQueries>;

process.env.JWT_SECRET = 'test-secret';

function makeToken(role: string, schoolId?: string, userId?: string) {
  return jwt.sign(
    { user_id: userId ?? 'user-uuid-001', role, school_id: schoolId ?? null, email: 'test@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

const app = express();
app.use(express.json());
app.use('/api/schools', timetableRouter);
app.use(errorHandler);

const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const TERM_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '44444444-4444-4444-8444-444444444444';
const TEACHER_ID = '55555555-5555-4555-8555-555555555555';

const VALID_BODY = {
  class_id: CLASS_ID,
  term_id: TERM_ID,
  day_of_week: 1,
  period_number: 2,
  subject_id: SUBJECT_ID,
  teacher_id: TEACHER_ID,
};

const CREATED_SLOT = {
  id: 'slot-1',
  school_id: SCHOOL_ID,
  ...VALID_BODY,
  created_at: '2026-06-12T00:00:00.000Z',
};

beforeEach(() => jest.clearAllMocks());

describe('POST /api/schools/:schoolId/timetable', () => {
  it('creates a slot when there is no clash', async () => {
    mockUsers.findUserById.mockResolvedValueOnce({ id: TEACHER_ID, role: 'teacher', school_id: SCHOOL_ID } as never);
    mockTimetable.findClassClash.mockResolvedValueOnce(null);
    mockTimetable.findTeacherClash.mockResolvedValueOnce(null);
    mockTimetable.insertSlot.mockResolvedValueOnce(CREATED_SLOT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(CREATED_SLOT);
    expect(mockTimetable.insertSlot).toHaveBeenCalledWith(SCHOOL_ID, VALID_BODY);
  });

  it('returns 409 CLASS_CLASH with a description when the class already has a subject at that day/period', async () => {
    mockTimetable.findClassClash.mockResolvedValueOnce({
      id: 'slot-existing',
      class_id: CLASS_ID,
      class_name: 'JSS1A',
      subject_id: 'subject-other',
      subject_name: 'English',
      teacher_id: 'teacher-other',
      teacher_name: 'Mrs. Adeyemi',
      day_of_week: 1,
      period_number: 2,
    } as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLASS_CLASH');
    expect(res.body.error.message).toContain('JSS1A');
    expect(res.body.error.message).toContain('English');
    expect(mockTimetable.insertSlot).not.toHaveBeenCalled();
  });

  it('returns 409 TEACHER_CLASH with a description when the teacher is already booked at that day/period', async () => {
    mockTimetable.findClassClash.mockResolvedValueOnce(null);
    mockTimetable.findTeacherClash.mockResolvedValueOnce({
      id: 'slot-existing',
      class_id: 'class-other',
      class_name: 'JSS1B',
      subject_id: SUBJECT_ID,
      subject_name: 'Mathematics',
      teacher_id: TEACHER_ID,
      teacher_name: 'Mr. Okafor',
      day_of_week: 1,
      period_number: 2,
    } as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEACHER_CLASH');
    expect(res.body.error.message).toContain('JSS1B');
    expect(res.body.error.message).toContain('Mr. Okafor');
    expect(mockTimetable.insertSlot).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ ...VALID_BODY, day_of_week: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects roles other than principal/super_admin', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID)}`)
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });

  it('rejects requests for a different school', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/timetable`)
      .set('Authorization', `Bearer ${makeToken('principal', 'other-school')}`)
      .send(VALID_BODY);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/schools/:schoolId/timetable/class/:classId', () => {
  const CLASS_SLOTS = [
    { id: 'slot-1', day_of_week: 1, period_number: 1, subject_id: SUBJECT_ID, subject_name: 'Mathematics', subject_code: 'MTH', teacher_id: TEACHER_ID, teacher_name: 'Mr. Okafor' },
  ];

  it('returns the class timetable for a given term_id', async () => {
    mockTimetable.getClassTimetable.mockResolvedValueOnce(CLASS_SLOTS as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/class/${CLASS_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(CLASS_SLOTS);
    expect(mockTimetable.getClassTimetable).toHaveBeenCalledWith(SCHOOL_ID, CLASS_ID, TERM_ID);
    expect(mockRoster.getActiveTerm).not.toHaveBeenCalled();
  });

  it('falls back to the active term when term_id is not provided', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce({ id: TERM_ID, name: 'Term 1', session_id: 'session-1' } as never);
    mockTimetable.getClassTimetable.mockResolvedValueOnce(CLASS_SLOTS as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/class/${CLASS_ID}`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(mockTimetable.getClassTimetable).toHaveBeenCalledWith(SCHOOL_ID, CLASS_ID, TERM_ID);
  });

  it('returns an empty array when there is no active term and no term_id', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/class/${CLASS_ID}`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockTimetable.getClassTimetable).not.toHaveBeenCalled();
  });
});

describe('GET /api/schools/:schoolId/timetable/teacher/:teacherId', () => {
  const TEACHER_SLOTS = [
    { id: 'slot-1', day_of_week: 1, period_number: 1, class_id: CLASS_ID, class_name: 'JSS1A', subject_id: SUBJECT_ID, subject_name: 'Mathematics' },
  ];

  it('allows a principal to view any teacher timetable', async () => {
    mockTimetable.getTeacherTimetable.mockResolvedValueOnce(TEACHER_SLOTS as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/teacher/${TEACHER_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(TEACHER_SLOTS);
  });

  it('allows a teacher to view their own timetable', async () => {
    mockTimetable.getTeacherTimetable.mockResolvedValueOnce(TEACHER_SLOTS as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/teacher/${TEACHER_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID, TEACHER_ID)}`);

    expect(res.status).toBe(200);
  });

  it('rejects a teacher viewing another teacher timetable', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/timetable/teacher/${TEACHER_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID, 'other-teacher')}`);

    expect(res.status).toBe(403);
    expect(mockTimetable.getTeacherTimetable).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/schools/:schoolId/timetable/:slotId', () => {
  it('removes a slot', async () => {
    mockTimetable.findSlotById.mockResolvedValueOnce(CREATED_SLOT as never);
    mockTimetable.deleteSlot.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .delete(`/api/schools/${SCHOOL_ID}/timetable/slot-1`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(mockTimetable.deleteSlot).toHaveBeenCalledWith('slot-1', SCHOOL_ID);
  });

  it('returns 404 when the slot does not exist', async () => {
    mockTimetable.findSlotById.mockResolvedValueOnce(null);

    const res = await request(app)
      .delete(`/api/schools/${SCHOOL_ID}/timetable/missing`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
    expect(mockTimetable.deleteSlot).not.toHaveBeenCalled();
  });

  it('rejects roles other than principal/super_admin', async () => {
    const res = await request(app)
      .delete(`/api/schools/${SCHOOL_ID}/timetable/slot-1`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
  });
});
