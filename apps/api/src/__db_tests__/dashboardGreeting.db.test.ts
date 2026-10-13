/**
 * The principal dashboard's greeting (Moses, 13 Oct 2026): someone with no title is greeted by first name only,
 * "Good morning, Ada"; someone with a title keeps the formal title and surname, "Good morning, Mrs. Obi". It used
 * to greet the untitled by first and last name, which read "Joshua Joshua" for an account whose two names match.
 * The salutation follows the hour in Lagos, so only the name is pinned.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp, seed, IDS as I, pool, tokens } from './helpers';

const app = buildApp();
const overview = (auth: string) =>
  request(app).get(`/api/schools/${I.schoolA}/dashboard/principal/overview`).set('Authorization', auth);
const SALUTATION = '(Good morning|Good afternoon|Good evening|Good night)';

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE users SET first_name = 'Ada', last_name = 'Obi' WHERE id = $1`, [I.principalA]);
});

afterAll(async () => {
  await pool.end();
});

describe('the principal dashboard greeting', () => {
  it('greets someone with no title by first name only', async () => {
    const res = await overview(tokens.principalA());
    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toMatch(new RegExp(`^${SALUTATION}, Ada$`));
  });

  it('keeps title and surname for someone with a title', async () => {
    const titled = 'Bearer ' + jwt.sign(
      { user_id: I.principalA, school_id: I.schoolA, role: 'principal', email: `${I.principalA}@test`, title: 'Mrs.' },
      process.env.JWT_SECRET!,
    );
    const res = await overview(titled);
    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toMatch(new RegExp(`^${SALUTATION}, Mrs\\. Obi$`));
  });
});
