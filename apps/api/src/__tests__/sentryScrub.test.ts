import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import * as Sentry from '@sentry/node';
import { sentryOptions } from '../config/sentry';

/**
 * Sentry gets technical data only (CLAUDE.md, Conventions; SECURITY.md Round 33). This runs the
 * API's real Sentry options against a fake ingest on 127.0.0.1, so nothing leaves the machine, and
 * searches EVERYTHING Sentry would have received, not one field, for secrets planted in each place
 * a request carries them: body, Authorization, the support-session and health headers, a cookie
 * and the query string. One login fails (an error event) and one succeeds under tracing (a
 * transaction), because the defaults leaked through both.
 */
const SECRETS = {
  password: 'PROBE-PASSWORD-hunter2',
  email: 'probe-person@example.com',
  bearer: 'PROBE-BEARER-abc.def.ghi',
  support: 'PROBE-SUPPORT-SESSION',
  health: 'PROBE-HEALTH-TOKEN',
  cookie: 'PROBE-COOKIE',
  query: 'PROBE-QUERY',
  // A client's address is personal data too. Railway puts the client in X-Real-IP (CLAUDE.md, Auth).
  realIp: '203.0.113.77',
  forwardedIp: '198.51.100.88',
};

describe('what the API sends Sentry', () => {
  const received: string[] = [];
  let ingest: http.Server;
  let app: http.Server;
  let base = '';

  beforeAll(async () => {
    ingest = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { received.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200); res.end('{}'); });
    });
    await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', r));
    const ingestPort = (ingest.address() as AddressInfo).port;

    // NODE_ENV is 'test' here, so every request is traced (tracesSampleRate 1.0).
    Sentry.init(sentryOptions(`http://public@127.0.0.1:${ingestPort}/1`));

    const a = express();
    a.use(express.json());
    a.post('/api/auth/login', (req, res) => {
      if (req.body.fail) throw new Error('probe: database unavailable');
      res.json({ ok: true });
    });
    a.use(Sentry.expressErrorHandler() as unknown as express.ErrorRequestHandler); // as index.ts mounts it (its type is not Express's own)
    a.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ ok: false });
    });
    app = a.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    for (const fail of [true, false]) {
      await fetch(`${base}/api/auth/login?reference=${SECRETS.query}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SECRETS.bearer}`,
          'x-support-session-id': SECRETS.support,
          'x-health-token': SECRETS.health,
          cookie: `sid=${SECRETS.cookie}`,
          'x-real-ip': SECRETS.realIp,
          'x-forwarded-for': SECRETS.forwardedIp,
        },
        body: JSON.stringify({ email: SECRETS.email, password: SECRETS.password, fail }),
      });
    }
    await Sentry.flush(5000);
  });

  afterAll(async () => {
    await Sentry.close(2000);
    await new Promise((r) => app.close(r));
    await new Promise((r) => ingest.close(r));
  });

  it('receives the error and the trace, naming the route (the control: a silent Sentry would pass the next test)', () => {
    const all = received.join('\n');
    expect(all).toContain('probe: database unavailable');
    expect(all).toContain('"type":"transaction"');
    expect(all).toContain('/api/auth/login');
  });

  it('receives none of the secrets the requests carried', () => {
    const all = received.join('\n');
    for (const [where, secret] of Object.entries(SECRETS)) {
      expect({ where, sent: all.includes(secret) }).toEqual({ where, sent: false });
    }
  });
});
