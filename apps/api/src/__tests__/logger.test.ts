import { logger } from '../config/logger';

describe('logger', () => {
  it('exposes standard logging methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('defaults to debug level outside production', () => {
    expect(logger.level).toBe('debug');
  });
});
