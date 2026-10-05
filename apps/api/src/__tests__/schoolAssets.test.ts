/**
 * services/schoolAssets.ts: what a stored value may point at, the image a PDF embeds, and the PDF
 * renderer's refusal to fetch anything (5 Oct 2026). The routes and the migration are tested against
 * the database in schoolAssetsPrivate.db.test.ts.
 */
const mockDownload = jest.fn();
const mockSign = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { storage: { from: (bucket: string) => ({
    download: (path: string) => mockDownload(bucket, path),
    createSignedUrl: (path: string, ttl: number) => mockSign(bucket, path, ttl),
  }) } },
}));

import { EventEmitter } from 'events';
import type { Page } from 'puppeteer';
import { assetStoragePath, signAsset, assetDataUri, refuseNetwork, ASSET_SIGNED_URL_TTL_SECONDS } from '../services/schoolAssets';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const blob = (bytes: Buffer) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

beforeEach(() => {
  mockDownload.mockReset();
  mockSign.mockReset();
});

describe('assetStoragePath: what a stored value may point at', () => {
  it.each([
    ['a path, as stored since migration 061', 'schools/s1/logo.png', 'schools/s1/logo.png'],
    ['a leading slash', '/schools/s1/logo.png', 'schools/s1/logo.png'],
    ['a public link to this bucket, from before it', 'https://x.supabase.co/storage/v1/object/public/school-assets/schools/s1/logo.png', 'schools/s1/logo.png'],
    ['a signed link to this bucket, query dropped', 'https://x.supabase.co/storage/v1/object/sign/school-assets/schools/s1/a%20b.png?token=t', 'schools/s1/a b.png'],
  ])('%s', (_label, value, expected) => {
    expect(assetStoragePath(value)).toBe(expected);
  });

  it.each([
    ['nothing', null],
    ['empty', ''],
    ['another bucket', 'https://x.supabase.co/storage/v1/object/public/report-cards/s1/t/r.pdf'],
    ['any other site', 'https://cdn.example.org/logo.png'],
    ['an internal address', 'http://redis.railway.internal:6379/x.png'],
    ['a file: address', 'file:///etc/passwd'],
    ['a data: value', 'data:image/png;base64,AAAA'],
  ])('%s points at nothing', (_label, value) => {
    expect(assetStoragePath(value)).toBeNull();
  });
});

describe('signAsset: a link for a screen', () => {
  it('asks the assets bucket for a link to the path that expires in 15 minutes', async () => {
    mockSign.mockResolvedValue({ data: { signedUrl: 'https://signed.test/x' }, error: null });
    expect(await signAsset('schools/s1/logo.png')).toBe('https://signed.test/x');
    expect(mockSign).toHaveBeenCalledWith('school-assets', 'schools/s1/logo.png', ASSET_SIGNED_URL_TTL_SECONDS);
    expect(ASSET_SIGNED_URL_TTL_SECONDS).toBe(900);
  });

  it('never asks for a link to an address outside the bucket', async () => {
    expect(await signAsset('https://cdn.example.org/logo.png')).toBeNull();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('a file the bucket does not hold gives no link', async () => {
    mockSign.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    expect(await signAsset('schools/s1/gone.png')).toBeNull();
  });
});

describe('assetDataUri: the image itself, for a PDF', () => {
  it('reads the file from the bucket and returns it inside a data: URI', async () => {
    mockDownload.mockResolvedValue({ data: blob(PNG), error: null });
    expect(await assetDataUri('schools/s1/logo.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(mockDownload).toHaveBeenCalledWith('school-assets', 'schools/s1/logo.png');
  });

  it('a file that is not a PNG, JPEG or WebP is left out', async () => {
    mockDownload.mockResolvedValue({ data: blob(Buffer.from('<svg onload="x"/>')), error: null });
    expect(await assetDataUri('schools/s1/logo.png')).toBeNull();
  });

  it('an address outside the bucket is never fetched', async () => {
    expect(await assetDataUri('http://redis.railway.internal:6379/x.png')).toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('refuseNetwork: a PDF page fetches nothing', () => {
  function fakeRequest(url: string) {
    return { url: () => url, continue: jest.fn(async () => undefined), abort: jest.fn(async () => undefined) };
  }

  it('lets a data: image through and aborts every other request', async () => {
    const page = Object.assign(new EventEmitter(), { setRequestInterception: jest.fn(async () => undefined) });
    await refuseNetwork(page as unknown as Page);
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);

    const image = fakeRequest('data:image/png;base64,AAAA');
    const internal = fakeRequest('http://redis.railway.internal:6379/x.png');
    const outside = fakeRequest('https://cdn.example.org/logo.png');
    for (const r of [image, internal, outside]) page.emit('request', r);

    expect(image.continue).toHaveBeenCalled();
    expect(image.abort).not.toHaveBeenCalled();
    for (const r of [internal, outside]) {
      expect(r.abort).toHaveBeenCalledWith('blockedbyclient');
      expect(r.continue).not.toHaveBeenCalled();
    }
  });
});
