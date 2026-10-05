/**
 * School files are recorded by their path in a private bucket, never by a public link (5 Oct 2026;
 * migration 061; services/schoolAssets.ts). Tested here against the real routes and database:
 *  - each of the five image uploads records the path, and answers with a link that expires;
 *  - the school record a screen reads carries links, while the stored (and cached) row keeps paths;
 *  - the identity route refuses an image address instead of storing one;
 *  - migration 061 converts the public links already stored, and touches nothing else.
 *
 * Supabase Storage is an in-memory stand-in that records what it is asked. getPublicUrl is a spy that
 * must never be called: a public link is what this change removes.
 */
const mockStore = new Map<string, Buffer>();
const mockGetPublicUrl = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { storage: { from: (bucket: string) => ({
    upload: async (path: string, bytes: Buffer) => { mockStore.set(`${bucket}/${path}`, bytes); return { data: { path }, error: null }; },
    createSignedUrl: async (path: string, ttl: number) => (mockStore.has(`${bucket}/${path}`)
      ? { data: { signedUrl: `https://signed.test/${bucket}/${path}?expires_in=${ttl}` }, error: null }
      : { data: null, error: { message: 'Object not found' } }),
    getPublicUrl: (path: string) => { mockGetPublicUrl(path); return { data: { publicUrl: `https://public.test/${bucket}/${path}` } }; },
  }) } },
}));

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { cache, schoolCacheKey } from '../services/cacheService';

const app = buildApp();
const A = I.schoolA;
const BUCKET = 'school-assets';
// A 1x1 PNG: real magic bytes, so the uploads' file-type check accepts it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PUBLIC = (p: string) => `https://pgnpmqaowrnmsytpehwc.supabase.co/storage/v1/object/public/${BUCKET}/${p}`;

const identity = async () =>
  (await pool.query(`SELECT identity_config FROM school_settings WHERE school_id = $1`, [A])).rows[0]?.identity_config ?? {};

beforeEach(async () => {
  await seed();
  // Every school gets this row when it is created (insertSchool); the seed has none.
  await pool.query(`INSERT INTO school_settings (school_id, identity_config) VALUES ($1, '{}'::jsonb) ON CONFLICT (school_id) DO NOTHING`, [A]);
  mockStore.clear();
  mockGetPublicUrl.mockClear();
  cache.del(schoolCacheKey(A, 'data'));
});

afterAll(async () => {
  await pool.end();
});

