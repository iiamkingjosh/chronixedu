import type { Page } from 'puppeteer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { supabaseAdmin } from '../supabaseClient';
import { assetsBucket } from '../config/storagePrefixes';
import { logger } from '../config/logger';

/**
 * The school-assets bucket: logos, the school signature and stamp, staff signatures, student photos,
 * assignment attachments and submissions. Private since 5 Oct 2026. It was public, so every link ever
 * shown opened the file for anyone who had it, signed in or not, and could not be withdrawn short of
 * deleting the file (WORKING-CHECKLIST X; SECURITY.md Round 37).
 *
 * A record stores the file's PATH in the bucket, never a URL (migration 061 converted the public links
 * already stored). Anything that shows a file asks for it here:
 *  - a screen gets a link that expires (signAsset);
 *  - a PDF gets the image itself, inside the page (assetDataUri), and its renderer may fetch nothing
 *    (refuseNetwork). So no stored value can make the server fetch an address.
 */
export const ASSET_SIGNED_URL_TTL_SECONDS = 15 * 60;

const STORAGE_URL = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/;

/**
 * The file's path in the assets bucket, from a stored value: a path, or a Supabase Storage link to
 * this bucket from before migration 061. Null for nothing, for another bucket, and for any other
 * address: such a value is never fetched.
 */
export function assetStoragePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const link = STORAGE_URL.exec(value);
  if (link) return link[1] === assetsBucket() ? decodeURIComponent(link[2]) : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value.replace(/^\/+/, '') || null;
}

/** A link to the file that works for ASSET_SIGNED_URL_TTL_SECONDS, for a screen. Null if there is no file to link to. */
export async function signAsset(value: string | null | undefined): Promise<string | null> {
  const path = assetStoragePath(value);
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage.from(assetsBucket()).createSignedUrl(path, ASSET_SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    logger.warn('school_asset_link_failed', { error: error?.message ?? 'no link returned' });
    return null;
  }
  return data.signedUrl;
}

/** The same object with each named field's stored value replaced by a link a screen can use. */
export async function withSignedAssets<T extends Record<string, unknown>>(row: T, fields: ReadonlyArray<keyof T>): Promise<T> {
  const out: Record<string, unknown> = { ...row };
  await Promise.all(fields.map(async f => { out[f as string] = await signAsset(row[f] as string | null | undefined); }));
  return out as T;
}

const EMBEDDABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The image itself as a data: URI, for a PDF template. Read from the bucket with the service role, so
 * it works while the bucket is private, and nothing else is fetched. Null when there is no file, it
 * cannot be read, or it is not a PNG, JPEG or WebP: the template then leaves the image out.
 */
export async function assetDataUri(value: string | null | undefined): Promise<string | null> {
  const path = assetStoragePath(value);
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage.from(assetsBucket()).download(path);
  if (error || !data) {
    logger.warn('school_asset_read_failed', { error: error?.message ?? 'no data returned' });
    return null;
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const type = await fileTypeFromBuffer(bytes);
  if (!type || !EMBEDDABLE.has(type.mime)) return null;
  return `data:${type.mime};base64,${bytes.toString('base64')}`;
}

/**
 * A PDF page may load nothing from the network: its images arrive inside it (assetDataUri). The
 * templates use no outside font or stylesheet. Until 5 Oct 2026 the renderer fetched whatever address
 * a logo or stamp field held, and the identity settings route accepted any address there, so a
 * principal could make the server request an internal one. Measured with the installed Puppeteer: a
 * data: image renders, and a page asking for an address reaches nothing.
 */
export async function refuseNetwork(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const handled = req.url().startsWith('data:') ? req.continue() : req.abort('blockedbyclient');
    handled.catch(err => logger.warn('pdf_request_not_handled', { error: err instanceof Error ? err.message : String(err) }));
  });
}
