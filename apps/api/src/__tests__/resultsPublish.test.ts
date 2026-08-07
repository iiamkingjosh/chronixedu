import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import resultsRouter from '../routes/results';
import { errorHandler } from '../middleware/errorHandler';
import * as resultsQueries from '../db/queries/results';
import * as reportCardsQueries from '../db/queries/reportCards';
import * as auditLog from '../db/queries/auditLog';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [{ is_active: true }] }), end: jest.fn() },
}));
jest.mock('../db/queries/results');
jest.mock('../db/queries/reportCards');
jest.mock('../db/queries/auditLog');
jest.mock('../services/reportCardService', () => ({
  startReportCardBatch: jest.fn(),
  getJob: jest.fn(),
}));

const mockResults = resultsQueries as jest.Mocked<typeof resultsQueries>;
const mockReportCards = reportCardsQueries as jest.Mocked<typeof reportCardsQueries>;
const mockAudit = auditLog as jest.Mocked<typeof auditLog>;

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
app.use('/api/schools', resultsRouter);
app.use(errorHandler);

const SCHOOL_ID = 'school-uuid-001';
const CLASS_ID  = '11111111-1111-4111-8111-111111111111';
const TERM_ID   = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.logAudit.mockResolvedValue(undefined as never);
});

function approvedStudents() {
  return [
    { student_id: 'student-1', first_name: 'A', last_name: 'One', admission_no: 'A1', current_status: 'approved' },
    { student_id: 'student-2', first_name: 'B', last_name: 'Two', admission_no: 'A2', current_status: 'approved' },
  ];
}

describe('POST /:schoolId/results/publish — wires up report_cards.is_published', () => {
  it('flips is_published for the term\'s report cards after all students are marked published', async () => {
    mockResults.getStudentsInClassWithStatus.mockResolvedValueOnce(approvedStudents() as never);
    mockResults.batchUpsertStatuses.mockResolvedValueOnce(undefined as never);
    mockReportCards.publishReportCards.mockResolvedValueOnce(undefined as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/results/publish`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ class_id: CLASS_ID, term_id: TERM_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // result_status must flip to 'published' first...
    expect(mockResults.batchUpsertStatuses).toHaveBeenCalledWith(
      ['student-1', 'student-2'], SCHOOL_ID, TERM_ID, 'published', 'user-uuid-001', ['approved']
    );
    // ...and report_cards.is_published must be released for the same students/term,
    // in the same request — this is the fix for the publish gate that could never open.
    expect(mockReportCards.publishReportCards).toHaveBeenCalledWith(
      SCHOOL_ID, TERM_ID, ['student-1', 'student-2']
    );

    // Ordering matters: report cards should be released only after the status
    // transition itself has been persisted.
    const statusCallOrder = mockResults.batchUpsertStatuses.mock.invocationCallOrder[0];
    const publishCallOrder = mockReportCards.publishReportCards.mock.invocationCallOrder[0];
    expect(statusCallOrder).toBeLessThan(publishCallOrder);
  });

  it('does not touch report_cards when not all students are approved yet', async () => {
    mockResults.getStudentsInClassWithStatus.mockResolvedValueOnce([
      { student_id: 'student-1', first_name: 'A', last_name: 'One', admission_no: 'A1', current_status: 'submitted' },
    ] as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/results/publish`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ class_id: CLASS_ID, term_id: TERM_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_ALL_APPROVED');
    expect(mockResults.batchUpsertStatuses).not.toHaveBeenCalled();
    expect(mockReportCards.publishReportCards).not.toHaveBeenCalled();
  });

  it('rejects non-principal/super_admin callers', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/results/publish`)
      .set('Authorization', `Bearer ${makeToken('teacher', SCHOOL_ID)}`)
      .send({ class_id: CLASS_ID, term_id: TERM_ID });

    expect(res.status).toBe(403);
    expect(mockReportCards.publishReportCards).not.toHaveBeenCalled();
  });
});
