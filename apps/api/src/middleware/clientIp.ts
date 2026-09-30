import { Request } from 'express';
import { isIP } from 'node:net';

/**
 * The address of the client that made this request — for rate-limit keys, lockout keys
 * and the audit trail's ip column. Never use `req.ip` for those.
 *
 * On Railway, `X-Forwarded-For` carries two Railway addresses and no client at all, and
 * the edge overwrites whatever a client sends in it — so Express's `trust proxy`, which
 * reads only that header, can never produce anything but a Railway proxy. The client is
 * in `X-Real-IP`, which the edge also overwrites (a forged one does not survive). Both
 * measured on 30 Sep 2026 with documentation-range probes and a config-held probe
 * address; the readings are in SECURITY.md Round 18. Before this, every per-address
 * control in the app counted all schools against a handful of proxy addresses.
 *
 * Off Railway (local dev, tests, a direct hit on the container) nothing overwrites the
 * header, so it is exactly as trustworthy as `X-Forwarded-For` was with `trust proxy` on —
 * the risk Round 4 accepted, not a new one. Falls back to `req.ip` when absent or malformed.
 */
export function clientIp(req: Request): string | undefined {
  const raw = req.headers['x-real-ip'];
  let real = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (real.startsWith('::ffff:') && isIP(real.slice(7)) === 4) real = real.slice(7);
  return isIP(real) ? real : req.ip;
}
