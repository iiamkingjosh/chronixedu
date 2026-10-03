/**
 * One list of where a school's files live (config/storagePrefixes.json, 3 Oct 2026), read by the data
 * export and by the deletion script. These checks keep it the only list, and keep every upload inside
 * it: a new upload path outside the list would be neither exported nor deleted.
 */
import fs from 'fs';
import path from 'path';
import { STORAGE_PREFIX_TEMPLATES, storagePrefixes } from '../config/storagePrefixes';

const API = path.join(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(API, ...p), 'utf8');

/** `schools/${req.params.schoolId}/logo.${ext}` → `schools/{schoolId}/logo.*` */
function normalise(template: string): string {
  return template.replace(/\$\{[^}]*\}/g, m => (/schoolId/.test(m) ? '{schoolId}' : '*'));
}
const underAPrefix = (template: string) =>
  STORAGE_PREFIX_TEMPLATES.some(p => normalise(template).startsWith(p.template));

/** Every `storagePath = \`...\`` in the app's code: the paths files are uploaded to. */
function uploadPaths(): Array<{ file: string; template: string }> {
  const out: Array<{ file: string; template: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['__tests__', '__db_tests__'].includes(e.name)) walk(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/storagePath\s*=\s*`([^`]+)`/g)) {
        out.push({ file: path.relative(API, full), template: m[1] });
      }
    }
  };
  walk(path.join(API, 'src'));
  return out;
}

describe('where a school\'s files live', () => {
  it('is one list, read by both the export and the deletion script', () => {
    expect(read('scripts', 'delete-school-data.js')).toContain(`require('../src/config/storagePrefixes.json')`);
    expect(read('src', 'services', 'schoolExportArchive.ts')).toMatch(/from '\.\.\/config\/storagePrefixes'/);
    // Neither keeps a private copy of a prefix.
    expect(read('scripts', 'delete-school-data.js')).not.toMatch(/prefix: `schools\//);
    expect(storagePrefixes('abc')).toEqual([
      { bucket: process.env.SUPABASE_STORAGE_BUCKET || 'school-assets', prefix: 'schools/abc/' },
      { bucket: 'report-cards', prefix: 'abc/' },
      { bucket: 'report-cards', prefix: 'receipts/abc/' },
      { bucket: 'report-cards', prefix: 'transcripts/abc/' },
    ]);
  });

  it('holds every path the app uploads a file to', () => {
    const uploads = uploadPaths();
    // The scanner finds the ten upload sites (logo, signature, stamp, student photo, staff
    // signature, assignment attachment and submission, receipt, report card, transcript).
    expect(uploads.length).toBeGreaterThanOrEqual(10);
    // The control: a path outside the list is caught.
    expect(underAPrefix('uploads/${userId}/x.pdf')).toBe(false);
    expect(underAPrefix('schools/${req.params.schoolId}/logo.${ext}')).toBe(true);
    expect(uploads.filter(u => !underAPrefix(u.template))).toEqual([]);
  });
});
