import request from 'supertest';
import express from 'express';
import { generalRateLimiter, authRateLimiter } from '../middleware/rateLimit';
import { errorHandler } from '../middleware/errorHandler';

function buildApp(limiter: express.RequestHandler) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => res.json({ success: true, data: { pong: true } }));
  app.use(errorHandler);
  return app;
}

describe('authRateLimiter', () => {
  it('allows up to 5 requests per window and returns a 429 envelope on the 6th', async () => {
    const app = buildApp(authRateLimiter);

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message: expect.any(String) },
    });
  });
});

describe('generalRateLimiter', () => {
  it('returns success envelope responses under the limit', async () => {
    const app = buildApp(generalRateLimiter);
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { pong: true } });
  });
});
