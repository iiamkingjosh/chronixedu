import request from 'supertest';
import express from 'express';
import { clientIp } from '../middleware/clientIp';

/** req.ip under trust proxy = 1 is the LAST X-Forwarded-For hop — on Railway, a proxy. */
function seen(headers: Record<string, string>) {
  const app = express();
  app.set('trust proxy', 1);
  let ip: string | undefined;
  app.get('/x', (req, res) => { ip = clientIp(req); res.end(); });
  let r = request(app).get('/x');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.then(() => ip);
}

describe('clientIp', () => {
  it('is X-Real-IP, not the last forwarded hop that req.ip would give', async () => {
    expect(await seen({ 'X-Forwarded-For': '198.51.100.1, 198.51.100.7', 'X-Real-IP': '203.0.113.1' })).toBe('203.0.113.1');
  });
  it('unmaps an IPv4-mapped IPv6 form', async () => {
    expect(await seen({ 'X-Real-IP': '::ffff:203.0.113.1' })).toBe('203.0.113.1');
  });
  it('falls back to req.ip when the header is absent', async () => {
    expect(await seen({ 'X-Forwarded-For': '198.51.100.1, 198.51.100.7' })).toBe('198.51.100.7');
  });
  it('falls back to req.ip when the header is not an address', async () => {
    expect(await seen({ 'X-Forwarded-For': '198.51.100.7', 'X-Real-IP': 'not-an-ip' })).toBe('198.51.100.7');
  });
});
