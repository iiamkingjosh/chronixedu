/**
 * Who may change which account (audit, 8 Oct 2026).
 *
 * - A teacher could not upload their own signature, which report cards print for a form teacher: the
 *   route checked "yourself or an admin", but sat behind this file's principal-only guard, which
 *   refused every teacher first.
 * - A principal could deactivate themselves, and the last active principal could be deactivated,
 *   leaving a school nobody can administer (migration 039 requires an active principal only on the
 *   way IN to being active).
 */
const mockUpload = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: {
    auth: { admin: {} },
    storage: { from: () => ({ upload: (...args: unknown[]) => mockUpload(...args), createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example.test/x' }, error: null }) }) },
  },
}));

import request from 'supertest';
import { pool, seed, token, tokens, IDS as I, buildApp } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SUPER = 'c0000000-0000-4000-8000-0000000000c1';
const superToken = () => token(SUPER, 'super_admin', I.schoolA);

beforeEach(async () => {
  await seed();
  mockUpload.mockReset();
  mockUpload.mockResolvedValue({ error: null });
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, two_factor_required, must_change_password)
     VALUES ($1, NULL, 'root.guard@test', 'x', 'super_admin', 'Root', 'Guard', false, false)`, [SUPER]);
});
afterAll(() => pool.end());

describe('signatures', () => {
  const upload = (tok: string, userId: string) => request(app).post(`${base}/users/${userId}/signature`)
    .set('Authorization', tok).attach('signature', PNG, 'sig.png');

  it('a teacher uploads their own', async () => {
    const res = await upload(tokens.math(), I.mathTeacher);
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("a teacher cannot upload another teacher's", async () => {
    expect((await upload(tokens.math(), I.engTeacher)).status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('deactivating accounts', () => {
  const setActive = (tok: string, userId: string, is_active: boolean) => request(app)
    .patch(`${base}/users/${userId}/status`).set('Authorization', tok).send({ is_active, reason: 'Testing the guard here' });

  it('a principal cannot deactivate themselves', async () => {
    const res = await setActive(tokens.principalA(), I.principalA, false);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
    // Control: the same principal deactivates a teacher.
    expect((await setActive(tokens.principalA(), I.mathTeacher, false)).status).toBe(200);
  });

  it("the school's last active principal cannot be deactivated; with a second, they can", async () => {
    const last = await setActive(superToken(), I.principalA, false);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_PRINCIPAL');

    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ('30000000-0000-4000-8000-0000000000c2', $1, 'second.principal@test', 'x', 'principal', 'Second', 'Head', true, 'subject', false)`, [I.schoolA]);
    expect((await setActive(superToken(), I.principalA, false)).status).toBe(200);
  });
});
