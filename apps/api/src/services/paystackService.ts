import crypto from 'crypto';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export interface PaystackVerification {
  status: string;
  amount: number;
  currency: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

interface PaystackVerifyResponse {
  status: boolean;
  message?: string;
  data?: {
    status: string;
    amount: number;
    currency: string;
    reference?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface PaystackInitialization {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface InitializePaystackTransactionInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  subaccountCode?: string;
  bearer?: 'subaccount';
}

interface PaystackInitializeResponse {
  status: boolean;
  message?: string;
  data?: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

export function isPaystackConfigured(): boolean {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

export async function listBanks(): Promise<{ name: string; code: string }[]> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return [];

  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/bank?country=nigeria`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const json = (await response.json()) as { status: boolean; data?: { name: string; code: string }[] };
    if (!json.status || !json.data) return [];
    return json.data.map(b => ({ name: b.name, code: b.code }));
  } catch {
    return [];
  }
}

export async function resolveBankAccount(
  bankCode: string,
  accountNumber: string
): Promise<{ account_name: string } | null> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return null;

  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const json = (await response.json()) as { status: boolean; data?: { account_name: string } };
    if (!json.status || !json.data) return null;
    return { account_name: json.data.account_name };
  } catch {
    return null;
  }
}

export interface CreatePaystackSubaccountInput {
  businessName: string;
  bankCode: string;
  accountNumber: string;
}

export async function createPaystackSubaccount(
  input: CreatePaystackSubaccountInput
): Promise<{ subaccount_code: string } | null> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return null;

  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/subaccount`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_name: input.businessName,
        settlement_bank: input.bankCode,
        account_number: input.accountNumber,
        percentage_charge: 0,
      }),
    });
    const json = (await response.json()) as { status: boolean; data?: { subaccount_code: string } };
    if (!json.status || !json.data) return null;
    return { subaccount_code: json.data.subaccount_code };
  } catch {
    return null;
  }
}

export async function verifyPaystackTransaction(reference: string): Promise<PaystackVerification | null> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return null;

  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const json = (await response.json()) as PaystackVerifyResponse;
    if (!json.status || !json.data) return null;

    return {
      status: json.data.status,
      amount: json.data.amount / 100,
      currency: json.data.currency,
      reference: json.data.reference,
      metadata: json.data.metadata,
    };
  } catch {
    return null;
  }
}

export async function initializePaystackTransaction(
  input: InitializePaystackTransactionInput
): Promise<PaystackInitialization | null> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return null;

  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountKobo,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
        subaccount: input.subaccountCode,
        bearer: input.bearer,
      }),
    });
    const json = (await response.json()) as PaystackInitializeResponse;
    if (!json.status || !json.data) return null;

    return {
      authorization_url: json.data.authorization_url,
      access_code: json.data.access_code,
      reference: json.data.reference,
    };
  } catch {
    return null;
  }
}

export function verifyPaystackWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return false;

  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
