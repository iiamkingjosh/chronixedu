/**
 * The CA's expiry is the one thing in the TLS work with nothing watching it.
 *
 * `resolveSsl()` fails closed, so an expired or rotated CA is not a degraded
 * connection — it is the API refusing to boot, with no advance warning. A calendar
 * entry is the weaker form of protection: it depends on a human reading it in four
 * years. `inspectCa` lets the system report the date itself, on every boot.
 *
 * Tested against the CA that actually ships, with an injected clock, so both the quiet
 * branch and the warning branch are exercised — rather than being code that only runs
 * in production and is therefore only correct in theory.
 */
jest.mock('../supabaseClient', () => ({ supabaseAdmin: {}, supabase: {} }));

import fs from 'fs';
import path from 'path';
import { inspectCa, CA_EXPIRY_WARN_DAYS } from '../db/client';

const CA_PATH = path.join(__dirname, '../../certs/supabase-ca.crt');
const pem = fs.readFileSync(CA_PATH, 'utf8');

/** The real expiry of Supabase Root 2021 CA: 26 Apr 2031. */
const EXPIRY = Date.parse('2031-04-26T10:56:53Z');
const DAY = 86_400_000;

describe('the bundled CA', () => {
  it('exists in the repo, so the default path is not a promise', () => {
    expect(fs.existsSync(CA_PATH)).toBe(true);
    expect(pem).toContain('BEGIN CERTIFICATE');
  });

  it('is not already expired', () => {
    expect(inspectCa(pem).daysLeft).toBeGreaterThan(0);
  });

  it('is not inside the warning window today, so a warning would mean something', () => {
    expect(inspectCa(pem).daysLeft).toBeGreaterThan(CA_EXPIRY_WARN_DAYS);
  });
});

describe('inspectCa against a fixed clock', () => {
  it('reports the certificate expiry date', () => {
    expect(Date.parse(inspectCa(pem).notAfter)).toBe(EXPIRY);
  });

  it('counts down as expiry approaches', () => {
    expect(inspectCa(pem, EXPIRY - 200 * DAY).daysLeft).toBe(200);
    expect(inspectCa(pem, EXPIRY - 10 * DAY).daysLeft).toBe(10);
  });

  it('stays quiet outside the warning window', () => {
    expect(inspectCa(pem, EXPIRY - (CA_EXPIRY_WARN_DAYS + 1) * DAY).daysLeft)
      .toBeGreaterThanOrEqual(CA_EXPIRY_WARN_DAYS);
  });

  it('crosses into the warning window on the right day', () => {
    // The boundary is where the log changes from info-only to a warning, so it is
    // worth pinning rather than assuming.
    expect(inspectCa(pem, EXPIRY - CA_EXPIRY_WARN_DAYS * DAY).daysLeft).toBe(CA_EXPIRY_WARN_DAYS);
    expect(inspectCa(pem, EXPIRY - (CA_EXPIRY_WARN_DAYS - 1) * DAY).daysLeft)
      .toBeLessThan(CA_EXPIRY_WARN_DAYS);
  });

  it('goes negative once expired, rather than wrapping or throwing', () => {
    // Past this point resolveSsl still returns the CA and the handshake fails, so the
    // API stops booting. The number being negative is what makes that diagnosable.
    expect(inspectCa(pem, EXPIRY + 5 * DAY).daysLeft).toBe(-5);
  });
});
