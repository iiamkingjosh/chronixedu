import {
  isPaystackConfigured,
  verifyPaystackTransaction,
  initializePaystackTransaction,
  verifyPaystackWebhookSignature,
} from '../services/paystackService';
import crypto from 'crypto';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('isPaystackConfigured', () => {
  it('returns false when PAYSTACK_SECRET_KEY is not set', () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    expect(isPaystackConfigured()).toBe(false);
  });

  it('returns true when PAYSTACK_SECRET_KEY is set', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    expect(isPaystackConfigured()).toBe(true);
  });
});

describe('verifyPaystackTransaction', () => {
  it('returns null without calling fetch when not configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = jest.fn();

    const result = await verifyPaystackTransaction('ref-123');

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls the verify endpoint with the bearer token and returns parsed data', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: { status: 'success', amount: 1000000, currency: 'NGN' },
      }),
    });

    const result = await verifyPaystackTransaction('ref-123');

    expect(result).toEqual({ status: 'success', amount: 10000, currency: 'NGN' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/verify/ref-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk_test_123' },
      })
    );
  });

  it('returns null when Paystack reports status: false', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: false, message: 'Transaction reference not found' }),
    });

    const result = await verifyPaystackTransaction('bad-ref');

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await verifyPaystackTransaction('ref-123');

    expect(result).toBeNull();
  });

  it('includes reference and metadata from the verify response', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: {
          status: 'success',
          amount: 1000000,
          currency: 'NGN',
          reference: 'ref-123',
          metadata: { school_id: 'school-1', invoice_id: 'invoice-1', recorded_by: 'user-1' },
        },
      }),
    });

    const result = await verifyPaystackTransaction('ref-123');

    expect(result).toEqual({
      status: 'success',
      amount: 10000,
      currency: 'NGN',
      reference: 'ref-123',
      metadata: { school_id: 'school-1', invoice_id: 'invoice-1', recorded_by: 'user-1' },
    });
  });
});

describe('initializePaystackTransaction', () => {
  it('returns null without calling fetch when not configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = jest.fn();

    const result = await initializePaystackTransaction({
      email: 'parent@example.com',
      amountKobo: 500000,
      reference: 'ref-123',
      callbackUrl: 'https://api.example.com/callback',
    });

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls the initialize endpoint with the bearer token and returns the authorization data', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'abc123',
          reference: 'ref-123',
        },
      }),
    });

    const result = await initializePaystackTransaction({
      email: 'parent@example.com',
      amountKobo: 500000,
      reference: 'ref-123',
      callbackUrl: 'https://api.example.com/callback',
      metadata: { school_id: 'school-1', invoice_id: 'invoice-1' },
    });

    expect(result).toEqual({
      authorization_url: 'https://checkout.paystack.com/abc123',
      access_code: 'abc123',
      reference: 'ref-123',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk_test_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'parent@example.com',
          amount: 500000,
          reference: 'ref-123',
          callback_url: 'https://api.example.com/callback',
          metadata: { school_id: 'school-1', invoice_id: 'invoice-1' },
        }),
      })
    );
  });

  it('returns null when Paystack reports status: false', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: false, message: 'Invalid email' }),
    });

    const result = await initializePaystackTransaction({
      email: 'bad-email',
      amountKobo: 500000,
      reference: 'ref-123',
      callbackUrl: 'https://api.example.com/callback',
    });

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await initializePaystackTransaction({
      email: 'parent@example.com',
      amountKobo: 500000,
      reference: 'ref-123',
      callbackUrl: 'https://api.example.com/callback',
    });

    expect(result).toBeNull();
  });
});

describe('verifyPaystackWebhookSignature', () => {
  it('returns false when not configured', () => {
    delete process.env.PAYSTACK_SECRET_KEY;

    const result = verifyPaystackWebhookSignature('{"event":"charge.success"}', 'any-signature');

    expect(result).toBe(false);
  });

  it('returns true for a signature matching the HMAC SHA512 of the body', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    const body = '{"event":"charge.success"}';
    const signature = crypto.createHmac('sha512', 'sk_test_123').update(body).digest('hex');

    const result = verifyPaystackWebhookSignature(body, signature);

    expect(result).toBe(true);
  });

  it('returns false for a signature that does not match', () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    const body = '{"event":"charge.success"}';

    const result = verifyPaystackWebhookSignature(body, 'wrong-signature');

    expect(result).toBe(false);
  });
});