describe('the five image uploads record a path, and answer with a link that expires', () => {
  const cases = [
    { name: 'school logo', url: `/api/schools/${A}/logo`, field: 'logo', key: 'logo_url', stored: async () => (await identity()).logo_url, expected: `schools/${A}/logo.png` },
    { name: 'school signature', url: `/api/schools/${A}/signature`, field: 'signature', key: 'signature_url', stored: async () => (await identity()).signature_url, expected: `schools/${A}/signature.png` },
    { name: 'school stamp', url: `/api/schools/${A}/stamp`, field: 'stamp', key: 'stamp_url', stored: async () => (await identity()).stamp_url, expected: `schools/${A}/stamp.png` },
    {
      name: 'staff signature', url: `/api/schools/${A}/users/${I.mathTeacher}/signature`, field: 'signature', key: 'signature_url',
      stored: async () => (await pool.query(`SELECT signature_url FROM users WHERE id = $1`, [I.mathTeacher])).rows[0].signature_url,
      expected: `schools/${A}/signatures/${I.mathTeacher}.png`,
    },
    {
      name: 'student photo', url: `/api/schools/${A}/students/${I.s1}/photo`, field: 'photo', key: 'photo_url',
      stored: async () => (await pool.query(`SELECT photo_url FROM students WHERE id = $1`, [I.s1])).rows[0].photo_url,
      expected: `schools/${A}/students/${I.s1}/photo.png`,
    },
  ];

  it.each(cases)('$name', async ({ url, field, key, stored, expected }) => {
    const res = await request(app).post(url).set('Authorization', tokens.principalA())
      .attach(field, PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(await stored()).toBe(expected);
    expect(mockStore.has(`${BUCKET}/${expected}`)).toBe(true);
    expect(res.body.data[key]).toBe(`https://signed.test/${BUCKET}/${expected}?expires_in=900`);
    expect(mockGetPublicUrl).not.toHaveBeenCalled();
  });

  it('the audit row records the path, not a link', async () => {
    await request(app).post(`/api/schools/${A}/logo`).set('Authorization', tokens.principalA())
      .attach('logo', PNG, { filename: 'x.png', contentType: 'image/png' });
    const row = (await pool.query(`SELECT new_value FROM audit_logs WHERE action_type = 'LOGO_UPLOAD'`)).rows[0];
    expect(row.new_value).toEqual({ logo_url: `schools/${A}/logo.png` });
  });
});

describe('the school record a screen reads', () => {
  it('carries links that expire, made on every read, while the stored and cached row keeps the path', async () => {
    await request(app).post(`/api/schools/${A}/logo`).set('Authorization', tokens.principalA())
      .attach('logo', PNG, { filename: 'x.png', contentType: 'image/png' });
    for (let read = 0; read < 2; read++) { // the second read is served from the 5-minute cache
      const res = await request(app).get(`/api/schools/${A}`).set('Authorization', tokens.principalA());
      expect(res.status).toBe(200);
      expect(res.body.data.identity_config.logo_url).toBe(`https://signed.test/${BUCKET}/schools/${A}/logo.png?expires_in=900`);
      expect(res.body.data.identity_config.stamp_url).toBeNull();
    }
    expect((await identity()).logo_url).toBe(`schools/${A}/logo.png`);
    const cached = cache.get(schoolCacheKey(A, 'data')) as { identity_config: { logo_url: string } } | undefined;
    expect(cached?.identity_config.logo_url).toBe(`schools/${A}/logo.png`);
  });

  it('a value from before the change, a public link, is shown through a link that expires too', async () => {
    mockStore.set(`${BUCKET}/schools/${A}/logo.png`, PNG);
    await pool.query(`UPDATE school_settings SET identity_config = identity_config || jsonb_build_object('logo_url', $2::text) WHERE school_id = $1`,
      [A, PUBLIC(`schools/${A}/logo.png`)]);
    const res = await request(app).get(`/api/schools/${A}`).set('Authorization', tokens.principalA());
    expect(res.body.data.identity_config.logo_url).toBe(`https://signed.test/${BUCKET}/schools/${A}/logo.png?expires_in=900`);
  });
});

describe('the identity route takes no image address', () => {
  it.each(['logo_url', 'stamp_url', 'signature_url'])('%s is refused by name, and nothing is stored', async (field) => {
    const before = await identity();
    const res = await request(app).patch(`/api/schools/${A}/identity`).set('Authorization', tokens.principalA())
      .send({ name: 'Renamed', [field]: 'http://redis.railway.internal:6379/x.png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SET_BY_UPLOAD');
    expect(res.body.error.message).toContain(field);
    expect(await identity()).toEqual(before);
  });

  it('the same request without the address is accepted (the control)', async () => {
    const res = await request(app).patch(`/api/schools/${A}/identity`).set('Authorization', tokens.principalA())
      .send({ motto: 'Light and learning' });
    expect(res.status).toBe(200);
    expect((await identity()).motto).toBe('Light and learning');
  });
});

describe('migration 061 converts the public links already stored', () => {
  const MIGRATION = fs.readFileSync(path.join(__dirname, '../../../../migrations/061_school_assets_store_paths.sql'), 'utf8');

  it('rewrites each public link to its path, leaves every other value alone, and changes nothing on a second run', async () => {
    const other = 'https://cdn.example.org/logo.png';
    await pool.query(
      `UPDATE school_settings SET identity_config = identity_config || jsonb_build_object('logo_url', $2::text, 'stamp_url', $3::text) WHERE school_id = $1`,
      [A, PUBLIC(`schools/${A}/logo.png`), other]);
    await pool.query(`UPDATE users SET signature_url = $2 WHERE id = $1`, [I.mathTeacher, PUBLIC(`schools/${A}/signatures/t.png`)]);
    await pool.query(`UPDATE users SET signature_url = $2 WHERE id = $1`, [I.engTeacher, `schools/${A}/signatures/already-a-path.png`]);
    await pool.query(`UPDATE students SET photo_url = $2 WHERE id = $1`, [I.s1, PUBLIC(`schools/${A}/students/${I.s1}/photo.png`)]);

    for (let run = 0; run < 2; run++) {
      await pool.query(MIGRATION);
      const id = await identity();
      expect(id.logo_url).toBe(`schools/${A}/logo.png`);
      expect(id.stamp_url).toBe(other);
      expect(id).not.toHaveProperty('signature_url');
      const sig = await pool.query(`SELECT id, signature_url FROM users WHERE id = ANY($1) ORDER BY id`, [[I.mathTeacher, I.engTeacher]]);
      expect(Object.fromEntries(sig.rows.map(r => [r.id, r.signature_url]))).toEqual({
        [I.mathTeacher]: `schools/${A}/signatures/t.png`,
        [I.engTeacher]: `schools/${A}/signatures/already-a-path.png`,
      });
      expect((await pool.query(`SELECT photo_url FROM students WHERE id = $1`, [I.s1])).rows[0].photo_url)
        .toBe(`schools/${A}/students/${I.s1}/photo.png`);
    }
  });
});
