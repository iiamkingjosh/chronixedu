// End-to-end coverage for the report-card publish gate.
//
// Two bugs were fixed together here:
//   (A) report_cards.is_published was never written to TRUE anywhere in the
//       app, so the parent/student-facing routes (which correctly gate on
//       is_published = TRUE) returned "not published" forever.
//   (B) the staff-only GET .../students/:studentId/report-card endpoint
//       allowed the 'parent' role but had no is_published filter at all.
//
// This suite exercises the *real* db/queries/reportCards.ts (publishReportCards,
// the function results.ts's publish handler now calls) and the *real*
// routes/students.ts and routes/parent.ts report-card endpoints together,
// against a small in-memory fake for the report_cards table — proving the
// fix actually connects publish -> is_published -> parent visibility, not
// just that each piece is individually wired.
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/client';
import studentsRouter from '../routes/students';
import parentRouter from '../routes/parent';
import { errorHandler } from '../middleware/errorHandler';
import { publishReportCards } from '../db/queries/reportCards';
import * as parentsQueries from '../db/queries/parents';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
// students.ts pulls in services/transcriptService -> ../supabaseClient, which
// throws at import time if SUPABASE_* env vars aren't set. Mock it out.
// The routes under test call signReportCardAsset() (added by the storage-
// privacy fix) before returning pdf_url, so the storage mock needs a working
// createSignedUrl — matching the pattern in reportCardService.test.ts.
jest.mock('../supabaseClient', () => ({
  __esModule: true,
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({
        createSignedUrl: jest.fn().mockResolvedValue({
          data: { signedUrl: 'https://signed.example.com/report-card.pdf' },
          error: null,
        }),
      })),
    },
  },
  supabase: {},
}));
jest.mock('../db/queries/parents', () => ({
  isParentLinkedToStudent: jest.fn(),
  getLinkedChildren: jest.fn(),
}));

const mockPool = pool as unknown as { query: jest.Mock };
const mockParents = parentsQueries as jest.Mocked<typeof parentsQueries>;

process.env.JWT_SECRET = 'test-secret';

function makeToken(role: string, schoolId: string, userId = 'user-1') {
  return jwt.sign(
    { user_id: userId, role, school_id: schoolId, email: 'x@x.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

const app = express();
app.use(express.json());
app.use('/api/schools', studentsRouter);
app.use('/api/schools', parentRouter);
app.use(errorHandler);

const SCHOOL_ID  = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const TERM_ID    = '33333333-3333-4333-8333-333333333333';

interface FakeReportCard {
  student_id: string;
  term_id: string;
  school_id: string;
  pdf_url: string;
  generated_at: string;
  is_published: boolean;
}

let reportCards: FakeReportCard[];

// A minimal in-memory stand-in for the report_cards table, driven by the
// exact SQL shapes emitted by publishReportCards(), students.ts, and
// parent.ts's findPublishedReportCard() — parses no SQL, just pattern-matches
// on the fixed query text each of those call sites actually issues.
function installFakePool(): void {
  mockPool.query.mockImplementation((sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('UPDATE report_cards')) {
      const [schoolId, termId, studentIds] = params as [string, string, string[]];
      for (const rc of reportCards) {
        if (rc.school_id === schoolId && rc.term_id === termId && studentIds.includes(rc.student_id)) {
          rc.is_published = true;
        }
      }
      return Promise.resolve({ rows: [] });
    }

    if (s.includes('FROM report_cards')) {
      const [studentId, termId, schoolId] = params as [string, string, string];
      const requirePublished = s.includes('is_published = TRUE');
      const row = reportCards.find(rc =>
        rc.student_id === studentId &&
        rc.term_id === termId &&
        rc.school_id === schoolId &&
        (!requirePublished || rc.is_published)
      );
      return Promise.resolve({
        rows: row ? [{ pdf_url: row.pdf_url, generated_at: row.generated_at, is_published: row.is_published }] : [],
      });
    }

    // verifyToken's active-user check, and anything else not under test here.
    return Promise.resolve({ rows: [{ is_active: true }] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  reportCards = [
    {
      student_id: STUDENT_ID,
      term_id: TERM_ID,
      school_id: SCHOOL_ID,
      pdf_url: 'https://example.com/report.pdf',
      generated_at: '2026-08-01T00:00:00.000Z',
      is_published: false,
    },
  ];
  installFakePool();
  mockParents.isParentLinkedToStudent.mockResolvedValue(true as never);
});

describe('GET /:schoolId/students/:studentId/report-card (staff endpoint) — publish gate', () => {
  it('rejects a parent caller with NOT_FOUND when the report card is not yet published', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('still lets a principal see the same unpublished report card (staff pre-release review)', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pdf_url).toBe('https://signed.example.com/report-card.pdf');
    expect(res.body.data.is_published).toBe(false);
  });

  it('still lets a registrar see the same unpublished report card', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${makeToken('registrar', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
  });

  it('lets a parent see the report card once it has been published', async () => {
    reportCards[0].is_published = true;

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pdf_url).toBe('https://signed.example.com/report-card.pdf');
  });
});

describe('End-to-end: publishReportCards() is what makes parent.ts start returning data', () => {
  it('parent.ts rejects the report card before publish, and accepts it after', async () => {
    const tokenParent = makeToken('parent', SCHOOL_ID);

    // Before the fix (Issue A), report_cards.is_published was never written to
    // TRUE by anything — this first request proves the gate genuinely starts closed.
    const before = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${tokenParent}`);

    expect(before.status).toBe(404);
    expect(before.body.error.code).toBe('NOT_PUBLISHED');

    // This is exactly what results.ts's publish handler now calls after
    // batchUpsertStatuses(..., 'published', ...) succeeds.
    await publishReportCards(SCHOOL_ID, TERM_ID, [STUDENT_ID]);
    expect(reportCards[0].is_published).toBe(true);

    // Same route, same data, no other change — now it resolves.
    const after = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${tokenParent}`);

    expect(after.status).toBe(200);
    expect(after.body.success).toBe(true);
    expect(after.body.data.pdf_url).toBe('https://signed.example.com/report-card.pdf');
    expect(after.body.data.is_published).toBe(true);
  });

  it('publishReportCards is a no-op for a student in a different term (does not leak publish across terms)', async () => {
    const otherTermId = '44444444-4444-4444-8444-444444444444';

    await publishReportCards(SCHOOL_ID, otherTermId, [STUDENT_ID]);

    expect(reportCards[0].is_published).toBe(false);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${STUDENT_ID}/report-card`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
  });
});
