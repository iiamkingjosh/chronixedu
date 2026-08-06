import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/errorHandler';

// Deliberately mirrors auth.test.ts's setup EXCEPT SEED_SECRET is left unset —
// this is exactly the misconfiguration scenario the vulnerability depends on:
// a non-production environment where SEED_SECRET was never configured.
process.env.JWT_SECRET = 'test-secret';
(process.env as Record<string, string>).NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
delete process.env.SEED_SECRET;

const mockAdminCreateUser = jest.fn();
const mockAdminListUsers = jest.fn();

jest.mock('../supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: jest.fn(), resetPasswordForEmail: jest.fn() } },
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: (...args: unknown[]) => mockAdminCreateUser(...args),
        listUsers: (...args: unknown[]) => mockAdminListUsers(...args),
        getUser: jest.fn(),
        updateUserById: jest.fn(),
      },
    },
  },
}));

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    query: (...args: unknown[]) => mockQuery(...args),
    end: jest.fn().mockResolvedValue(undefined),
  })),
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [{ is_active: true }] }),
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

describe('POST /api/auth/seed-test-user — SEED_SECRET unset', () => {
  it('never creates a user, even with a full valid payload and no x-seed-secret header', async () => {
    mockAdminListUsers.mockResolvedValueOnce({ data: { users: [] } });
    mockAdminCreateUser.mockResolvedValueOnce({ data: { user: { id: 'attacker-created-uuid' } }, error: null });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/auth/seed-test-user')
      // No x-seed-secret header at all — this is the exploit precondition:
      // `undefined !== process.env.SEED_SECRET` (also undefined) previously evaluated false.
      .send({
        email: 'attacker@evil.com',
        password: 'password123',
        role: 'super_admin',
        first_name: 'Attacker',
        last_name: 'User',
      });

    expect(res.status).toBe(404);
    expect(mockAdminCreateUser).not.toHaveBeenCalled();
  });
});
