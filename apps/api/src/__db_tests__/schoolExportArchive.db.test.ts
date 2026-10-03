/**
 * The full export as one zip (3 Oct 2026): every dataset, every stored file, and a manifest. The DPA
 * promises a complete export; until now the files were not in it.
 *
 * Supabase Storage is faked in memory, with the same one-folder-at-a-time listing Supabase does, and
 * holds files for TWO schools. Every "absent" is preceded by the matching "present" (doctrine 16): an
 * empty zip would pass "School B's files are not in it" on its own.
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { seed, IDS as I, tokens, pool } from './helpers';
import schoolsRoutes from '../routes/schools';
import { verifyToken } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import { EXPORT_DATASETS } from '../db/queries/schoolExport';
import { FILE_COLUMNS, NOT_FILE_COLUMNS } from '../services/schoolExportArchive';
import { assetsBucket } from '../config/storagePrefixes';

// bucket/path -> bytes. Named mock* so the hoisted factory may reach them; read only when called.
const mockStore = new Map<string, Buffer>();
const mockFailReads = new Set<string>();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { storage: { from: (bucket: string) => ({
    // Supabase lists one level: files carry an id, folders do not.
    list: async (dir: string, opts: { limit: number; offset: number }) => {
      const prefix = dir ? `${dir}/` : '';
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const key of mockStore.keys()) {
        if (!key.startsWith(`${bucket}/`)) continue;
        const p = key.slice(bucket.length + 1);
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) files.add(rest); else folders.add(rest.slice(0, slash));
      }
      const items = [
        ...[...folders].sort().map(name => ({ name, id: null })),
        ...[...files].sort().map(name => ({ name, id: `id-${name}` })),
      ];
      return { data: items.slice(opts.offset, opts.offset + opts.limit), error: null };
    },
    download: async (path: string) => {
      const key = `${bucket}/${path}`;
      if (mockFailReads.has(key)) return { data: null, error: { message: 'simulated read failure' } };
      const bytes = mockStore.get(key);
      return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: { message: 'Object not found' } };
    },
  }) } },
}));

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken, schoolsRoutes);
app.use(errorHandler);

const A = I.schoolA;
const B = I.schoolB;
const ASSETS = assetsBucket();
const publicUrl = (bucket: string, path: string) => `https://example.supabase.co/storage/v1/object/public/${bucket}/${path}`;
const put = (bucket: string, path: string, text: string) => mockStore.set(`${bucket}/${path}`, Buffer.from(text));
const sha = (text: string) => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');

/** Collects the zip's bytes: supertest would otherwise try to read the body as text. */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};
const exportZip = (auth: string, school = A) =>
  request(app).get(`/api/schools/${school}/export/archive`).set('Authorization', auth).buffer(true).parse(binary);

beforeEach(async () => {
  await seed();
  mockStore.clear();
  mockFailReads.clear();

  // School A: a logo (in identity_config), s1's photo, s1's report card, a stray file nothing names,
  // a file that cannot be read, and s2's photo, which a record names and Storage does not hold.
  put(ASSETS, `schools/${A}/logo.png`, 'A-logo');
  put(ASSETS, `schools/${A}/students/${I.s1}/photo.jpg`, 'A-s1-photo');
  put('report-cards', `${A}/${I.termA}/${I.s1}.pdf`, 'A-s1-report');
  put(ASSETS, `schools/${A}/old/stray.txt`, 'A-stray');
  put(ASSETS, `schools/${A}/students/${I.s3OtherClass}/photo.jpg`, 'A-unreadable');
  mockFailReads.add(`${ASSETS}/schools/${A}/students/${I.s3OtherClass}/photo.jpg`);
  await pool.query(
    `INSERT INTO school_settings (school_id, identity_config, academic_config) VALUES ($1, $2::jsonb, '{}'::jsonb)
     ON CONFLICT (school_id) DO UPDATE SET identity_config = EXCLUDED.identity_config`,
    [A, JSON.stringify({ logo_url: publicUrl(ASSETS, `schools/${A}/logo.png`) })]);
  await pool.query(`UPDATE students SET photo_url = $2 WHERE id = $1`, [I.s1, publicUrl(ASSETS, `schools/${A}/students/${I.s1}/photo.jpg`)]);
  await pool.query(`UPDATE students SET photo_url = $2 WHERE id = $1`, [I.s2, publicUrl(ASSETS, `schools/${A}/students/${I.s2}/photo.jpg`)]);
  await pool.query(
    `INSERT INTO report_cards (student_id, term_id, school_id, pdf_url, generated_at, is_published) VALUES ($1, $2, $3, $4, NOW(), false)`,
    [I.s1, I.termA, A, `${A}/${I.termA}/${I.s1}.pdf`]);

  // School B: its own files under its own prefixes, in both buckets.
  put(ASSETS, `schools/${B}/logo.png`, 'B-logo');
  put(ASSETS, `schools/${B}/students/${I.sOtherSchool}/photo.jpg`, 'B-photo');
  put('report-cards', `${B}/${I.termB}/${I.sOtherSchool}.pdf`, 'B-report');
  put('report-cards', `receipts/${B}/pay-1.pdf`, 'B-receipt');
  await pool.query(`UPDATE students SET photo_url = $2 WHERE id = $1`, [I.sOtherSchool, publicUrl(ASSETS, `schools/${B}/students/${I.sOtherSchool}/photo.jpg`)]);
});
afterAll(async () => { await pool.end(); });

