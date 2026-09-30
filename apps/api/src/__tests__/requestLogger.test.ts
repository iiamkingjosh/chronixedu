import request from 'supertest';
import express from 'express';
import { requestLogger, describeClientIp } from '../middleware/requestLogger';
import { logger } from '../config/logger';

jest.mock('../config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

describe('requestLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs method, path and status after the response finishes', async () => {
    const app = express();
    app.use(requestLogger);
    app.get('/ping', (_req, res) => res.json({ success: true, data: {} }));

    await request(app).get('/ping');

    expect(mockLogger.info).toHaveBeenCalledWith(
      'http_request',
      expect.objectContaining({ method: 'GET', path: '/ping', status: 200, durationMs: expect.any(Number) })
    );
  });
});

describe('describeClientIp — the shape of the client address, never the address', () => {
  function seen(xff: string | undefined, realIp?: string, trust: number | boolean = 1) {
    const app = express();
    app.set('trust proxy', trust);
    let shape: ReturnType<typeof describeClientIp> | undefined;
    app.get('/x', (req, res) => { shape = describeClientIp(req); res.end(); });
    let r = request(app).get('/x');
    if (xff) r = r.set('X-Forwarded-For', xff);
    if (realIp) r = r.set('X-Real-IP', realIp);
    return r.then(() => shape!);
  }

  it('a public client behind one proxy: taken from the last hop, not internal', async () => {
    expect(await seen('129.18.153.138')).toEqual({ xff_hops: 1, xff_distinct: 1, ip_family: 'v4', ip_internal: false, ip_from: 'last', edge: null, real_ip: 'none', xff_first_testnet: false, real_ip_testnet: false, real_ip_family: 'none' });
  });

  it('an extra platform hop appended after the client shows up as an internal last hop', async () => {
    expect(await seen('129.18.153.138, 100.64.0.7')).toEqual({ xff_hops: 2, xff_distinct: 2, ip_family: 'v4', ip_internal: true, ip_from: 'last', edge: null, real_ip: 'none', xff_first_testnet: false, real_ip_testnet: false, real_ip_family: 'none' });
  });

  it('no forwarded header: the socket peer, which in tests is loopback', async () => {
    expect(await seen(undefined)).toEqual({ xff_hops: 0, xff_distinct: 0, ip_family: 'v4', ip_internal: true, ip_from: 'socket', edge: null, real_ip: 'none', xff_first_testnet: false, real_ip_testnet: false, real_ip_family: 'none' });
  });

  it('the client repeated by a proxy is one distinct address in two hops', async () => {
    expect(await seen('129.18.153.138, ::ffff:129.18.153.138')).toMatchObject({ xff_hops: 2, xff_distinct: 1, ip_from: 'last' });
  });

  it('X-Real-IP naming the first hop while req.ip is the last: the two headers disagree about the client', async () => {
    expect(await seen('129.18.153.138, 198.51.100.4', '129.18.153.138')).toMatchObject({ xff_distinct: 2, ip_from: 'last', real_ip: 'eq_first' });
  });

  it('X-Real-IP agreeing with req.ip', async () => {
    expect(await seen('129.18.153.138', '::ffff:129.18.153.138')).toMatchObject({ real_ip: 'eq_ip' });
  });

  it('X-Real-IP matching neither — what a forged header looks like if the edge passes it through', async () => {
    expect(await seen('129.18.153.138', '203.0.113.9')).toMatchObject({ real_ip: 'other' });
  });

  it('a documentation-range address in a forged header is reported as such — and only as such', async () => {
    expect(await seen('203.0.113.10, 198.51.100.4', '203.0.113.9')).toMatchObject({ xff_first_testnet: true, real_ip_testnet: true });
    expect(await seen('129.18.153.138, 198.51.100.4', '129.18.153.138')).toMatchObject({ xff_first_testnet: false, real_ip_testnet: false });
  });

  it('with DIAG_PROBE_IP set, says which header carries the prober — and never the address', async () => {
    process.env.DIAG_PROBE_IP = '129.18.153.138';
    try {
      const shape = await seen('198.51.100.4, 198.51.100.5', '129.18.153.138');
      expect(shape).toMatchObject({ real_ip_eq_probe: true, ip_eq_probe: false, xff_first_eq_probe: false, real_ip_family: 'v4' });
      expect(JSON.stringify(shape)).not.toContain('129.18');
    } finally {
      delete process.env.DIAG_PROBE_IP;
    }
    expect(await seen('198.51.100.4', '129.18.153.138')).not.toHaveProperty('real_ip_eq_probe');
  });

  it('never includes an address in its output', async () => {
    const shape = await seen('129.18.153.138, 198.51.100.4', '203.0.113.9');
    expect(JSON.stringify(shape)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
