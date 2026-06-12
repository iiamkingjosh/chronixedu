import request from 'supertest';
import express from 'express';
import { requestLogger } from '../middleware/requestLogger';
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
