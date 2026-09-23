/**
 * Term calendar management.
 *
 * Onboarding used to demand exactly three terms with exact dates — a school rarely
 * knows its second- and third-term dates at sign-up, and Nigerian calendars shift
 * (holidays, strikes, elections). Onboarding now requires only the term the school
 * is starting in, the rest are added later, and dates are editable via PATCH, which
 * previously did not exist at all: the only UPDATE on `terms` was the is_current
 * toggle, so a shifted calendar could only be corrected with direct DB access.
 *
 * Terms must never overlap. findTermForDate() resolves a date to a term with
 * `LIMIT 1` and no ordering, so overlapping terms make attendance land in an
 * arbitrary one of them.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

const addTerm = (body: Record<string, unknown>) =>
  request(app).post(`${base}/sessions/${I.sessionA}/terms`)
    .set('Authorization', tokens.principalA()).send(body);

const patchTerm = (termId: string, body: Record<string, unknown>) =>
  request(app).patch(`${base}/sessions/${I.sessionA}/terms/${termId}`)
    .set('Authorization', tokens.principalA()).send(body);

beforeEach(seed);
afterAll(() => pool.end());

describe('adding a term', () => {
  it('accepts a term that follows the existing one', async () => {
    const r = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    expect(r.status).toBe(201);
    expect(r.body.data.name).toBe('Second Term');
    expect(r.body.data.is_current).toBe(false);
  });

  it('rejects a term overlapping the seeded First Term', async () => {
    // Seed's First Term runs 2026-09-01 → 2026-12-18.
    const r = await addTerm({ name: 'Clashing Term', start_date: '2026-12-01', end_date: '2027-03-01' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TERM_DATE_CONFLICT');
  });

  it('rejects an inverted date range', async () => {
    const r = await addTerm({ name: 'Backwards', start_date: '2027-04-02', end_date: '2027-01-10' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TERM_DATE_CONFLICT');
  });
});

describe('editing a term', () => {
  it('shifts a term when the calendar moves, and records an audit entry', async () => {
    const created = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    const termId = created.body.data.id;

    const r = await patchTerm(termId, { start_date: '2027-01-17', end_date: '2027-04-09' });
    expect(r.status).toBe(200);
    expect(r.body.data.start_date).toContain('2027-01-17');

    const audit = await pool.query(
      `SELECT action_type, old_value, new_value FROM audit_logs WHERE entity = 'terms' AND entity_id = $1`,
      [termId]
    );
    expect(audit.rows.map(a => a.action_type)).toContain('TERM_UPDATED');
  });

  it('can rename a term without touching its dates', async () => {
    const created = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    const r = await patchTerm(created.body.data.id, { name: 'Second Term (revised)' });
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe('Second Term (revised)');
    expect(r.body.data.start_date).toContain('2027-01-10');
  });

  it('rejects an edit that would overlap another term', async () => {
    const created = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    // Pull its start back into the seeded First Term (ends 2026-12-18).
    const r = await patchTerm(created.body.data.id, { start_date: '2026-12-10' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TERM_DATE_CONFLICT');
  });

  it('allows a term to keep its own dates (does not clash with itself)', async () => {
    const created = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    const r = await patchTerm(created.body.data.id, { name: 'Renamed', end_date: '2027-04-02' });
    expect(r.status).toBe(200);
  });

  it('404s for a term id that is not in this session', async () => {
    const r = await patchTerm(I.termB, { name: 'Nope' });
    expect(r.status).toBe(404);
  });

  it('refuses a teacher', async () => {
    const created = await addTerm({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    const r = await request(app)
      .patch(`${base}/sessions/${I.sessionA}/terms/${created.body.data.id}`)
      .set('Authorization', tokens.math())
      .send({ name: 'Teacher edit' });
    expect(r.status).toBe(403);
  });
});
