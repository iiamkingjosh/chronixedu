import dotenv from 'dotenv';
import path from 'path';

// Loaded the way most suites load it, BEFORE the services read their keys: dotenv must not be
// able to bring production's provider keys back after jest.globalSetup.ts emptied them.
dotenv.config({ path: path.join(__dirname, '../.env') });

/* eslint-disable @typescript-eslint/no-var-requires */
const { isEmailConfigured } = require('../src/services/emailService');
const { isSmsEnabled } = require('../src/services/termiiService');
/* eslint-enable @typescript-eslint/no-var-requires */

describe('a local integration run cannot reach a real provider', () => {
  it('the setup emptied the provider keys (the control: this is not just a machine without a .env)', () => {
    // CI has no .env, so the emptiness below would hold there whatever the setup did; the marker
    // is what says the setup ran. On a machine with production keys in .env, removing the setup's
    // loop fails the next test too (checked 1 Oct 2026).
    expect(process.env.OUTSIDE_WORLD_KEYS_EMPTIED).toBe('1');
  });

  it('holds no SendGrid, Termii, Paystack or Sentry key, so nothing can email, text or charge', () => {
    for (const key of ['SENDGRID_API_KEY', 'TERMII_API_KEY', 'PAYSTACK_SECRET_KEY', 'SMS_ENABLED', 'SENTRY_DSN']) {
      // Never the value itself: on failure Jest prints it, and it would be a production key.
      const value = process.env[key];
      expect([key, value === '' ? 'empty' : value === undefined ? 'unset' : 'HAS A VALUE']).toEqual([key, 'empty']);
    }
    expect(isEmailConfigured()).toBe(false);
    expect(isSmsEnabled()).toBe(false);
  });
});
