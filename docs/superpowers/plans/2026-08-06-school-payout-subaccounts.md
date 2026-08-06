# School Payout via Paystack Subaccounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every parent fee payment settles directly to that school's own bank account via a Paystack Subaccount, automatically, per transaction — Chronix's account never receives or holds any of it.

**Architecture:** A bursar/principal self-service settings page collects and verifies a school's bank account, creates a Paystack Subaccount (0% platform cut, school bears Paystack's own fee), and stores the result on `schools.payout_config`. The existing fee-payment-initiate route is gated on `settlement_status === 'active'` and passes the subaccount code through to Paystack. Any bank-detail change fires three independent alerts (principal, school's official email, Chronix root admin) as a fraud-detection and evidentiary trail.

**Tech Stack:** Express + TypeScript (API), Next.js 14 App Router + React Hook Form + Zod (web), PostgreSQL/Supabase, Paystack REST API, Jest + Supertest.

## Global Constraints

- No `any` — use `unknown` and narrow (rule C1).
- Every route: `verifyToken` + a role check — no exceptions (rule C5).
- Standard response envelope: `{ success: true, data }` or `{ success: false, error: { code, message } }` (rule C6).
- All POST/PUT inputs validated with Zod before any DB operation (rule C7).
- All async route handlers wrapped in try/catch, errors passed to `next(err)` (rule C8).
- `school_id` always from `req.user.schoolId` / `req.params.schoolId` matched against the JWT — never trusted from body (rule C9).
- Parameterised SQL only (rule C10).
- `logAudit()` on every sensitive write, including this one (rule C11).
- Frontend: all API calls through `apiFetch` from `/lib/api.ts`, forms use React Hook Form + Zod resolver (rules C12, C14).
- Chronix takes 0% of fee payments — no `platform_fee_percent` field anywhere.
- Migration `024_add_school_payout_config.sql` is already applied to production — do not re-create or re-run it.

---

### Task 1: Paystack service — bank list, resolve, subaccount creation

**Files:**
- Modify: `apps/api/src/services/paystackService.ts`
- Test: `apps/api/src/__tests__/paystackService.test.ts`

**Interfaces:**
- Produces: `listBanks(): Promise<{ name: string; code: string }[]>`, `resolveBankAccount(bankCode: string, accountNumber: string): Promise<{ account_name: string } | null>`, `createPaystackSubaccount(input: { businessName: string; bankCode: string; accountNumber: string }): Promise<{ subaccount_code: string } | null>`
- Modifies existing: `initializePaystackTransaction()` gains two new optional input fields — `subaccountCode?: string`, `bearer?: 'subaccount'` — passed through as `subaccount` and `bearer` in the request body when present. Existing callers (with neither field) are unaffected.

- [ ] **Step 1: Write failing tests for the three new functions**

Add to the end of `apps/api/src/__tests__/paystackService.test.ts` (before the final closing, as new top-level `describe` blocks):

```ts
describe('listBanks', () => {
  it('returns empty array without calling fetch when not configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = jest.fn();

    const result = await listBanks();

    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns the bank list from Paystack', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: [
          { name: 'Access Bank', code: '044' },
          { name: 'Zenith Bank', code: '057' },
        ],
      }),
    });

    const result = await listBanks();

    expect(result).toEqual([
      { name: 'Access Bank', code: '044' },
      { name: 'Zenith Bank', code: '057' },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/bank?country=nigeria',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk_test_123' } })
    );
  });

  it('returns empty array when fetch throws', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await listBanks();

    expect(result).toEqual([]);
  });
});

describe('resolveBankAccount', () => {
  it('returns null without calling fetch when not configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = jest.fn();

    const result = await resolveBankAccount('058', '0123456789');

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns the resolved account name', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: { account_number: '0123456789', account_name: 'GREENFIELD SECONDARY SCHOOL' },
      }),
    });

    const result = await resolveBankAccount('058', '0123456789');

    expect(result).toEqual({ account_name: 'GREENFIELD SECONDARY SCHOOL' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk_test_123' } })
    );
  });

  it('returns null when Paystack reports status: false', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: false, message: 'Could not resolve account name' }),
    });

    const result = await resolveBankAccount('058', '0000000000');

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await resolveBankAccount('058', '0123456789');

    expect(result).toBeNull();
  });
});

describe('createPaystackSubaccount', () => {
  it('returns null without calling fetch when not configured', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    global.fetch = jest.fn();

    const result = await createPaystackSubaccount({
      businessName: 'Greenfield Secondary School',
      bankCode: '058',
      accountNumber: '0123456789',
    });

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('creates a subaccount with percentage_charge 0 and returns the subaccount code', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: { subaccount_code: 'ACCT_xxx' },
      }),
    });

    const result = await createPaystackSubaccount({
      businessName: 'Greenfield Secondary School',
      bankCode: '058',
      accountNumber: '0123456789',
    });

    expect(result).toEqual({ subaccount_code: 'ACCT_xxx' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/subaccount',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk_test_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          business_name: 'Greenfield Secondary School',
          settlement_bank: '058',
          account_number: '0123456789',
          percentage_charge: 0,
        }),
      })
    );
  });

  it('returns null when Paystack reports status: false', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: false, message: 'Invalid account' }),
    });

    const result = await createPaystackSubaccount({
      businessName: 'Greenfield Secondary School',
      bankCode: '058',
      accountNumber: '0000000000',
    });

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await createPaystackSubaccount({
      businessName: 'Greenfield Secondary School',
      bankCode: '058',
      accountNumber: '0123456789',
    });

    expect(result).toBeNull();
  });
});

describe('initializePaystackTransaction with subaccount', () => {
  it('passes subaccount and bearer through to Paystack when provided', async () => {
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

    await initializePaystackTransaction({
      email: 'parent@example.com',
      amountKobo: 500000,
      reference: 'ref-123',
      callbackUrl: 'https://api.example.com/callback',
      subaccountCode: 'ACCT_xxx',
      bearer: 'subaccount',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        body: JSON.stringify({
          email: 'parent@example.com',
          amount: 500000,
          reference: 'ref-123',
          callback_url: 'https://api.example.com/callback',
          metadata: undefined,
          subaccount: 'ACCT_xxx',
          bearer: 'subaccount',
        }),
      })
    );
  });
});
```

Update the import at the top of the test file to include the new functions:

```ts
import {
  isPaystackConfigured,
  verifyPaystackTransaction,
  initializePaystackTransaction,
  verifyPaystackWebhookSignature,
  listBanks,
  resolveBankAccount,
  createPaystackSubaccount,
} from '../services/paystackService';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- paystackService.test.ts`
Expected: FAIL — `listBanks`, `resolveBankAccount`, `createPaystackSubaccount` are not exported yet.

- [ ] **Step 3: Implement the three new functions and extend `initializePaystackTransaction`**

In `apps/api/src/services/paystackService.ts`, add after the existing `isPaystackConfigured` function:

```ts
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
```

Modify `InitializePaystackTransactionInput` and the body sent in `initializePaystackTransaction`:

```ts
export interface InitializePaystackTransactionInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  subaccountCode?: string;
  bearer?: 'subaccount';
}
```

In the `initializePaystackTransaction` body (`JSON.stringify({...})`), add the two new fields:

```ts
      body: JSON.stringify({
        email: input.email,
        amount: input.amountKobo,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
        subaccount: input.subaccountCode,
        bearer: input.bearer,
      }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- paystackService.test.ts`
Expected: PASS — all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/paystackService.ts apps/api/src/__tests__/paystackService.test.ts
git commit -m "feat: add Paystack subaccount functions (listBanks, resolveBankAccount, createPaystackSubaccount)"
```

---

### Task 2: DB query functions for payout config and contact lookups

**Files:**
- Modify: `apps/api/src/db/queries/schools.ts`
- Modify: `apps/api/src/db/queries/users.ts`

**Interfaces:**
- Consumes: `pool` from `../client` (already imported in both files).
- Produces: `PayoutConfig` type, `getSchoolPayoutConfig(schoolId: string): Promise<PayoutConfig | null>`, `updateSchoolPayoutConfig(schoolId: string, config: PayoutConfig): Promise<void>`, `getSchoolNameAndEmail(schoolId: string): Promise<{ name: string; email: string | null } | null>` (all in `schools.ts`); `findPrincipalsBySchool(schoolId: string): Promise<{ email: string; phone: string | null }[]>` (in `users.ts`).

This task has no isolated unit test of its own — these are thin query wrappers exercised end-to-end by Task 3's route tests. Per the task-right-sizing guidance, plain data-access wrappers with no branching logic don't need a dedicated test cycle; their correctness is verified when Task 3's route tests hit real rows.

- [ ] **Step 1: Add payout config functions to `schools.ts`**

In `apps/api/src/db/queries/schools.ts`, add after the existing `SchoolWithSettings` interface (after line 17):

```ts
export interface PayoutConfig {
  paystack_subaccount_code?: string;
  bank_code?: string;
  account_number?: string;
  account_name?: string;
  settlement_status: 'pending' | 'active' | 'failed';
  failure_reason?: string;
  updated_at?: string;
  updated_by?: string;
}
```

Add at the end of the file:

```ts
export async function getSchoolPayoutConfig(schoolId: string): Promise<PayoutConfig | null> {
  const result = await pool.query<{ payout_config: PayoutConfig }>(
    `SELECT payout_config FROM schools WHERE id = $1`,
    [schoolId]
  );
  if (result.rows.length === 0) return null;
  const config = result.rows[0].payout_config;
  return config && Object.keys(config).length > 0 ? config : null;
}

export async function updateSchoolPayoutConfig(schoolId: string, config: PayoutConfig): Promise<void> {
  await pool.query(
    `UPDATE schools SET payout_config = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(config), schoolId]
  );
}

export async function getSchoolNameAndEmail(schoolId: string): Promise<{ name: string; email: string | null } | null> {
  const result = await pool.query<{ name: string; email: string | null }>(
    `SELECT name, email FROM schools WHERE id = $1`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}
```

- [ ] **Step 2: Add principal lookup to `users.ts`**

In `apps/api/src/db/queries/users.ts`, add at the end of the file:

```ts
export async function findPrincipalsBySchool(schoolId: string): Promise<{ email: string; phone: string | null }[]> {
  const result = await pool.query<{ email: string; phone: string | null }>(
    `SELECT email, phone FROM users WHERE school_id = $1 AND role = 'principal' AND is_active = true`,
    [schoolId]
  );
  return result.rows;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace=@chronixedu/api run build`
Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/queries/schools.ts apps/api/src/db/queries/users.ts
git commit -m "feat: add payout config and principal-contact query functions"
```

---

### Task 3: Backend payout settings routes + 3-way fraud alert

**Files:**
- Modify: `apps/api/src/routes/schools.ts`
- Test: `apps/api/tests/payoutSettings.test.ts` (create)

**Interfaces:**
- Consumes: `getSchoolPayoutConfig`, `updateSchoolPayoutConfig`, `getSchoolNameAndEmail`, `PayoutConfig` (Task 2, `db/queries/schools.ts`); `findPrincipalsBySchool` (Task 2, `db/queries/users.ts`); `listBanks`, `resolveBankAccount`, `createPaystackSubaccount` (Task 1, `services/paystackService.ts`); `sendEmail(to, subject, text): Promise<void>` (existing, `services/emailService.ts`); `sendTermiiSms(schoolId, to, message): Promise<boolean>` (existing, `services/termiiService.ts`); `logAudit({ schoolId, userId, actionType, entity, entityId, oldValue, newValue }): Promise<void>` (existing, `db/queries/auditLog.ts`).
- Produces: `GET /:schoolId/settings/payout`, `POST /:schoolId/settings/payout/resolve`, `PUT /:schoolId/settings/payout` — mounted at `/api/schools` (already done via existing `app.use('/api/schools', schoolsRoutes)` in `index.ts`).

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/tests/payoutSettings.test.ts`:

```ts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import schoolsRouter from '../src/routes/schools';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', schoolsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Payout settings', () => {
  let schoolId: string;
  let bursarUserId: string;
  let bursarToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active, email) VALUES ($1, $2, true, $3) RETURNING id`,
      ['Payout Test School', `test-payout-${randomUUID()}`, 'school-office@test.com']
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject')
       RETURNING id, email`,
      [schoolId, `bursar-${randomUUID()}@test.com`]
    );
    bursarUserId = bursarResult.rows[0].id;
    bursarToken = makeToken(bursarUserId, 'bursar', schoolId, bursarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Test', 'Teacher', 'subject')
       RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  });

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns settlement_status pending with no config saved yet', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.settlement_status).toBe('pending');
    expect(res.body.data.account_number).toBeUndefined();
  });

  it('resolves a bank account via Paystack', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: true, data: { account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' } }),
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/settings/payout/resolve`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789' });

    expect(res.status).toBe(200);
    expect(res.body.data.account_name).toBe('PAYOUT TEST SCHOOL');
  });

  it('saves payout config, creates a subaccount, masks the account number on re-fetch, and logs an audit entry', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' } }),
        });
      }
      return Promise.resolve({
        json: async () => ({ status: true, data: { subaccount_code: 'ACCT_test123' } }),
      });
    });

    const putRes = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' });

    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);

    expect(getRes.body.data.settlement_status).toBe('active');
    expect(getRes.body.data.account_number).toBe('••••6789');

    const auditResult = await pool.query(
      `SELECT * FROM audit_logs WHERE school_id = $1 AND action_type = 'PAYOUT_CONFIG_CHANGE' ORDER BY created_at DESC LIMIT 1`,
      [schoolId]
    );
    expect(auditResult.rows.length).toBe(1);
  });

  it('returns 502 and sets settlement_status failed when subaccount creation fails', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '0000000000', account_name: 'FAIL SCHOOL' } }),
        });
      }
      return Promise.resolve({ json: async () => ({ status: false, message: 'Invalid account' }) });
    });

    const res = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0000000000', account_name: 'FAIL SCHOOL' });

    expect(res.status).toBe(502);

    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(getRes.body.data.settlement_status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- payoutSettings.test.ts`
Expected: FAIL — routes don't exist yet (404s).

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/schools.ts`, add to the imports block:

```ts
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  updateNotificationConfig,
  updateReportConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
  getSchoolPayoutConfig,
  updateSchoolPayoutConfig,
  getSchoolNameAndEmail,
  type PayoutConfig,
} from '../db/queries/schools';
import { findPrincipalsBySchool } from '../db/queries/users';
import { listBanks, resolveBankAccount, createPaystackSubaccount } from '../services/paystackService';
import { sendTermiiSms } from '../services/termiiService';
```

Add near the top-level Zod schemas (after `updateIdentitySchema`):

```ts
const resolvePayoutBankSchema = z.object({
  bank_code: z.string().min(1, 'Bank is required'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

const savePayoutSchema = z.object({
  bank_code: z.string().min(1, 'Bank is required'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  account_name: z.string().min(1, 'Account name is required'),
});
```

Add near `requireSchoolAccess` (after its definition):

```ts
function requirePayoutAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if ((user.role === 'principal' || user.role === 'bursar') && user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

function maskAccountNumber(accountNumber: string | undefined): string | undefined {
  if (!accountNumber || accountNumber.length < 4) return accountNumber;
  return `••••${accountNumber.slice(-4)}`;
}

async function sendPayoutChangeAlerts(schoolId: string, changedByEmail: string, maskedAccount: string, bankCode: string): Promise<void> {
  const [school, principals] = await Promise.all([
    getSchoolNameAndEmail(schoolId),
    findPrincipalsBySchool(schoolId),
  ]);
  const message = `Payout bank details for ${school?.name ?? 'your school'} were changed by ${changedByEmail}. New account ends in ${maskedAccount.slice(-4)} (bank code ${bankCode}). If this wasn't authorised, contact Chronix support immediately.`;

  const alerts: Promise<unknown>[] = [];
  for (const principal of principals) {
    alerts.push(sendEmail(principal.email, 'Payout bank details changed', message));
    if (principal.phone) alerts.push(sendTermiiSms(schoolId, principal.phone, message));
  }
  if (school?.email) alerts.push(sendEmail(school.email, 'Payout bank details changed', message));
  const rootAdminEmail = process.env.ROOT_ADMIN_EMAIL;
  if (rootAdminEmail) alerts.push(sendEmail(rootAdminEmail, `Payout change — ${school?.name ?? schoolId}`, message));

  await Promise.allSettled(alerts);
}
```

Add the three routes at the end of the file, before the final `export default router;` (check the last lines of the file first to place correctly — insert immediately above the export):

```ts
// ── GET /api/schools/:schoolId/settings/payout ────────────────────────────────

