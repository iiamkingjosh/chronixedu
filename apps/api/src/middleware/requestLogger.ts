import { Request, Response, NextFunction } from 'express';
import { BlockList, isIP } from 'node:net';
import { logger } from '../config/logger';

// Loopback, RFC 1918, carrier-grade NAT (100.64/10 — where platform-internal hops tend to
// live), IPv6 unique-local and link-local. An address in here is not a real client.
const internal = new BlockList();
internal.addSubnet('127.0.0.0', 8, 'ipv4');
internal.addSubnet('10.0.0.0', 8, 'ipv4');
internal.addSubnet('172.16.0.0', 12, 'ipv4');
internal.addSubnet('192.168.0.0', 16, 'ipv4');
internal.addSubnet('100.64.0.0', 10, 'ipv4');
internal.addAddress('::1', 'ipv6');
internal.addSubnet('fc00::', 7, 'ipv6');
internal.addSubnet('fe80::', 10, 'ipv6');

function unmap(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/**
 * How the client address reached the app — never the address itself (client IP beside
 * school ids is personal data under NDPR). Every per-IP control (both rate limiters, the
 * login IP lockout) keys on `req.ip`, which with `trust proxy = 1` is the LAST
 * X-Forwarded-For entry. Probing production on 30 Sep 2026 showed one client's requests,
 * through one Railway edge, landing on two different limiter keys about one time in five;
 * these fields say what the second key is without recording anyone's address.
 */
export function describeClientIp(req: Request) {
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ip = unmap(req.ip ?? '');
  const family = isIP(ip);
  const index = xff.map(unmap).lastIndexOf(ip);
  return {
    xff_hops: xff.length,
    ip_family: family === 4 ? 'v4' : family === 6 ? 'v6' : 'none',
    ip_internal: family ? internal.check(ip, family === 4 ? 'ipv4' : 'ipv6') : false,
    // Which entry req.ip was taken from: 'last' is what trust proxy = 1 intends;
    // 'socket' means no forwarded header reached us and it is the peer's own address.
    ip_from: index === -1 ? 'socket' : index === xff.length - 1 ? 'last' : `hop_${index}`,
    edge: String(req.headers['x-railway-edge'] ?? '') || null,
  };
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      client_ip: describeClientIp(req),
    });
  });
  next();
}
