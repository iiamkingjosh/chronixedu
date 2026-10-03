/**
 * A school's complete export as one zip (3 Oct 2026): every dataset as CSV, every stored file, and a
 * manifest that accounts for each file. The DPA and Terms §22 promise "a complete export"; before
 * this, the CSVs were complete and the files (student photos, submissions, report cards) were not
 * in it at all.
 *
 * - **No links of any kind.** A signed URL in an export expires and leaves the school holding a
 *   dead reference. Files go in as bytes; the manifest names each one by its path in the zip.
 * - **Streamed.** Bytes start leaving at once, so a large school never waits on a time-to-first-
 *   byte limit (Cloudflare's is 100 s), and files go through one at a time, so memory stays flat:
 *   the whole archive is never held.
 * - **Tenant-scoped by the same prefixes deletion uses** (config/storagePrefixes.json), and the
 *   records that name files are read with the school id as $1, as every export query is.
 * - **Nothing is dropped silently.** A record that names a file Storage does not have is listed in
 *   the manifest as missing_in_storage and the export continues: refusing all of a school's data
 *   because one photo is gone would withhold the rest, and the manifest makes each gap explicit. A
 *   stored file no record names is included, as unreferenced. A file that cannot be read after one
 *   retry is listed as read_failed.
 */
import crypto from 'crypto';
import archiver from 'archiver';
import type { Writable } from 'stream';
import pool from '../db/client';
import { supabaseAdmin } from '../supabaseClient';
import { logger } from '../config/logger';
import { csvCell } from './csv';
import { EXPORT_DATASETS, exportDatasetCsv } from '../db/queries/schoolExport';
import { storagePrefixes, assetsBucket } from '../config/storagePrefixes';

/**
 * Every column that names a stored file, with the query that reads it for one school ($1). The
 * completeness test reads every public column named like a file reference and fails unless it is
 * here or in NOT_FILE_COLUMNS with a reason (schoolExportArchive.db.test.ts).
 */
export interface FileColumn {
  /** table.column, or table.column->key for a JSON field. */
  ref: string;
  /** The bucket a bare path (not a URL) refers to. */
  bucket: () => string;
  /** Returns (id, value) for the school's rows that name a file. */
  sql: string;
}

const STUDENTS = `(SELECT id FROM students WHERE school_id = $1)`;

export const FILE_COLUMNS: FileColumn[] = [
  { ref: 'school_settings.identity_config->logo_url', bucket: assetsBucket,
    sql: `SELECT school_id::text AS id, identity_config->>'logo_url' AS value FROM school_settings WHERE school_id = $1` },
  { ref: 'school_settings.identity_config->stamp_url', bucket: assetsBucket,
    sql: `SELECT school_id::text AS id, identity_config->>'stamp_url' AS value FROM school_settings WHERE school_id = $1` },
  { ref: 'school_settings.identity_config->signature_url', bucket: assetsBucket,
    sql: `SELECT school_id::text AS id, identity_config->>'signature_url' AS value FROM school_settings WHERE school_id = $1` },
  { ref: 'schools.logo_url', bucket: assetsBucket,
    sql: `SELECT id::text AS id, logo_url AS value FROM schools WHERE id = $1` },
  { ref: 'schools.stamp_url', bucket: assetsBucket,
    sql: `SELECT id::text AS id, stamp_url AS value FROM schools WHERE id = $1` },
  { ref: 'students.photo_url', bucket: assetsBucket,
    sql: `SELECT id::text AS id, photo_url AS value FROM students WHERE school_id = $1` },
  { ref: 'users.signature_url', bucket: assetsBucket,
    sql: `SELECT id::text AS id, signature_url AS value FROM users WHERE school_id = $1` },
  { ref: 'report_cards.pdf_url', bucket: () => 'report-cards',
    sql: `SELECT id::text AS id, pdf_url AS value FROM report_cards WHERE student_id IN ${STUDENTS}` },
  { ref: 'assignments.attachment_url', bucket: assetsBucket,
    sql: `SELECT id::text AS id, attachment_url AS value FROM assignments WHERE school_id = $1` },
  { ref: 'assignment_submissions.file_url', bucket: assetsBucket,
    sql: `SELECT sub.id::text AS id, sub.file_url AS value FROM assignment_submissions sub
            JOIN assignments a ON a.id = sub.assignment_id WHERE a.school_id = $1` },
];

/** Columns whose names look like file references but are not, each with why. */
export const NOT_FILE_COLUMNS: Record<string, string> = {};

