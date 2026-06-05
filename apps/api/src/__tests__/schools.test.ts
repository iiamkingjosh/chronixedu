import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import schoolsRouter from '../routes/schools';
import { errorHandler } from '../middleware/errorHandler';
import * as schoolQueries from '../db/queries/schools';
import * as auditLog from '../db/queries/auditLog';
import { supabaseAdmin } from '../supabaseClient';

jest.mock('../db/queries/schools');
jest.mock('../db/queries/auditLog');
jest.mock('../supabaseClient', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({ error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/logo.png' } }),
      }),
    },
  },
  supabase: {},
}));

const mockQueries = schoolQueries as jest.Mocked<typeof schoolQueries>;
const mockAudit  = auditLog   as jest.Mocked<typeof auditLog>;

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
app.use('/api/schools', schoolsRouter);
app.use(errorHandler);

const SCHOOL_ROW = {
  id: 'school-uuid-001',
  name: 'Test School',
  slug: 'test-school',
  is_active: true,
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
  identity_config: { name: 'Test School', motto: '' },
  academic_config: {},
};

// ── POST /api/schools ──────────────────────────────────────────────────────────

describe('POST /api/schools', () => {
  it('creates school + seeds defaults, returns 201', async () => {
    mockQueries.insertSchool.mockResolvedValueOnce({
      id: 'school-uuid-001', name: 'Test School', slug: 'test-school',
      is_active: true, created_at: '', updated_at: '',
    });
    mockQueries.insertSchoolSettings.mockResolvedValueOnce({ id: 'settings-001', school_id: 'school-uuid-001' });

    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ name: 'Test School' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.school.slug).toBe('test-school');
    expect(mockQueries.insertSchool).toHaveBeenCalledWith('Test School', 'test-school');
    expect(mockQueries.insertSchoolSettings).toHaveBeenCalledWith(
      'school-uuid-001',
      expect.objectContaining({ name: 'Test School' }),
      expect.objectContaining({ promotion_cutoff: 40, grading_scale: expect.any(Array) })
    );
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for non-super_admin', async () => {
    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-uuid-001')}`)
      .send({ name: 'Test School' });
    expect(res.status).toBe(403);
  });

  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/schools').send({ name: 'Test School' });
    expect(res.status).toBe(401);
  });
});

// ── GET /api/schools/:schoolId ─────────────────────────────────────────────────

describe('GET /api/schools/:schoolId', () => {
  it('returns school for super_admin', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce(SCHOOL_ROW);
    const res = await request(app)
      .get('/api/schools/school-uuid-001')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('school-uuid-001');
  });

  it('returns school for principal of same school', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce(SCHOOL_ROW);
    const res = await request(app)
      .get('/api/schools/school-uuid-001')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-uuid-001')}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 for principal of different school', async () => {
    const res = await request(app)
      .get('/api/schools/other-school')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-uuid-001')}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when school does not exist', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/api/schools/missing')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);
    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/schools/:schoolId/identity ─────────────────────────────────────

describe('PATCH /api/schools/:schoolId/identity', () => {
  it('updates identity and writes audit log', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce(SCHOOL_ROW);
    mockQueries.updateIdentityConfig.mockResolvedValueOnce(undefined);
    mockAudit.logAudit.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/identity')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockAudit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'IDENTITY_UPDATE', entity: 'school_settings' })
    );
  });

  it('returns 400 for invalid colour format', async () => {
    const res = await request(app)
      .patch('/api/schools/school-uuid-001/identity')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ primary_colour: 'not-a-colour' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty body', async () => {
    const res = await request(app)
      .patch('/api/schools/school-uuid-001/identity')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/schools/:schoolId/academic-config ──────────────────────────────

describe('PATCH /api/schools/:schoolId/academic-config', () => {
  const validBands = [
    { grade: 'A', min: 70, max: 100, label: 'Excellent',  remark: '' },
    { grade: 'B', min: 60, max: 69,  label: 'Very Good',  remark: '' },
    { grade: 'C', min: 50, max: 59,  label: 'Good',       remark: '' },
    { grade: 'D', min: 40, max: 49,  label: 'Pass',       remark: '' },
    { grade: 'F', min: 0,  max: 39,  label: 'Fail',       remark: '' },
  ];

  it('updates config and returns 200 with no warnings', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(false);
    mockQueries.updateAcademicConfig.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.warnings).toBeUndefined();
  });

  it('returns 423 when published results exist', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(true);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('CONFIG_LOCKED');
  });

  it('returns 200 with warnings array when submitted results exist', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(true);
    mockQueries.updateAcademicConfig.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.warnings)).toBe(true);
    expect(res.body.data.warnings.length).toBeGreaterThan(0);
  });

  it('returns 400 when grade bands are invalid (overlap)', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(false);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: [
        { grade: 'A', min: 60, max: 100, label: 'X', remark: '' },
        { grade: 'F', min: 0,  max: 65,  label: 'Y', remark: '' },
      ]});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRADE_BANDS');
  });

  it('returns 400 when assessment weights do not sum to 100', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(false);

    const res = await request(app)
      .patch('/api/schools/school-uuid-001/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ assessment_components: [
        { name: 'CA1', max_score: 10, weight: 50, display_order: 1 },
        { name: 'Exam', max_score: 70, weight: 40, display_order: 2 },
      ]});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/100/);
  });
});

// ── POST /api/schools/:schoolId/logo ──────────────────────────────────────────

describe('POST /api/schools/:schoolId/logo', () => {
  it('uploads PNG and returns logo_url', async () => {
    mockQueries.updateIdentityConfig.mockResolvedValueOnce(undefined);
    mockAudit.logAudit.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post('/api/schools/school-uuid-001/logo')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .attach('logo', Buffer.from('fake-png-data'), { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.logo_url).toBeDefined();
    expect(mockAudit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'LOGO_UPLOAD' })
    );
  });

  it('returns 400 for missing file', async () => {
    const res = await request(app)
      .post('/api/schools/school-uuid-001/logo')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unsupported file type (gif)', async () => {
    const res = await request(app)
      .post('/api/schools/school-uuid-001/logo')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .attach('logo', Buffer.from('fake-gif'), { filename: 'logo.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });
});