router.get(
  '/:schoolId/settings/payout',
  verifyToken,
  requirePayoutAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await getSchoolPayoutConfig(req.params.schoolId);
      if (!config) {
        return res.json({ success: true, data: { settlement_status: 'pending' } });
      }
      return res.json({
        success: true,
        data: {
          settlement_status: config.settlement_status,
          bank_code: config.bank_code,
          account_number: maskAccountNumber(config.account_number),
          account_name: config.account_name,
          failure_reason: config.failure_reason,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId/settings/payout/banks ──────────────────────────

router.get(
  '/:schoolId/settings/payout/banks',
  verifyToken,
  requirePayoutAccess,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const banks = await listBanks();
      return res.json({ success: true, data: banks });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/settings/payout/resolve ───────────────────────

router.post(
  '/:schoolId/settings/payout/resolve',
  verifyToken,
  requirePayoutAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resolvePayoutBankSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const resolved = await resolveBankAccount(parsed.data.bank_code, parsed.data.account_number);
      if (!resolved) {
        return res.status(422).json({ success: false, error: { code: 'ACCOUNT_RESOLVE_FAILED', message: "Couldn't verify this account — check the details and try again." } });
      }
      return res.json({ success: true, data: resolved });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PUT /api/schools/:schoolId/settings/payout ─────────────────────────────────

router.put(
  '/:schoolId/settings/payout',
  verifyToken,
  requirePayoutAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = savePayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { bank_code, account_number, account_name } = parsed.data;
      const schoolId = req.params.schoolId;

      // Never trust the client-confirmed name alone — re-resolve server-side.
      const reResolved = await resolveBankAccount(bank_code, account_number);
      if (!reResolved || reResolved.account_name !== account_name) {
        return res.status(422).json({ success: false, error: { code: 'ACCOUNT_MISMATCH', message: 'Account details could not be re-verified. Please resolve the account again.' } });
      }

      const school = await getSchoolNameAndEmail(schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const previousConfig = await getSchoolPayoutConfig(schoolId);
      const subaccount = await createPaystackSubaccount({
        businessName: school.name,
        bankCode: bank_code,
        accountNumber: account_number,
      });

      const now = new Date().toISOString();
      if (!subaccount) {
        const failedConfig: PayoutConfig = {
          bank_code,
          account_number,
          account_name,
          settlement_status: 'failed',
          failure_reason: 'Paystack could not create a subaccount for this bank account.',
          updated_at: now,
          updated_by: req.user!.user_id,
        };
        await updateSchoolPayoutConfig(schoolId, failedConfig);
        return res.status(502).json({ success: false, error: { code: 'SUBACCOUNT_CREATE_FAILED', message: 'Paystack could not create a subaccount for this bank account.' } });
      }

      const newConfig: PayoutConfig = {
        paystack_subaccount_code: subaccount.subaccount_code,
        bank_code,
        account_number,
        account_name,
        settlement_status: 'active',
        updated_at: now,
        updated_by: req.user!.user_id,
      };
      await updateSchoolPayoutConfig(schoolId, newConfig);

      await logAudit({
        schoolId,
        userId: req.user!.user_id,
        actionType: 'PAYOUT_CONFIG_CHANGE',
        entity: 'schools',
        entityId: schoolId,
        oldValue: previousConfig
          ? { bank_code: previousConfig.bank_code, account_number: maskAccountNumber(previousConfig.account_number) }
          : null,
        newValue: { bank_code, account_number: maskAccountNumber(account_number), account_name },
      });

      await sendPayoutChangeAlerts(schoolId, req.user!.email ?? 'unknown', maskAccountNumber(account_number) ?? '', bank_code);

      return res.json({ success: true, data: { message: 'Payout account saved', settlement_status: 'active' } });
    } catch (err) {
      return next(err);
    }
  }
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- payoutSettings.test.ts`
Expected: PASS.

Note: this test file hits the real database (`DATABASE_URL` from `apps/api/.env`), same as the other files under `apps/api/tests/`. Run it from a machine/shell that can actually reach the Supabase pooler.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/schools.ts apps/api/tests/payoutSettings.test.ts
git commit -m "feat: add payout settings routes with 3-way fraud alert on bank changes"
```

---

### Task 4: Gate fee payment initiation on payout status

**Files:**
- Modify: `apps/api/src/routes/fees.ts`
- Test: `apps/api/tests/feesPayout.test.ts` (create)

**Interfaces:**
- Consumes: `getSchoolPayoutConfig` (Task 2, `db/queries/schools.ts`).

- [ ] **Step 1: Write the failing scenario test**

Create `apps/api/tests/feesPayout.test.ts`:

```ts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import feesRouter from '../src/routes/fees';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', feesRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Fee payment initiate — payout gate', () => {
  let schoolId: string;
  let studentId: string;
  let parentUserId: string;
  let parentToken: string;
  let invoiceId: string;

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Fees Payout Test School', `test-fees-payout-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const parentResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'parent', 'Test', 'Parent', 'subject')
       RETURNING id, email`,
      [schoolId, `parent-${randomUUID()}@test.com`]
    );
    parentUserId = parentResult.rows[0].id;
    parentToken = makeToken(parentUserId, 'parent', schoolId, parentResult.rows[0].email);

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, first_name, last_name, admission_number)
       VALUES ($1, 'Test', 'Student', $2) RETURNING id`,
      [schoolId, `TEST-${randomUUID()}`]
    );
    studentId = studentResult.rows[0].id;

    await pool.query(
      `INSERT INTO parent_students (parent_user_id, student_id) VALUES ($1, $2)`,
      [parentUserId, studentId]
    );

    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (school_id, name, start_date, end_date, is_active)
       VALUES ($1, 'Test Term', NOW(), NOW() + interval '30 days', true) RETURNING id`,
      [schoolId]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentId, termResult.rows[0].id]
    );
    invoiceId = invoiceResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM parent_students WHERE parent_user_id = $1`, [parentUserId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  });

  it('blocks payment with PAYOUT_NOT_CONFIGURED when the school has no active payout config', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ invoice_id: invoiceId });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYOUT_NOT_CONFIGURED');
  });

  it('initializes payment with subaccount and bearer when payout config is active', async () => {
    await pool.query(
      `UPDATE schools SET payout_config = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ paystack_subaccount_code: 'ACCT_test123', settlement_status: 'active' }), schoolId]
    );
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'ref-abc' },
      }),
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ invoice_id: invoiceId });

    expect(res.status).toBe(200);
    expect(res.body.data.authorization_url).toBe('https://checkout.paystack.com/abc');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        body: expect.stringContaining('"subaccount":"ACCT_test123"'),
      })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=@chronixedu/api test -- feesPayout.test.ts`
Expected: FAIL — first assertion gets `200`/`PAYSTACK_INIT_FAILED` instead of `503`/`PAYOUT_NOT_CONFIGURED` (no gate exists yet).

- [ ] **Step 3: Implement the gate**

In `apps/api/src/routes/fees.ts`, add to the imports:

```ts
import { getSchoolPayoutConfig } from '../db/queries/schools';
```

Replace the existing block at [fees.ts:488-490](apps/api/src/routes/fees.ts#L488-L490):

```ts
      if (!isPaystackConfigured()) {
        return res.status(503).json({ success: false, error: { code: 'PAYSTACK_NOT_CONFIGURED', message: 'Paystack is not configured for this server' } });
      }
```

with:

```ts
      if (!isPaystackConfigured()) {
        return res.status(503).json({ success: false, error: { code: 'PAYSTACK_NOT_CONFIGURED', message: 'Paystack is not configured for this server' } });
      }

      const payoutConfig = await getSchoolPayoutConfig(schoolId);
      if (payoutConfig?.settlement_status !== 'active') {
        return res.status(503).json({ success: false, error: { code: 'PAYOUT_NOT_CONFIGURED', message: "Online payment isn't set up yet for this school — please contact the school office." } });
      }
```

Then update the `initializePaystackTransaction` call immediately below to pass the subaccount through:

```ts
      const initialization = await initializePaystackTransaction({
        email: req.user!.email!,
        amountKobo: Math.round(payAmount * 100),
        reference,
        callbackUrl: `${getApiBaseUrl()}/api/schools/${schoolId}/payments/paystack/callback`,
        metadata: { school_id: schoolId, invoice_id, recorded_by: req.user!.user_id },
        subaccountCode: payoutConfig.paystack_subaccount_code,
        bearer: 'subaccount',
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=@chronixedu/api test -- feesPayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full fees test suite to check nothing else broke**

Run: `npm --workspace=@chronixedu/api test -- fees`
Expected: PASS on all existing fees-related tests (they don't set up a payout config, so check whether any pre-existing test in this file exercises the initiate route without one — if so, that test needs `payout_config` inserted the same way, matching the pattern in Step 1 above).

- [ ] **Step 6: Confirm the parent fees page needs no code change**

The spec calls for a dedicated parent-facing message on `PAYOUT_NOT_CONFIGURED`. No frontend change is actually needed: `apiFetch` in `apps/web/lib/api.ts` (line 40-42) already throws `new Error(json.error.message)` using whatever `message` the API returned, and the parent fees page's existing catch block at [page.tsx:120-123](<apps/web/app/(parent)/parent/fees/page.tsx#L120-L123>) already does `setPayError(err instanceof Error ? err.message : 'Failed to start payment')`. Since Task 4 Step 3 set the `PAYOUT_NOT_CONFIGURED` error message to the exact parent-facing copy ("Online payment isn't set up yet for this school — please contact the school office."), it will display verbatim with zero frontend changes. Verify this manually in Task 7 Step 3 rather than writing new code here.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/fees.ts apps/api/tests/feesPayout.test.ts
git commit -m "feat: block fee payment initiation until school payout is active"
```

---

### Task 5: Frontend payout settings page + narrow access for bursar

**Files:**
- Modify: `apps/web/lib/auth.ts`
- Modify: `apps/web/app/(dashboard)/layout.tsx`
- Create: `apps/web/app/(dashboard)/settings/payout/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api`; `useAuth()` from `@/app/providers`; backend routes from Task 3 (`GET/POST/PUT .../settings/payout`, `GET .../settings/payout/banks`).
- Produces: `canAccessPayoutSettings(role: string): boolean` in `lib/auth.ts`.

This is a UI page with no automated test in this codebase's existing pattern (none of the other settings pages have one either — `identity/page.tsx` has no corresponding test file). Verification is manual, covered in Task 7.

- [ ] **Step 1: Add the access-control helper**

In `apps/web/app/lib/auth.ts` — actually the file is `apps/web/lib/auth.ts` — add after `isAdminRole`:

```ts
/** Roles that can access the payout settings page specifically (narrower than full settings access). */
export const PAYOUT_SETTINGS_ROLES = ['principal', 'bursar', 'super_admin'] as const;

export function canAccessPayoutSettings(role: string): boolean {
  return (PAYOUT_SETTINGS_ROLES as readonly string[]).includes(role);
}
```

- [ ] **Step 2: Add the standalone nav entry**

In `apps/web/app/(dashboard)/layout.tsx`, add to the imports:

```ts
import { isAdminRole, canAccessPayoutSettings } from '@/lib/auth';
```

After the line `const showSettings = isAdminRole(user.role);` (line 61), add:

```ts
  const showPayoutSettings = canAccessPayoutSettings(user.role);
```

In the JSX, after the closing `{showSettings && ( ... )}` block (after line 92), add a new conditional block for bursar's standalone entry — but only when the user is NOT already seeing it via the full settings section (i.e., don't double-render for principal/super_admin):

```tsx
        {showPayoutSettings && !showSettings && (
          <div>
            <p className="px-5 mb-2 text-xs font-semibold text-white/40 uppercase tracking-widest">
              Settings
            </p>
            <NavLink item={{ label: 'Payout Setup', href: '/settings/payout' }} pathname={pathname} onNavigate={onNavigate} />
          </div>
        )}
```

Separately, add `{ label: 'Payout Setup', href: '/settings/payout' }` to the existing `SETTINGS_NAV` array in `apps/web/lib/navigation.ts` so principal/super_admin see it in the normal list too:

```ts
export const SETTINGS_NAV: NavItem[] = [
  { label: 'School Identity', href: '/settings/identity' },
  { label: 'Academic Structure', href: '/settings/academic-structure' },
  { label: 'Grading Scale', href: '/settings/grading-scale' },
  { label: 'Assessment Config', href: '/settings/assessment-config' },
  { label: 'Report Card', href: '/settings/report-card' },
  { label: 'Notifications', href: '/settings/notifications' },
  { label: 'Payout Setup', href: '/settings/payout' },
  { label: 'Users', href: '/settings/users' },
];
```

- [ ] **Step 3: Build the settings page**

Create `apps/web/app/(dashboard)/settings/payout/page.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Bank {
  name: string;
  code: string;
}

interface PayoutStatus {
  settlement_status: 'pending' | 'active' | 'failed';
  bank_code?: string;
  account_number?: string;
  account_name?: string;
  failure_reason?: string;
}

const schema = z.object({
  bank_code: z.string().min(1, 'Select a bank'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

type FormValues = z.infer<typeof schema>;

// ── Toast helper ──────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PayoutSettingsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);

  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { bank_code: '', account_number: '' },
  });

  const loadStatus = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    Promise.all([
      apiFetch<{ success: boolean; data: PayoutStatus }>(`/api/schools/${schoolId}/settings/payout`),
      apiFetch<{ success: boolean; data: Bank[] }>(`/api/schools/${schoolId}/settings/payout/banks`),
    ])
      .then(([statusRes, banksRes]) => {
        setStatus(statusRes.data);
        setBanks(banksRes.data);
      })
      .catch(err => show(err instanceof Error ? err.message : 'Failed to load payout settings', 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function handleResolve(values: FormValues) {
    if (!schoolId) return;
    setResolveError('');
    setResolvedName(null);
    setResolving(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { account_name: string } }>(
        `/api/schools/${schoolId}/settings/payout/resolve`,
        { method: 'POST', body: JSON.stringify(values) }
      );
      setResolvedName(res.data.account_name);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Couldn't verify this account — check the details and try again.");
    } finally {
      setResolving(false);
    }
  }

  async function handleConfirm() {
    if (!schoolId || !resolvedName) return;
    const values = watch();
    setSaving(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/settings/payout`, {
        method: 'PUT',
        body: JSON.stringify({ ...values, account_name: resolvedName }),
      });
      show('Payout account saved');
      setResolvedName(null);
      setChangingAccount(false);
      reset();
      loadStatus();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to save payout account', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="max-w-xl mx-auto p-4"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  const showForm = !status || status.settlement_status !== 'active' || changingAccount;

  return (
    <div className="max-w-xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Payout Setup</h1>
        <p className="text-sm text-gray-500">Fees paid by parents settle directly to this bank account. Chronix never touches this money.</p>
      </div>

      {toast && (
        <div className={`rounded-lg px-4 py-3 text-sm ${toast.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {toast.message}
        </div>
      )}

      {status?.settlement_status === 'active' && !changingAccount && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-3">
          <p className="text-sm text-green-700 font-medium">Payout is active.</p>
          <p className="text-sm text-gray-700">{status.account_name} — {status.account_number}</p>
          <button
            type="button"
            onClick={() => setChangingAccount(true)}
            className="text-sm font-medium text-[#2472B4] hover:underline"
          >
            Change bank account
          </button>
        </div>
      )}

      {status?.settlement_status === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Last attempt failed: {status.failure_reason ?? 'Unknown error'}. Try again below.
        </div>
      )}

      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          {!resolvedName ? (
            <form onSubmit={handleSubmit(handleResolve)} className="space-y-4">
              <div>
                <label htmlFor="bank_code" className="block text-sm font-medium text-gray-700 mb-1.5">Bank</label>
                <select
                  id="bank_code"
                  {...register('bank_code')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                >
                  <option value="">Select a bank</option>
                  {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
                {errors.bank_code && <p className="mt-1 text-xs text-red-600">{errors.bank_code.message}</p>}
              </div>
              <div>
                <label htmlFor="account_number" className="block text-sm font-medium text-gray-700 mb-1.5">Account Number</label>
                <input
                  id="account_number"
                  {...register('account_number')}
                  maxLength={10}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                  placeholder="0123456789"
                />
                {errors.account_number && <p className="mt-1 text-xs text-red-600">{errors.account_number.message}</p>}
              </div>
              {resolveError && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{resolveError}</div>}
              <button
                type="submit"
                disabled={resolving}
                className="w-full rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
              >
                {resolving ? 'Verifying…' : 'Verify Account'}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Is this your school's account?</p>
              <p className="text-lg font-semibold text-gray-900">{resolvedName}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex-1 rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
                >
                  {saving ? 'Saving…' : 'Confirm & Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setResolvedName(null)}
                  className="flex-1 rounded-lg border border-gray-300 text-gray-700 font-medium py-2.5 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Lint and typecheck**

Run: `npm --workspace=@chronixedu/web run lint`
Expected: no new errors (pre-existing warnings in unrelated files are fine).

Run: `npm --workspace=@chronixedu/web run build`
Expected: build succeeds, `/settings/payout` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/auth.ts apps/web/lib/navigation.ts "apps/web/app/(dashboard)/layout.tsx" "apps/web/app/(dashboard)/settings/payout/page.tsx"
git commit -m "feat: add payout settings page with bursar-narrow access"
```

---

### Task 6: Super-admin schools list — payout status column

**Files:**
- Modify: `apps/api/src/routes/superAdmin.ts`
- Modify: `apps/web/lib/superAdminApi.ts`
- Modify: `apps/web/app/super-admin/schools/page.tsx`

**Interfaces:**
- Consumes: existing `GET /schools` query at [superAdmin.ts:534-553](apps/api/src/routes/superAdmin.ts#L534-L553); existing `SchoolListItem` type and `getSuperAdminSchools()` in `superAdminApi.ts`.
- Produces: `payout_status: 'pending' | 'active' | 'failed' | null` field added to the schools-list response and type.

No dedicated test — this is a read-only column addition to an existing, already-tested list endpoint. Verified manually in Task 7.

- [ ] **Step 1: Add the column to the backend query**

In `apps/api/src/routes/superAdmin.ts`, modify the `SELECT` at [superAdmin.ts:534-553](apps/api/src/routes/superAdmin.ts#L534-L553) — add one line to the column list:

```ts
      const result = await pool.query(
        `SELECT
           schools.id,
           schools.name,
           schools.slug,
           schools.is_active,
           schools.payout_config->>'settlement_status' AS payout_status,
           platform_subscriptions.plan,
           platform_subscriptions.subscription_status,
           platform_subscriptions.amount_naira,
           platform_subscriptions.next_billing_date,
           (SELECT COUNT(*) FROM students WHERE students.school_id = schools.id) AS student_count,
           (SELECT MAX(created_at) FROM audit_logs WHERE audit_logs.school_id = schools.id) AS last_activity,
           schools.created_at
         FROM schools
         LEFT JOIN platform_subscriptions ON platform_subscriptions.school_id = schools.id
         ${whereClause}
         ORDER BY schools.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      );
```

- [ ] **Step 2: Add the field to the frontend type and fetch it**

In `apps/web/lib/superAdminApi.ts`, add `payout_status: 'pending' | 'active' | 'failed' | null;` to the `SchoolListItem` interface (after `is_active: boolean;`):

```ts
export interface SchoolListItem {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  payout_status: 'pending' | 'active' | 'failed' | null;
  plan: SchoolPlan | null;
  subscription_status: SubscriptionStatus | null;
  amount_naira: number | null;
  next_billing_date: string | null;
  student_count: number;
  last_activity: string | null;
  created_at: string;
}
```

- [ ] **Step 3: Render the column**

In `apps/web/app/super-admin/schools/page.tsx`, add a `PayoutBadge` component near the existing `PlanBadge` (after its closing brace):

```tsx
function PayoutBadge({ status }: { status: 'pending' | 'active' | 'failed' | null }) {
  if (status === 'active') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>;
  }
  if (status === 'failed') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Failed</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200">Pending</span>;
}
```

Add a header cell after `<th className="py-3 px-4">Status</th>` (line 285):

```tsx
              <th className="py-3 px-4">Payout</th>
```

Add a body cell after `<td className="py-3 px-4"><StatusBadge isActive={school.is_active} /></td>` (line 311):

```tsx
                <td className="py-3 px-4"><PayoutBadge status={school.payout_status} /></td>
```

Update every `colSpan={7}` on the loading/empty rows (lines 295 and 300) to `colSpan={8}` to account for the new column.

- [ ] **Step 4: Lint and build**

Run: `npm --workspace=@chronixedu/api run lint && npm --workspace=@chronixedu/web run lint`
Expected: no new errors.

Run: `npm --workspace=@chronixedu/web run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/superAdmin.ts apps/web/lib/superAdminApi.ts apps/web/app/super-admin/schools/page.tsx
git commit -m "feat: show payout status column on super-admin schools list"
```

---

### Task 7: Full-suite verification + manual Paystack test-mode check

**Files:** none (verification only)

- [ ] **Step 1: Run the complete backend test suite**

Run: `npm test` (from repo root)
Expected: all suites pass, including the new `paystackService.test.ts` additions, `payoutSettings.test.ts`, and `feesPayout.test.ts`. Any pre-existing test in `apps/api/src/__tests__/fees.test.ts` or similar that calls the initiate route without a payout config must be updated to insert one first (same pattern as Task 4 Step 1) — check for these before declaring this step done.

- [ ] **Step 2: Run lint and both production builds**

Run: `npm run lint && npm --workspace=@chronixedu/web run build && npm --workspace=@chronixedu/api run build`
Expected: zero errors (pre-existing warnings unrelated to this feature are acceptable).

- [ ] **Step 3: Manual walkthrough against Paystack test mode**

With `PAYSTACK_SECRET_KEY` set to a Paystack **test** secret key (`sk_test_...`) in `apps/api/.env`:
1. Log in as a bursar for a test school, go to Settings → Payout Setup.
2. Select a bank, enter one of Paystack's documented test account numbers, verify the resolved name appears, confirm and save.
3. Confirm the principal, school email, and `ROOT_ADMIN_EMAIL` inboxes each receive the change alert (check SendGrid activity / Termii logs if inboxes aren't directly accessible).
4. As a parent linked to that school, attempt to pay an outstanding invoice — confirm it now reaches Paystack's checkout instead of the `PAYOUT_NOT_CONFIGURED` message.
5. For a *different* test school with no payout config, confirm the parent sees the "contact the school office" message and is never sent to Paystack.
6. As super_admin, confirm the schools list shows the correct Active/Pending badge for both schools.

- [ ] **Step 4: Final commit (if manual testing surfaced fixes)**

```bash
git add -A
git commit -m "fix: address issues found in Paystack test-mode walkthrough"
```

(Skip this commit if step 3 found no issues.)

- [ ] **Step 5: Send the rollout announcement to existing live schools**

This is an operational action, not code — the announcement infrastructure (`platform_announcements` table, SendGrid delivery) already exists via the super-admin Announcements page. Once this feature is deployed and verified: as super_admin, compose and publish an announcement to every principal/bursar explaining that online fee collection now requires completing Payout Setup in Settings, and that fee collection is blocked for their school until they do. Track completion via the payout-status column added in Task 6.