/**
 * Documents the system generates at a path that names their owner, with no column pointing back
 * (3 Oct 2026). Receipts are written to receipts/<school>/<payment id>.pdf and transcripts to
 * transcripts/<school>/<student id>.pdf. Without this, every receipt was reported as unreferenced,
 * permanently and by construction, so a normal file read as an anomaly. The owner is read from the
 * path and its record looked up, so "unreferenced" keeps its meaning: nothing owns this file. A
 * blanket "generated" status would have called a receipt normal without checking its payment exists.
 */
export interface DerivedFile {
  ref: string;
  bucket: () => string;
  /** Captures the owner's id from the storage path. */
  pattern: RegExp;
  /** The school's owner ids ($1). */
  sql: string;
}

export const DERIVED_FILES: DerivedFile[] = [
  { ref: 'payments.id (receipt)', bucket: () => 'report-cards', pattern: /^receipts\/[^/]+\/([0-9a-f-]{36})\.pdf$/i,
    sql: `SELECT id::text AS id FROM payments WHERE school_id = $1` },
  { ref: 'students.id (transcript)', bucket: () => 'report-cards', pattern: /^transcripts\/[^/]+\/([0-9a-f-]{36})\.pdf$/i,
    sql: `SELECT id::text AS id FROM students WHERE school_id = $1` },
];

/** A file value is a Storage URL (public, signed or authenticated) or a bare path in the column's bucket. */
export function parseStorageRef(value: string, defaultBucket: string): { bucket: string; path: string } | null {
  const v = value.trim();
  if (!v) return null;
  const m = v.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/([^?#]+)/);
  if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) };
  if (/^https?:\/\//i.test(v)) return null; // a URL that is not ours: nothing in Storage to fetch
  return { bucket: defaultBucket, path: v.replace(/^\/+/, '') };
}

export type ManifestStatus = 'included' | 'unreferenced' | 'missing_in_storage' | 'read_failed';

export interface ManifestRow {
  zip_path: string;
  bucket: string;
  storage_path: string;
  bytes: number | null;
  sha256: string | null;
  referenced_by: string;
  status: ManifestStatus;
}

/** What went into one export: recorded on its completion audit row, so it can be reconciled. */
export interface ArchiveCounts {
  datasets: number;
  files_included: number;
  unreferenced: number;
  missing_in_storage: number;
  read_failed: number;
  /** Total bytes of the files in files/. */
  bytes: number;
  /** SHA-256 of manifest.csv exactly as written into the zip. */
  manifest_sha256: string;
}

/** Every object under a prefix, walking folders (Storage lists one level at a time). */
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabaseAdmin.storage.from(bucket).list(dir, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`Storage list failed for ${bucket}/${dir}: ${error.message}`);
      for (const item of data ?? []) {
        const path = dir ? `${dir}/${item.name}` : item.name;
        // A folder has no id; a file has one.
        if (item.id === null || item.id === undefined) await walk(path);
        else out.push(path);
      }
      if (!data || data.length < 1000) break;
    }
  };
  await walk(prefix.replace(/\/+$/, ''));
  return out;
}

async function download(bucket: string, path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message ?? 'no data');
  return Buffer.from(await data.arrayBuffer());
}

const README = [
  'Chronix Edu: your school\'s data export',
  '',
  'data/       One CSV file per kind of record, every column.',
  'files/      Every file stored for your school, by its storage location: student photos,',
  '            signatures, logos, assignment attachments and submissions, report cards,',
  '            receipts and transcripts.',
  'manifest.csv  One line per file: where it is in this archive, its size and SHA-256 checksum,',
  '            which record names it, and its status:',
  '              included            in files/, named by the record shown (a receipt by its',
  '                                  payment, a transcript by its student)',
  '              unreferenced        in files/, but no record names it',
  '              missing_in_storage  a record names it, but it was not in storage; not in files/',
  '              read_failed         it is in storage but could not be read; not in files/',
  '',
  'There are no links in this export. Everything it refers to is inside it.',
  '',
].join('\n');

/**
 * Writes the school's archive to `out` (the HTTP response) as a zip stream, and resolves with what
 * went in once the stream has finished. The caller sets headers first.
 */
