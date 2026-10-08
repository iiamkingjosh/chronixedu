/**
 * The school's address is saved where it is printed (audit, 8 Oct 2026).
 *
 * Settings → School Identity has an Address field, and receipts and report cards print
 * `identity_config.address`. But the route's schema had no address, and zod drops keys it does
 * not know, so every save answered "saved" and kept nothing. Onboarding, meanwhile, wrote the
 * address to `schools.address`, which nothing reads.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const identity = (body: object) => request(app).patch(`/api/schools/${I.schoolA}/identity`).set('Authorization', tokens.principalA()).send(body);
const stored = async () => (await pool.query<{ identity_config: Record<string, unknown> }>(
  `SELECT identity_config FROM school_settings WHERE school_id = $1`, [I.schoolA])).rows[0]?.identity_config ?? {};

beforeEach(async () => {
  await seed();
  await pool.query(`INSERT INTO school_settings (school_id, identity_config) VALUES ($1, '{"motto": "Onward"}'::jsonb)`, [I.schoolA]);
});
afterAll(() => pool.end());

it('saves the address, and the next save keeps it unless it is changed', async () => {
  expect((await identity({ address: '  12 Allen Avenue, Ikeja  ' })).status).toBe(200);
  expect((await stored()).address).toBe('12 Allen Avenue, Ikeja');

  expect((await identity({ motto: 'Forward' })).status).toBe(200);
  expect(await stored()).toMatchObject({ address: '12 Allen Avenue, Ikeja', motto: 'Forward' });
});

it('an emptied address is stored empty, as an emptied motto is', async () => {
  await identity({ address: '12 Allen Avenue', motto: 'Onward' });
  expect((await identity({ address: '', motto: '' })).status).toBe(200);
  expect(await stored()).toMatchObject({ address: '', motto: '' });
});

it('refuses an address too long to print, and saves nothing from that request', async () => {
  const res = await identity({ address: 'x'.repeat(501), motto: 'Changed' });
  expect(res.status).toBe(400);
  expect(await stored()).toEqual({ motto: 'Onward' });
});

it('records the change, with what it replaced', async () => {
  await identity({ address: 'Old Road' });
  await identity({ address: 'New Road' });
  const rows = (await pool.query<{ old_value: Record<string, unknown> | null; new_value: Record<string, unknown> }>(
    `SELECT old_value, new_value FROM audit_logs WHERE school_id = $1 AND action_type = 'IDENTITY_UPDATE' ORDER BY created_at`, [I.schoolA])).rows;
  expect(rows).toHaveLength(2);
  expect(rows[1].old_value).toMatchObject({ address: 'Old Road' });
  expect(rows[1].new_value).toMatchObject({ address: 'New Road' });
});

describe('migration 064 moves the onboarding address to where documents read it', () => {
  const run064 = async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    await pool.query(readFileSync(join(__dirname, '../../../../migrations/064_school_address_in_identity.sql'), 'utf8'));
  };

  it('copies schools.address into identity_config, and never over an address already there', async () => {
    await pool.query(`UPDATE schools SET address = ' 5 Ring Road, Ibadan ' WHERE id = $1`, [I.schoolA]);
    await pool.query(`UPDATE schools SET address = 'Old onboarding address' WHERE id = $1`, [I.schoolB]);
    await pool.query(`INSERT INTO school_settings (school_id, identity_config) VALUES ($1, '{"address": "Typed in Settings"}'::jsonb)`, [I.schoolB]);

    await run064();
    expect(await stored()).toEqual({ motto: 'Onward', address: '5 Ring Road, Ibadan' });
    const b = (await pool.query(`SELECT identity_config FROM school_settings WHERE school_id = $1`, [I.schoolB])).rows[0].identity_config;
    expect(b).toEqual({ address: 'Typed in Settings' });

    await run064(); // idempotent
    expect(await stored()).toEqual({ motto: 'Onward', address: '5 Ring Road, Ibadan' });
  });
});
