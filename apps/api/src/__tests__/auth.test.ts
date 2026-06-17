import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { errorHandler } from '../middleware/errorHandler';

process.env.JWT_SECRET = 'test-secret';
(process.env as Record<string, string>).NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

const mockSignIn = jest.fn();
const mockAdminCreateUser = jest.fn();
const mockAdminListUsers = jest.fn();
const mockAdminGetUser = jest.fn();
const mockAdminUpdateUserById = jest.fn();

jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignIn(...args),
      resetPasswordForEmail: jest.fn(),
    },
  },
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: (...args: unknown[]) => mockAdminCreateUser(...args),
        listUsers: (...args: unknown[]) => mockAdminListUsers(...args),
        getUser: (...args: unknown[]) => mockAdminGetUser(...args),
        updateUserById: (...args: unknown[]) => mockAdminUpdateUserById(...args),
      },
    },
  },
}));

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: (...args: unknown[]) => mockQuery(...args),
    end: mockEnd,
  })),
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn(),
  })),
}));

jest.mock('../db/queries/users');
jest.mock('../db/queries/auditLog');

import authRouter from '../routes/auth';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use(errorHandler);

function makeToken(role: string) {
  return jwt.sign(
    { user_id: 'user-1', role, school_id: 'school-1', email: 'admin@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('auth middleware error envelope', () => {
  it('returns 401 envelope when Authorization header is missing', async () => {
    const res = await request(app).get('/api/auth/test-role');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' },
    });
  });

  it('returns 401 envelope for an invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
    });
  });

  it('returns 403 envelope when role is insufficient', async () => {
    const token = makeToken('teacher');
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });
  });
});

describe('GET /api/auth/test-role', () => {
  it('returns a success envelope with role under data', async () => {
    const token = makeToken('principal');
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { role: 'principal' } });
  });
});

describe('POST /api/auth/login', () => {
  it('returns a 400 envelope for missing credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Missing credentials' },
    });
  });

  it('returns a 401 envelope for invalid credentials', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid login credentials' },
    });
  });

  it('returns a success envelope with access_token and user under data', async () => {
    mockSignIn.mockResolvedValueOnce({ data: { user: { id: 'auth-uuid-1' } }, error: null });
    const passwordHash = bcrypt.hashSync('password123', 10);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'local-uuid-1',
          school_id: 'school-1',
          role: 'teacher',
          title: null,
          email: 'a@b.com',
          password_hash: passwordHash,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user).toEqual({
      user_id: 'local-uuid-1',
      school_id: 'school-1',
      role: 'teacher',
      email: 'a@b.com',
      title: null,
    });
  });
});

describe('POST /api/auth/create-user', () => {
  it('returns a 400 envelope for missing fields', async () => {
    const token = makeToken('super_admin');
    const res = await request(app)
      .post('/api/auth/create-user')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@test.com' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Missing fields: email, password, role' },
    });
  });

  it('returns a success envelope with user_id under data', async () => {
    mockAdminCreateUser.mockResolvedValueOnce({ data: { user: { id: 'new-uuid-1' } }, error: null });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const token = makeToken('super_admin');
    const res = await request(app)
      .post('/api/auth/create-user')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@test.com', password: 'password123', role: 'teacher' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { user_id: 'new-uuid-1' } });
  });
});

describe('POST /api/auth/seed-test-user', () => {
  it('returns a 400 envelope for missing required fields', async () => {
    const res = await request(app).post('/api/auth/seed-test-user').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Missing required fields: email, password, role, first_name, last_name',
      },
    });
  });

  it('returns a success envelope with user_id and reused_auth under data', async () => {
    mockAdminListUsers.mockResolvedValueOnce({ data: { users: [] } });
    mockAdminCreateUser.mockResolvedValueOnce({ data: { user: { id: 'seeded-uuid-1' } }, error: null });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/auth/seed-test-user').send({
      email: 'seed@test.com',
      password: 'password123',
      role: 'teacher',
      first_name: 'Seed',
      last_name: 'User',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { user_id: 'seeded-uuid-1', reused_auth: false },
    });
  });
});