export async function streamSchoolArchive(schoolId: string, out: Writable): Promise<ArchiveCounts> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('close', () => resolve());
    archive.on('error', reject);
  });
  archive.on('warning', (err) => logger.warn('school_export_archive_warning', { school_id: schoolId, error: err.message }));
  archive.pipe(out);

  archive.append(README, { name: 'README.txt' });

  const counts: ArchiveCounts = { datasets: 0, files_included: 0, unreferenced: 0, missing_in_storage: 0, read_failed: 0, bytes: 0, manifest_sha256: '' };

  for (const d of EXPORT_DATASETS) {
    const csv = await exportDatasetCsv(schoolId, d.key);
    if (!csv) continue;
    archive.append(csv.csv, { name: `data/${csv.filename}` });
    counts.datasets += 1;
  }

  // What the records name, keyed by bucket/path.
  const references = new Map<string, { bucket: string; path: string; refs: string[] }>();
  for (const col of FILE_COLUMNS) {
    const { rows } = await pool.query<{ id: string; value: string | null }>(col.sql, [schoolId]);
    for (const r of rows) {
      if (!r.value) continue;
      const parsed = parseStorageRef(r.value, col.bucket());
      if (!parsed) continue;
      const key = `${parsed.bucket}/${parsed.path}`;
      const entry = references.get(key) ?? { ...parsed, refs: [] };
      entry.refs.push(`${col.ref}:${r.id}`);
      references.set(key, entry);
    }
  }

  // The owners of generated documents, by kind.
  const derivedOwners = new Map<DerivedFile, Set<string>>();
  for (const d of DERIVED_FILES) {
    const { rows } = await pool.query<{ id: string }>(d.sql, [schoolId]);
    derivedOwners.set(d, new Set(rows.map(r => r.id.toLowerCase())));
  }
  const derivedRef = (bucket: string, path: string): string | null => {
    for (const d of DERIVED_FILES) {
      if (d.bucket() !== bucket) continue;
      const m = path.match(d.pattern);
      if (m && derivedOwners.get(d)!.has(m[1].toLowerCase())) return `${d.ref}:${m[1]}`;
    }
    return null;
  };

  const manifest: ManifestRow[] = [];
  const seen = new Set<string>();
  for (const { bucket, prefix } of storagePrefixes(schoolId)) {
    for (const path of await listAll(bucket, prefix)) {
      const key = `${bucket}/${path}`;
      if (seen.has(key)) continue; // report-cards prefixes cannot overlap, but never write a file twice
      seen.add(key);
      const named = references.get(key)?.refs.join(' ') ?? derivedRef(bucket, path);
      const zipPath = `files/${bucket}/${path}`;
      let bytes: Buffer | null = null;
      for (let attempt = 1; attempt <= 2 && !bytes; attempt += 1) {
        try {
          bytes = await download(bucket, path);
        } catch (err) {
          if (attempt === 2) logger.warn('school_export_file_read_failed', { school_id: schoolId, bucket, path, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (!bytes) {
        counts.read_failed += 1;
        manifest.push({ zip_path: '', bucket, storage_path: path, bytes: null, sha256: null, referenced_by: named ?? '', status: 'read_failed' });
        continue;
      }
      archive.append(bytes, { name: zipPath });
      counts.bytes += bytes.length;
      const status: ManifestStatus = named ? 'included' : 'unreferenced';
      if (named) counts.files_included += 1; else counts.unreferenced += 1;
      manifest.push({
        zip_path: zipPath, bucket, storage_path: path, bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        referenced_by: named ?? '', status,
      });
    }
  }

  // Named by a record, absent from storage: listed, never silently dropped.
  for (const [key, ref] of references) {
    if (seen.has(key)) continue;
    counts.missing_in_storage += 1;
    manifest.push({ zip_path: '', bucket: ref.bucket, storage_path: ref.path, bytes: null, sha256: null, referenced_by: ref.refs.join(' '), status: 'missing_in_storage' });
  }
  if (counts.missing_in_storage > 0) {
    logger.warn('school_export_files_missing', { school_id: schoolId, missing_in_storage: counts.missing_in_storage });
  }

  const columns: Array<keyof ManifestRow> = ['zip_path', 'bucket', 'storage_path', 'bytes', 'sha256', 'referenced_by', 'status'];
  const manifestCsv = Buffer.from([columns.join(','), ...manifest.map(m => columns.map(c => csvCell(m[c])).join(','))].join('\n'), 'utf8');
  // The fingerprint of the manifest the school receives, for the completion audit row.
  counts.manifest_sha256 = crypto.createHash('sha256').update(manifestCsv).digest('hex');
  archive.append(manifestCsv, { name: 'manifest.csv' });

  await archive.finalize();
  await finished;
  return counts;
}
