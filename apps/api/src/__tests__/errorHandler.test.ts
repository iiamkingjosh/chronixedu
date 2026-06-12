import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../config/logger';

jest.mock('../config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

describe('errorHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs the error and returns a 500 envelope', async () => {
    const app = express();
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'kaboom' },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'unhandled_error',
      expect.objectContaining({ message: 'kaboom', method: 'GET', path: '/boom' })
    );
  });
});
