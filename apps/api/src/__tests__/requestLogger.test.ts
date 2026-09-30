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
  function seen(xff: string | undefined, trust: number | boolean = 1) {
    const app = express();
    app.set('trust proxy', trust);
    let shape: ReturnType<typeof describeClientIp> | undefined;
    app.get('/x', (req, res) => { shape = describeClientIp(req); res.end(); });
    const r = request(app).get('/x');
    return (xff ? r.set('X-Forwarded-For', xff) : r).then(() => shape!);
  }

  it('a public client behind one proxy: taken from the last hop, not internal', async () => {
    expect(await seen('129.18.153.138')).toEqual({ xff_hops: 1, xff_distinct: 1, ip_family: 'v4', ip_internal: false, ip_from: 'last', edge: null });
  });

  it('an extra platform hop appended after the client shows up as an internal last hop', async () => {
    expect(await seen('129.18.153.138, 100.64.0.7')).toEqual({ xff_hops: 2, xff_distinct: 2, ip_family: 'v4', ip_internal: true, ip_from: 'last', edge: null });
  });

  it('no forwarded header: the socket peer, which in tests is loopback', async () => {
    expect(await seen(undefined)).toEqual({ xff_hops: 0, xff_distinct: 0, ip_family: 'v4', ip_internal: true, ip_from: 'socket', edge: null });
  });

  it('the client repeated by a proxy is one distinct address in two hops', async () => {
    expect(await seen('129.18.153.138, ::ffff:129.18.153.138')).toMatchObject({ xff_hops: 2, xff_distinct: 1, ip_from: 'last' });
  });

  it('never includes an address in its output', async () => {
    const shape = await seen('129.18.153.138');
    expect(JSON.stringify(shape)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