function manifestOf(zip: AdmZip): Array<Record<string, string>> {
  const [header, ...lines] = zip.getEntry('manifest.csv')!.getData().toString('utf8').split('\n');
  const cols = header.split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.replace(/^"|"$/g, '')])));
}

describe('the full export, as one zip', () => {
  it('holds every dataset and exactly School A\'s files, byte for byte, and none of School B\'s', async () => {
    const res = await exportZip(tokens.principalA());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map(e => e.entryName);

    // Present, first: the readme, the manifest, every dataset, and A's readable files.
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'manifest.csv', ...EXPORT_DATASETS.map(d => `data/${d.key}.csv`)]));
    const files = names.filter(n => n.startsWith('files/')).sort();
    expect(files).toEqual([
      `files/${ASSETS}/schools/${A}/logo.png`,
      `files/${ASSETS}/schools/${A}/old/stray.txt`,
      `files/${ASSETS}/schools/${A}/students/${I.s1}/photo.jpg`,
      `files/report-cards/${A}/${I.termA}/${I.s1}.pdf`,
    ].sort());
    expect(zip.getEntry(`files/${ASSETS}/schools/${A}/logo.png`)!.getData().toString()).toBe('A-logo');
    expect(zip.getEntry(`files/report-cards/${A}/${I.termA}/${I.s1}.pdf`)!.getData().toString()).toBe('A-s1-report');

    // Absent, second: nothing of School B's, by its id or by its content.
    expect(names.filter(n => n.includes(B))).toEqual([]);
    for (const e of zip.getEntries().filter(x => x.entryName.startsWith('files/'))) {
      expect(e.getData().toString()).not.toMatch(/^B-/);
    }
  });

  it('accounts for every file in the manifest, including the ones it could not include', async () => {
    const zip = new AdmZip((await exportZip(tokens.principalA())).body as Buffer);
    const byPath = Object.fromEntries(manifestOf(zip).map(r => [`${r.bucket}/${r.storage_path}`, r]));

    expect(byPath[`${ASSETS}/schools/${A}/logo.png`]).toMatchObject({
      status: 'included', zip_path: `files/${ASSETS}/schools/${A}/logo.png`, bytes: '6', sha256: sha('A-logo'),
      referenced_by: `school_settings.identity_config->logo_url:${A}`,
    });
    expect(byPath[`${ASSETS}/schools/${A}/students/${I.s1}/photo.jpg`]).toMatchObject({ status: 'included', referenced_by: `students.photo_url:${I.s1}` });
    expect(byPath[`report-cards/${A}/${I.termA}/${I.s1}.pdf`]).toMatchObject({ status: 'included', sha256: sha('A-s1-report') });
    expect(byPath[`${ASSETS}/schools/${A}/old/stray.txt`]).toMatchObject({ status: 'unreferenced', referenced_by: '' });
    // Named by a record, not in storage: listed, not dropped, and not in files/.
    expect(byPath[`${ASSETS}/schools/${A}/students/${I.s2}/photo.jpg`]).toMatchObject({
      status: 'missing_in_storage', zip_path: '', referenced_by: `students.photo_url:${I.s2}`,
    });
    // In storage, unreadable after a retry: listed, and the export went on.
    expect(byPath[`${ASSETS}/schools/${A}/students/${I.s3OtherClass}/photo.jpg`]).toMatchObject({ status: 'read_failed', zip_path: '' });

    // Every file entry in the zip has its manifest row, and nothing of School B's has one.
    const included = manifestOf(zip).filter(r => r.zip_path).map(r => r.zip_path).sort();
    expect(included).toEqual(zip.getEntries().map(e => e.entryName).filter(n => n.startsWith('files/')).sort());
    expect(manifestOf(zip).filter(r => r.storage_path.includes(B))).toEqual([]);
  });

  it('is audited, and refused to anyone but the school\'s principal', async () => {
    expect((await exportZip(tokens.principalA())).status).toBe(200);
    const audit = await pool.query(`SELECT new_value FROM audit_logs WHERE action_type = 'SCHOOL_DATA_EXPORTED' AND school_id = $1`, [A]);
    expect(audit.rows.map(r => r.new_value)).toEqual([expect.objectContaining({ dataset: 'archive' })]);

    expect((await exportZip(tokens.math())).status).toBe(403);
    expect((await exportZip(tokens.principalB())).status).toBe(403);
  });

  it('names every column that holds a file, so a new one cannot be left out of the export', async () => {
    const { rows } = await pool.query<{ col: string }>(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name ~ '(_url|_path)$' ORDER BY 1`);
    // The control: the query sees the columns the export reads.
    expect(rows.map(r => r.col)).toEqual(expect.arrayContaining(['students.photo_url', 'report_cards.pdf_url']));
    const known = new Set([...FILE_COLUMNS.map(c => c.ref), ...Object.keys(NOT_FILE_COLUMNS)]);
    expect(rows.map(r => r.col).filter(c => !known.has(c))).toEqual([]);
  });
});
