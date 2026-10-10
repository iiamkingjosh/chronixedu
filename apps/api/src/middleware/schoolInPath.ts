import { Response } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an address under /api/schools says about a school, for the guards mounted there
 * (requireActiveSchool, requireWritableSubscription). `path` is relative to that mount.
 *
 * Whether there is a school id is decided by the address's shape, never by what the value looks like
 * (doctrine 8; SECURITY.md Round 42). Exactly `/` carries none: POST /api/schools, the only route behind
 * these guards without a school id. Every other address carries one in its first segment, decoded the
 * way Express decodes `:schoolId` for the route, so the guards check the school the route will use.
 * A first segment that does not decode to a uuid is `invalid`, and the guards refuse it. That covers a
 * word, the empty segment of a doubled slash (`//scores`), a double encoding and a broken escape.
 *
 * Before, both guards tested the RAW segment against the pattern and passed anything else along, so
 * `a0000000%2D0000-…` skipped them while the route, reading the decoded segment, reached the school.
 */
export type SchoolInPath = { kind: 'none' } | { kind: 'school'; id: string } | { kind: 'invalid' };

export function schoolInPath(path: string): SchoolInPath {
  if (path === '/') return { kind: 'none' };
  const segment = path.split('/')[1] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A broken escape (`%E0%A4%A`): not an id, and refused below like any other.
    return { kind: 'invalid' };
  }
  return UUID_RE.test(decoded) ? { kind: 'school', id: decoded } : { kind: 'invalid' };
}

/** The guards' answer to an address whose first segment is not a school id: the same 404 as an unknown school. */
export function refuseUnreadableSchool(res: Response): void {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
}
