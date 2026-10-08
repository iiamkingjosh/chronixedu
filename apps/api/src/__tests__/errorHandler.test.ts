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

  it('answers an upload over its size limit with 413 and a sentence, logged as a warning, not an alert', async () => {
    const multer = (await import('multer')).default;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 } });
    const app = express();
    app.post('/upload', upload.single('file'), (_req, res) => { res.json({ ok: true }); });
    app.use(errorHandler);

    // Control: a file under the limit goes through.
    const small = await request(app).post('/upload').attach('file', Buffer.from('tiny'), 'a.txt');
    expect(small.status).toBe(200);

    const res = await request(app).post('/upload').attach('file', Buffer.alloc(100, 1), 'big.txt');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error.message).toMatch(/too large/i);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith('upload_refused', expect.objectContaining({ code: 'LIMIT_FILE_SIZE' }));
  });
});
