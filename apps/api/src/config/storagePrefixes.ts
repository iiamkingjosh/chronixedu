/**
 * Where a school's files live in Supabase Storage (3 Oct 2026). The list is in storagePrefixes.json,
 * which the deletion script reads too, so a new upload path lands in the export and in deletion
 * together, or in neither. storagePrefixes.test.ts fails if an upload in src writes outside it.
 */
import config from './storagePrefixes.json';

export interface StoragePrefix { bucket: string; prefix: string }

export function assetsBucket(): string {
  return process.env.SUPABASE_STORAGE_BUCKET || 'school-assets';
}

export function storagePrefixes(schoolId: string): StoragePrefix[] {
  return config.prefixes.map(p => ({
    bucket: p.bucket === 'assets' ? assetsBucket() : p.bucket,
    prefix: p.template.replace('{schoolId}', schoolId),
  }));
}

/** The raw templates, for the ratchet test. */
export const STORAGE_PREFIX_TEMPLATES: ReadonlyArray<{ bucket: string; template: string }> = config.prefixes;
