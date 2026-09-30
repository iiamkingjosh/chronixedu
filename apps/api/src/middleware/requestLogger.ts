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

// RFC 5737 documentation ranges: never a real client, so "is it one of these" can be
// logged. Probes send them in forged headers to learn which headers the edge overwrites.
const testnet = new BlockList();
testnet.addSubnet('192.0.2.0', 24, 'ipv4');
testnet.addSubnet('198.51.100.0', 24, 'ipv4');
testnet.addSubnet('203.0.113.0', 24, 'ipv4');
const isTestnet = (ip: string) => isIP(ip) === 4 && testnet.check(ip, 'ipv4');

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
function realIpHeader(req: Request): string {
  const raw = req.headers['x-real-ip'];
  return unmap(String(Array.isArray(raw) ? raw[0] : raw ?? '').trim());
}

function realIpRelation(req: Request, xff: string[], ip: string): 'none' | 'eq_ip' | 'eq_first' | 'other' {
  const real = realIpHeader(req);
  if (!real) return 'none';
  if (real === ip) return 'eq_ip';
  if (xff.length && real === xff[0]) return 'eq_first';
  return 'other';
}

export function describeClientIp(req: Request) {
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ip = unmap(req.ip ?? '');
  const family = isIP(ip);
  const index = xff.map(unmap).lastIndexOf(ip);
  return {
    xff_hops: xff.length,
    // Production shows two hops on every request. Whether the last (= req.ip) is the
    // client again or a different address decides whether the per-IP keys are clients
    // or proxies — and it can be told from a count alone.
    xff_distinct: new Set(xff.map(unmap)).size,
    ip_family: family === 4 ? 'v4' : family === 6 ? 'v6' : 'none',
    ip_internal: family ? internal.check(ip, family === 4 ? 'ipv4' : 'ipv6') : false,
    // Which entry req.ip was taken from: 'last' is what trust proxy = 1 intends;
    // 'socket' means no forwarded header reached us and it is the peer's own address.
    ip_from: index === -1 ? 'socket' : index === xff.length - 1 ? 'last' : `hop_${index}`,
    edge: String(req.headers['x-railway-edge'] ?? '') || null,
    // Railway documents X-Real-IP as "the client's remote IP" and does not document
    // X-Forwarded-For. Express's trust proxy reads only the latter. Where X-Real-IP sits
    // relative to req.ip and the first forwarded hop says which header names the client
    // -- and, probed with a forged X-Real-IP, whether the edge overwrites it.
    real_ip: realIpRelation(req, xff.map(unmap), ip),
    // Production: two DISTINCT forwarded hops, X-Real-IP equal to neither. Whether a
    // forged header survives the edge decides which header can be trusted as the client.
    xff_first_testnet: xff.length > 0 && isTestnet(unmap(xff[0])),
    real_ip_testnet: isTestnet(realIpHeader(req)),
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
