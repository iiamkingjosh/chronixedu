# Plan-Based Feature Gating + Homepage Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Basic-tier schools lose access to SMS, online Paystack payments, and the analytics dashboard; Premium/trial/enterprise keep everything — enforced server-side, reflected in the UI, and the homepage pricing section is rewritten to match the new Basic (₦400/student/term) / Premium (₦600/student/term) / Enterprise (custom) model.

**Architecture:** `schools.subscription_tier` becomes the single denormalized read for a school's plan (kept in sync by the subscription-management routes), loaded once per request by the existing `requireActiveSchool` middleware. A small `planFeatures.ts` module provides a pure `planIncludesFeature()` check plus an async `schoolAllowsFeature()` for the two non-request code paths (the fee-reminder cron and the notification worker) that don't have a live request to hang middleware off. A `requireFeature()` middleware wraps the three gated route groups.

**Tech Stack:** Express + TypeScript (API), Next.js 14 + React Hook Form (web), PostgreSQL/Supabase, Jest + Supertest.

## Global Constraints

- No `any` — use `unknown` and narrow.
- Every route: `verifyToken` + a role check — no exceptions.
- Standard response envelope: `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- Parameterised SQL only.
- Zero real schools exist in production — no data migration/backfill needed anywhere in this plan.
- Basic tier keeps: results, report cards, attendance, behaviour, timetable, portals, in-app messaging/announcements, fee invoicing, manual (cash/bank-transfer) payment recording. Only SMS, online Paystack payments, and the analytics dashboard are gated.
- `enterprise` and `trial` behave identically to `premium` for feature purposes — only `basic` is excluded.
- No changes to `platform_subscriptions.amount_naira`/billing automation — stays manually entered, exactly as today.

---

### Task 1: Simplify the plan enum everywhere it's duplicated

**Files:**
- Modify: `apps/api/src/routes/superAdmin.ts` (5 sites: lines ~66, ~89, ~106, ~211, ~907)
- Modify: `apps/web/lib/superAdminApi.ts:10`
- Modify: `apps/web/app/super-admin/schools/[id]/page.tsx` (lines ~159, ~175, ~240, ~253)
- Modify: `apps/web/app/super-admin/announcements/page.tsx` (lines ~49, ~95)

**Interfaces:**
- Produces: the plan value set becomes `'trial' | 'basic' | 'premium' | 'enterprise'` everywhere — every later task in this plan uses these exact four strings.

- [ ] **Step 1: Update all 5 backend zod enums in `superAdmin.ts`**

Replace each occurrence of `z.enum(['basic', 'professional', 'enterprise', 'trial'])` with `z.enum(['trial', 'basic', 'premium', 'enterprise'])`. The four call sites:

```ts
// listSchoolsQuerySchema (~line 66)
plan: z.enum(['trial', 'basic', 'premium', 'enterprise']).optional(),

// createSubscriptionSchema (~line 89)
plan: z.enum(['trial', 'basic', 'premium', 'enterprise']),

// updateSubscriptionSchema (~line 106)
plan: z.enum(['trial', 'basic', 'premium', 'enterprise']).optional(),

// announcementPlanEnum (~line 211)
const announcementPlanEnum = z.enum(['trial', 'basic', 'premium', 'enterprise']);
```

And the MRR aggregation array (~line 907):

```ts
const PLANS = ['basic', 'premium', 'enterprise'] as const;
```

- [ ] **Step 2: Update the frontend `SchoolPlan` type**

In `apps/web/lib/superAdminApi.ts:10`:

```ts
export type SchoolPlan = 'trial' | 'basic' | 'premium' | 'enterprise';
```

- [ ] **Step 3: Update the subscription edit form in `apps/web/app/super-admin/schools/[id]/page.tsx`**

Both zod enums (lines ~159 and ~240) become:

```ts
plan: z.enum(['trial', 'basic', 'premium', 'enterprise']),
```

Line ~175's `defaultValues` stays `{ plan: 'basic', billing_cycle: 'monthly', amount_naira: 0 }` (still a valid value under the new enum, no change needed there beyond the schema itself).

- [ ] **Step 4: Update `apps/web/app/super-admin/announcements/page.tsx`**

```ts
const ALL_PLANS: SchoolPlan[] = ['trial', 'basic', 'premium', 'enterprise'];
```

And the matching zod array at line ~95:

```ts
target_plans: z.array(z.enum(['trial', 'basic', 'premium', 'enterprise'])).min(1, 'Select at least one plan'),
```

- [ ] **Step 5: Typecheck and build**

Run: `npm --workspace=@chronixedu/api run build && npm --workspace=@chronixedu/web run build`
Expected: both succeed with no type errors (this is a pure value-set rename, no shape change).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/superAdmin.ts apps/web/lib/superAdminApi.ts "apps/web/app/super-admin/schools/[id]/page.tsx" apps/web/app/super-admin/announcements/page.tsx
git commit -m "feat: simplify plan enum to trial/basic/premium/enterprise"
```

---

### Task 2: Sync `schools.subscription_tier` and expose it on `findSchoolById`

**Files:**
- Modify: `apps/api/src/db/queries/schools.ts`
- Modify: `apps/api/src/routes/superAdmin.ts` (the `POST /subscriptions` and `PATCH /subscriptions/:id` handlers, ~lines 932-974 and ~979-1024)
- Test: `apps/api/src/__tests__/schools.test.ts` (query-layer) and `apps/api/tests/superAdmin.test.ts` (route-layer)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SchoolRow`/`SchoolWithSettings` gain `subscription_tier: string | null`; `findSchoolById()`'s returned object includes it. Task 3/4 depend on `res.locals.school.subscription_tier` being present after this task.

- [ ] **Step 1: Add `subscription_tier` to the schools query layer**

In `apps/api/src/db/queries/schools.ts`, update the interface (currently lines 3-10):

```ts
export interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  subscription_tier: string | null;
  created_at: string;
  updated_at: string;
}
```

Update `findSchoolById`'s SELECT (currently lines 52-60):

```ts
export async function findSchoolById(schoolId: string): Promise<SchoolWithSettings | null> {
  const result = await pool.query<SchoolWithSettings>(
    `SELECT s.id, s.name, s.slug, s.is_active, s.subscription_tier, s.created_at, s.updated_at,
            ss.identity_config, ss.academic_config, ss.notification_config, ss.report_config
     FROM schools s
     LEFT JOIN school_settings ss ON ss.school_id = s.id
     WHERE s.id = $1`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}
```

`insertSchool`'s own SELECT/RETURNING list (line ~31-32) does not need `subscription_tier` — it's set separately by the onboarding flow, unchanged by this task.

- [ ] **Step 2: Write the failing test for the sync behavior**

Add to `apps/api/tests/superAdmin.test.ts`, near the existing subscription-route tests (search the file for `POST /subscriptions` to find the right describe block):

```ts
it('POST /subscriptions syncs schools.subscription_tier to the new plan', async () => {
  const res = await request(app)
    .post('/api/super-admin/subscriptions')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ school_id: schoolId, plan: 'premium', billing_cycle: 'monthly', amount_naira: 60000 });

  expect(res.status).toBe(201);

  const schoolResult = await pool.query<{ subscription_tier: string }>(
    `SELECT subscription_tier FROM schools WHERE id = $1`,
    [schoolId]
  );
  expect(schoolResult.rows[0].subscription_tier).toBe('premium');
});

it('PATCH /subscriptions/:id syncs schools.subscription_tier when plan changes', async () => {
  const res = await request(app)
    .patch(`/api/super-admin/subscriptions/${subscriptionId}`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ plan: 'basic' });

  expect(res.status).toBe(200);

  const schoolResult = await pool.query<{ subscription_tier: string }>(
    `SELECT subscription_tier FROM schools WHERE id = $1`,
    [schoolId]
  );
  expect(schoolResult.rows[0].subscription_tier).toBe('basic');
});
```

Check the existing test file's setup for the exact variable names already in scope (`schoolId`, `superAdminToken`, and whether a `subscriptionId` from an earlier test in the same describe block is already available, or needs creating in a `beforeAll`) — match its established fixture pattern rather than introducing a new one.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- tests/superAdmin.test.ts -t "syncs schools.subscription_tier"`
Expected: FAIL — `schools.subscription_tier` stays whatever it was before (not updated), since nothing writes to it yet.

- [ ] **Step 4: Add the sync writes**

In `apps/api/src/routes/superAdmin.ts`, `POST /subscriptions` handler — after the `INSERT INTO platform_subscriptions` succeeds (currently right after line 961's `const subscription = result.rows[0];`), add:

```ts
      await pool.query(`UPDATE schools SET subscription_tier = $1 WHERE id = $2`, [plan, school_id]);
```

In the `PATCH /subscriptions/:id` handler — after the `UPDATE platform_subscriptions` succeeds (currently right after line 1011's `const updated = result.rows[0];`), add:

```ts
      if (parsed.data.plan !== undefined) {
        await pool.query(`UPDATE schools SET subscription_tier = $1 WHERE id = $2`, [parsed.data.plan, existing.school_id]);
      }
```

(`existing.school_id` is already available — it's read from `platform_subscriptions` two lines above at line 990.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- tests/superAdmin.test.ts -t "syncs schools.subscription_tier"`
Expected: PASS.

- [ ] **Step 6: Run the full superAdmin test file to check nothing else broke**

Run: `npm --workspace=@chronixedu/api test -- tests/superAdmin.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/queries/schools.ts apps/api/src/routes/superAdmin.ts apps/api/tests/superAdmin.test.ts
git commit -m "feat: sync schools.subscription_tier on subscription create/update"
```

---

### Task 3: `planFeatures.ts` — the shared feature-check module

**Files:**
- Create: `apps/api/src/services/planFeatures.ts`
- Test: `apps/api/src/__tests__/planFeatures.test.ts`

**Interfaces:**
- Consumes: `pool` from `../db/client`.
- Produces: `type PlanFeature = 'sms' | 'online_payments' | 'analytics'`, `planIncludesFeature(subscriptionTier: string | null | undefined, feature: PlanFeature): boolean` (pure, sync), `schoolAllowsFeature(schoolId: string, feature: PlanFeature): Promise<boolean>` (async, does its own tiny query — used by Task 5's cron/worker call sites which have no `res.locals.school`). Task 4 and Task 5 both import from this file by these exact names.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/planFeatures.test.ts`:

```ts
import pool from '../db/client';
import { planIncludesFeature, schoolAllowsFeature } from '../services/planFeatures';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('planIncludesFeature', () => {
  const features = ['sms', 'online_payments', 'analytics'] as const;

  it.each(features)('returns false for basic on %s', (feature) => {
    expect(planIncludesFeature('basic', feature)).toBe(false);
  });

  it.each(features)('returns true for premium on %s', (feature) => {
    expect(planIncludesFeature('premium', feature)).toBe(true);
  });

  it.each(features)('returns true for trial on %s', (feature) => {
    expect(planIncludesFeature('trial', feature)).toBe(true);
  });

  it.each(features)('returns true for enterprise on %s', (feature) => {
    expect(planIncludesFeature('enterprise', feature)).toBe(true);
  });

  it.each(features)('fails open (returns true) for null on %s', (feature) => {
    expect(planIncludesFeature(null, feature)).toBe(true);
  });

  it.each(features)('fails open (returns true) for an unrecognized value on %s', (feature) => {
    expect(planIncludesFeature('some-future-plan', feature)).toBe(true);
  });
});

describe('schoolAllowsFeature', () => {
  it('returns false when the school is on basic', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'basic' }] });

    const result = await schoolAllowsFeature('school-1', 'sms');

    expect(result).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('subscription_tier'),
      ['school-1']
    );
  });

  it('returns true when the school is on premium', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ subscription_tier: 'premium' }] });

    const result = await schoolAllowsFeature('school-1', 'sms');

    expect(result).toBe(true);
  });

  it('fails open (returns true) when the school row is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await schoolAllowsFeature('missing-school', 'sms');

    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- planFeatures.test.ts`
Expected: FAIL — `../services/planFeatures` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/planFeatures.ts`:

```ts
import pool from '../db/client';

export type PlanFeature = 'sms' | 'online_payments' | 'analytics';

// All three PlanFeature values are Premium+-only today (Basic gets none of
// them) — the feature argument is kept so this can grow into a real
// per-feature table later without changing any call site.
export function planIncludesFeature(
  subscriptionTier: string | null | undefined,
  _feature: PlanFeature
): boolean {
  if (subscriptionTier === 'basic') return false;
  // trial, premium, enterprise, and any unrecognized/null value all pass —
  // fail open toward access rather than silently locking out a school with
  // a not-yet-assigned or unexpected plan value.
  return true;
}

/** For the two code paths (fee-reminder cron, notification worker) that have
 *  no live request/res.locals.school to reuse — does its own small lookup. */
export async function schoolAllowsFeature(schoolId: string, feature: PlanFeature): Promise<boolean> {
  const result = await pool.query<{ subscription_tier: string | null }>(
    `SELECT subscription_tier FROM schools WHERE id = $1`,
    [schoolId]
  );
  const row = result.rows[0];
  if (!row) return true; // fail open — same posture as planIncludesFeature
  return planIncludesFeature(row.subscription_tier, feature);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- planFeatures.test.ts`
Expected: PASS — 24 tests (18 from the `it.each` matrix + 3 for `schoolAllowsFeature`... count will be exactly what the test file above produces).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/planFeatures.ts apps/api/src/__tests__/planFeatures.test.ts
git commit -m "feat: add planIncludesFeature/schoolAllowsFeature shared feature-check module"
```

---

### Task 4: `requireFeature` middleware + gate the three route groups

**Files:**
- Modify: `apps/api/src/routes/schools.ts` (the 4 payout settings routes)
- Modify: `apps/api/src/routes/fees.ts` (the Paystack initiate route)
- Modify: `apps/api/src/routes/analytics.ts` (the overview route)
- Test: `apps/api/tests/payoutSettings.test.ts`, `apps/api/tests/feesPayout.test.ts`, and a new/extended analytics route test

**Interfaces:**
- Consumes: `planIncludesFeature` from `../services/planFeatures` (Task 3); `res.locals.school.subscription_tier` (Task 2).
- Produces: `requireFeature(feature: PlanFeature)` — an Express middleware factory, defined once and imported by all three route files.

- [ ] **Step 1: Write the failing tests**

In `apps/api/tests/payoutSettings.test.ts`, add a test that a Basic-tier school's bursar gets `403 FEATURE_NOT_IN_PLAN` on the payout routes. Add near the existing cross-tenant test (search for the `otherBursarToken` fixture added in an earlier task — follow that same "second fixture" pattern, but this time same school, `subscription_tier` set to `'basic'` instead of a different school):

```ts
it('returns 403 FEATURE_NOT_IN_PLAN for a basic-tier school on all four payout routes', async () => {
  await pool.query(`UPDATE schools SET subscription_tier = 'basic' WHERE id = $1`, [schoolId]);

  const getRes = await request(app).get(`/api/schools/${schoolId}/settings/payout`).set('Authorization', `Bearer ${bursarToken}`);
  expect(getRes.status).toBe(403);
  expect(getRes.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

  const banksRes = await request(app).get(`/api/schools/${schoolId}/settings/payout/banks`).set('Authorization', `Bearer ${bursarToken}`);
  expect(banksRes.status).toBe(403);

  const resolveRes = await request(app).post(`/api/schools/${schoolId}/settings/payout/resolve`).set('Authorization', `Bearer ${bursarToken}`).send({ bank_code: '058', account_number: '0123456789' });
  expect(resolveRes.status).toBe(403);

  const putRes = await request(app).put(`/api/schools/${schoolId}/settings/payout`).set('Authorization', `Bearer ${bursarToken}`).send({ bank_code: '058', account_number: '0123456789', account_name: 'X' });
  expect(putRes.status).toBe(403);

  // Restore for any tests that run after this one in the same file.
  await pool.query(`UPDATE schools SET subscription_tier = 'premium' WHERE id = $1`, [schoolId]);
});
```

In `apps/api/tests/feesPayout.test.ts`, add (after the existing "initializes payment with subaccount and bearer when payout config is active" test):

```ts
it('returns 403 FEATURE_NOT_IN_PLAN when the school is on basic, even with an active payout config', async () => {
  await pool.query(`UPDATE schools SET subscription_tier = 'basic' WHERE id = $1`, [schoolId]);

  const res = await request(app)
    .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
    .set('Authorization', `Bearer ${parentToken}`)
    .send({ invoice_id: invoiceId });

  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

  await pool.query(`UPDATE schools SET subscription_tier = 'premium' WHERE id = $1`, [schoolId]);
});
```

For the analytics route, check whether `apps/api/tests/` or `apps/api/src/__tests__/` already has a route-level test file for `analytics.ts` (search for `analytics/overview` in test files); add an equivalent 403-for-basic test there following whatever fixture pattern that file already uses, or create `apps/api/tests/analyticsFeatureGate.test.ts` with its own minimal school+principal fixture (following the `schoolSuspension.test.ts`-style pattern: fresh school, fresh principal, `beforeAll`/`afterAll`) if no existing analytics route test file exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- payoutSettings.test.ts feesPayout.test.ts`
Expected: FAIL — all four new assertions get `200`/whatever the current success status is, not `403`, since no gate exists yet.

- [ ] **Step 3: Implement `requireFeature` and apply it**

Add to `apps/api/src/middleware/auth.ts` (or a new small file `apps/api/src/middleware/requireFeature.ts` — prefer a new file, since `auth.ts` is about identity/role, not plan; this keeps each middleware file single-purpose):

Create `apps/api/src/middleware/requireFeature.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import { planIncludesFeature, PlanFeature } from '../services/planFeatures';

export function requireFeature(feature: PlanFeature) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const school = res.locals.school as { subscription_tier?: string | null } | undefined;
    if (!planIncludesFeature(school?.subscription_tier, feature)) {
      res.status(403).json({
        success: false,
        error: { code: 'FEATURE_NOT_IN_PLAN', message: "This feature isn't available on your school's current plan" },
      });
      return;
    }
    next();
  };
}
```

In `apps/api/src/routes/schools.ts`, add the import and insert `requireFeature('online_payments')` into the middleware chain of all four payout routes (after `verifyToken, requirePayoutAccess,` — order matters: `requireActiveSchool` at the app level already populated `res.locals.school` before these route-level middlewares run):

```ts
import { requireFeature } from '../middleware/requireFeature';
```

```ts
router.get('/:schoolId/settings/payout', verifyToken, requirePayoutAccess, requireFeature('online_payments'), async (req, res, next) => { /* unchanged */ });
router.get('/:schoolId/settings/payout/banks', verifyToken, requirePayoutAccess, requireFeature('online_payments'), async (_req, res, next) => { /* unchanged */ });
router.post('/:schoolId/settings/payout/resolve', verifyToken, requirePayoutAccess, requireFeature('online_payments'), async (req, res, next) => { /* unchanged */ });
router.put('/:schoolId/settings/payout', verifyToken, requirePayoutAccess, requireFeature('online_payments'), async (req, res, next) => { /* unchanged */ });
```

In `apps/api/src/routes/fees.ts`, add the import and insert into the initiate route's chain:

```ts
import { requireFeature } from '../middleware/requireFeature';
```

```ts
router.post(
  '/:schoolId/payments/paystack/initiate',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'student'),
  requireFeature('online_payments'),
  async (req: Request, res: Response, next: NextFunction) => { /* unchanged */ }
);
```

In `apps/api/src/routes/analytics.ts`, add the import and insert into the `guard` array (line ~20: `const guard = [verifyToken, requireSchoolAccess, requireRole('principal', 'super_admin')];`) — append `requireFeature('analytics')`:

```ts
import { requireFeature } from '../middleware/requireFeature';
```

```ts
const guard = [verifyToken, requireSchoolAccess, requireRole('principal', 'super_admin'), requireFeature('analytics')];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- payoutSettings.test.ts feesPayout.test.ts`
Expected: PASS.

Run whichever analytics test file was written/extended in Step 1.
Expected: PASS.

- [ ] **Step 5: Run the broader fees/schools/analytics test files to check nothing else broke**

Run: `npm --workspace=@chronixedu/api test -- payoutSettings feesPayout src/__tests__/fees.test.ts analytics`
Expected: all pass — no pre-existing test in these files exercises a payout/Paystack-initiate/analytics route without an active/premium-tier school, but confirm this directly rather than assuming.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/requireFeature.ts apps/api/src/routes/schools.ts apps/api/src/routes/fees.ts apps/api/src/routes/analytics.ts apps/api/tests/payoutSettings.test.ts apps/api/tests/feesPayout.test.ts
git commit -m "feat: gate payout settings, Paystack initiate, and analytics routes by plan"
```

(Add whichever analytics test file was created/modified to this commit too.)

---

### Task 5: Gate SMS in the notification worker and fee-reminder cron

**Files:**
- Modify: `apps/api/src/services/notificationWorker.ts`
- Modify: `apps/api/src/services/feeReminderService.ts`
- Test: extend `apps/api/tests/notificationPipeline.test.ts` and `apps/api/src/__tests__/feeReminderService.test.ts`

**Interfaces:**
- Consumes: `schoolAllowsFeature` from `../services/planFeatures` (Task 3).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/__tests__/feeReminderService.test.ts` mocks each query module directly (`jest.mock('../db/queries/fees')`, etc.), not `pool` — so the new `schoolAllowsFeature` (which queries `pool` directly) needs its own module mock here rather than a `pool` mock. Add near the top of the file, alongside the other `jest.mock(...)` calls (after line 23):

```ts
jest.mock('../services/planFeatures');
```

Add the import (after line 14's `feeReminderService` import):

```ts
import { schoolAllowsFeature } from '../services/planFeatures';
```

Add the mock handle (after line 33's `mockSendTermiiSms` const):

```ts
const mockSchoolAllowsFeature = schoolAllowsFeature as jest.Mock;
```

Add a default resolved value in `beforeEach` (after line 58's `mockSendTermiiSms.mockResolvedValue(true);`):

```ts
  mockSchoolAllowsFeature.mockResolvedValue(true);
```

Add a new test inside the `describe('sendFeeRemindersForSchool', ...)` block (after the existing "skips SMS but still sends in-app and email when the parent has no phone number" test, currently ending at line 109):

```ts
  it('skips SMS but still sends in-app and email when the school is on basic', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([OUTSTANDING_ROW as never]);
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: PARENT_ID, email: 'parent@test.com', phone: '+2348011111111' },
    ]);
    mockSchoolAllowsFeature.mockResolvedValueOnce(false);

    await sendFeeRemindersForSchool(SCHOOL_ID, TERM_ID);

    expect(mockSchoolAllowsFeature).toHaveBeenCalledWith(SCHOOL_ID, 'sms');
    expect(mockCreateNotification).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });
```

`apps/api/src/__tests__/notificationWorker.test.ts` mocks `pool` directly at the module level (line 8-11) and routes queries through `mockQuery.mockImplementation` in the `mockQueueAndParents` helper (lines 49-62), branching on substrings of the SQL text. Add a new test inside `describe('processNotificationQueue — SMS delivery', ...)` (after the existing "does not attempt SMS or log anything when the parent has no phone number" test, currently ending at line 120):

```ts
  it('skips SMS but still creates the notification and sends email when the school is on basic', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM audit_logs') && sql.includes('SELECT id')) {
        return Promise.resolve({ rows: [AUDIT_ROW] });
      }
      if (sql.includes('FROM parent_students')) {
        return Promise.resolve({ rows: [{ parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' }] });
      }
      if (sql.includes('FROM schools')) {
        return Promise.resolve({ rows: [{ subscription_tier: 'basic' }] });
      }
      if (sql.includes('UPDATE audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await processNotificationQueue();

    expect(mockCreateNotification).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace=@chronixedu/api test -- feeReminderService.test.ts notificationWorker.test.ts`
Expected: FAIL — `sendTermiiSms` gets called regardless of tier today (the `notificationWorker.test.ts` addition fails because `sql.includes('FROM schools')` never gets hit — nothing queries it yet — but that's fine, the assertions on `mockSendTermiiSms`/`mockInsertLog` still fail as expected since SMS is unconditionally sent).

- [ ] **Step 3: Implement the gate in both services**

In `apps/api/src/services/feeReminderService.ts`, add the import (after line 9's `cronTracker` import):

```ts
import { schoolAllowsFeature } from './planFeatures';
```

Replace the existing SMS block (lines 48-55):

```ts
      if (parent.phone && (await schoolAllowsFeature(schoolId, 'sms'))) {
        if (await hasReachedSmsLimit(parent.parent_id)) {
          await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: 'throttled' });
        } else {
          const sent = await sendTermiiSms(schoolId, parent.phone, body);
          await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: sent ? 'sent' : 'failed' });
        }
      }
```

In `apps/api/src/services/notificationWorker.ts`, add the import (after line 6's `logger` import):

```ts
import { schoolAllowsFeature } from './planFeatures';
```

Replace the existing SMS block inside `processRow` (lines 75-94):

```ts
    if (parent.phone && (await schoolAllowsFeature(row.school_id, 'sms'))) {
      if (await hasReachedSmsLimit(parent.parent_id)) {
        await insertNotificationLog({
          school_id: row.school_id,
          user_id: parent.parent_id,
          channel: 'sms',
          type,
          status: 'throttled',
        });
      } else {
        const sent = await sendTermiiSms(row.school_id, parent.phone, body);
        await insertNotificationLog({
          school_id: row.school_id,
          user_id: parent.parent_id,
          channel: 'sms',
          type,
          status: sent ? 'sent' : 'failed',
        });
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace=@chronixedu/api test -- feeReminderService.test.ts notificationWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the broader notification/attendance-alert scenario tests to check nothing else broke**

Run: `npm --workspace=@chronixedu/api test -- notificationPipeline attendanceAutoAlert feeReminderService notificationWorker`
Expected: all pass. `notificationWorker.test.ts`'s existing tests (that don't hit the new `FROM schools` branch) fall through `mockQueueAndParents`'s final `return Promise.resolve({ rows: [] })`, so `schoolAllowsFeature` sees an empty row set and fails open (returns `true`) — SMS still sends, matching those tests' existing expectations, no changes needed there. Any DB-backed scenario test (`notificationPipeline.test.ts`, `attendanceAutoAlert.test.ts`) whose fixture school never sets `subscription_tier` gets the same fail-open-on-null behavior from `schoolAllowsFeature`'s real `pool.query` path. If any such test unexpectedly fails, its fixture school needs `subscription_tier` set to `'premium'` explicitly.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/notificationWorker.ts apps/api/src/services/feeReminderService.ts apps/api/src/__tests__/feeReminderService.test.ts apps/api/src/__tests__/notificationWorker.test.ts
git commit -m "feat: skip SMS (keep in-app + email) for basic-tier schools"
```

---

### Task 6: Include `subscription_tier` in the login JWT

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/src/__tests__/auth.test.ts`

**Interfaces:**
- Produces: the JWT payload signed at login gains `subscription_tier: string | null`. Task 7 (frontend) reads this off the decoded token via the existing `AuthUser` shape.

The login handler uses a request-scoped `pg.Client` (`getPgClient()`), not the shared `pool` — the new lookup should reuse that same connected client rather than opening a second one. `local.school_id` is typed as `string` but is genuinely `null` at runtime for `super_admin` accounts, so the lookup must be conditional.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/__tests__/auth.test.ts`, update the existing "returns a success envelope with access_token and user under data" test (lines 151-188). The handler queries `local` first, then does `UPDATE last_login_at`, then (after this change) the new schools lookup — so `mockQuery` needs a third queued response inserted after the two that already exist:

```ts
  it('returns a success envelope with access_token and user under data', async () => {
    mockSignIn.mockResolvedValueOnce({ data: { user: { id: 'auth-uuid-1' } }, error: null });
    const passwordHash = bcrypt.hashSync('password123', 10);
    mockQuery
      // 1. local user SELECT by Supabase auth UUID
      .mockResolvedValueOnce({
        rows: [{
          id: 'local-uuid-1',
          school_id: 'school-1',
          role: 'teacher',
          title: null,
          email: 'a@b.com',
          first_name: 'A',
          last_name: 'B',
          password_hash: passwordHash,
          is_active: true,
        }],
      })
      // 2. UPDATE last_login_at
      .mockResolvedValueOnce({ rows: [] })
      // 3. schools.subscription_tier lookup
      .mockResolvedValueOnce({ rows: [{ subscription_tier: 'premium' }] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user).toEqual({
      user_id: 'local-uuid-1',
      school_id: 'school-1',
      role: 'teacher',
      email: 'a@b.com',
      title: null,
      first_name: 'A',
      last_name: 'B',
      subscription_tier: 'premium',
    });

    const decoded = jwt.decode(res.body.data.access_token) as { subscription_tier?: string };
    expect(decoded.subscription_tier).toBe('premium');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=@chronixedu/api test -- src/__tests__/auth.test.ts -t "returns a success envelope with access_token"`
Expected: FAIL — `res.body.data.user` doesn't have `subscription_tier` yet, and the handler only consumes 2 of the 3 queued `mockQuery` responses today (harmless — Jest won't fail on an unused queued mock value, but the `toEqual` assertion fails on the missing field).

- [ ] **Step 3: Add the school lookup and include it in the payload**

In `apps/api/src/routes/auth.ts`, inside the login handler's `try` block, after the `await pg.query(\`UPDATE users SET last_login_at = now() WHERE id = $1\`, [local.id]);` line (currently line 210) and before the `finally` block:

```ts
      let subscriptionTier: string | null = null;
      if (local.school_id) {
        const schoolResult = await pg.query<{ subscription_tier: string | null }>(
          `SELECT subscription_tier FROM schools WHERE id = $1`,
          [local.school_id]
        );
        subscriptionTier = schoolResult.rows[0]?.subscription_tier ?? null;
      }
```

`subscriptionTier` is declared with `let` inside the `try` block, so it needs to be readable after the block ends (where `payload` is built, at module scope of the handler). Declare it before the `try` instead — replace the existing `let local: {...} | undefined;` line (currently line 190) with:

```ts
    let local: { id: string; school_id: string; role: string; title: string; email: string; first_name: string; last_name: string; is_active: boolean } | undefined;
    let subscriptionTier: string | null = null;
```

and remove the `let subscriptionTier` re-declaration from inside the `try` block, keeping only the assignment:

```ts
      if (local.school_id) {
        const schoolResult = await pg.query<{ subscription_tier: string | null }>(
          `SELECT subscription_tier FROM schools WHERE id = $1`,
          [local.school_id]
        );
        subscriptionTier = schoolResult.rows[0]?.subscription_tier ?? null;
      }
```

Then extend the payload (currently lines 218-226):

```ts
    const payload = {
      user_id: local.id,
      school_id: local.school_id,
      role: local.role,
      email: local.email,
      title: local.title,
      first_name: local.first_name,
      last_name: local.last_name,
      subscription_tier: subscriptionTier,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=@chronixedu/api test -- src/__tests__/auth.test.ts -t "returns a success envelope with access_token"`
Expected: PASS.

- [ ] **Step 5: Run the full auth test file to check nothing else broke**

Run: `npm --workspace=@chronixedu/api test -- src/__tests__/auth.test.ts`
Expected: all pass. The "returns a 403 envelope for a suspended account" test (lines 190-214) only queues one `mockResolvedValueOnce` and returns before reaching the new lookup, so it's unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/__tests__/auth.test.ts
git commit -m "feat: include subscription_tier in the login JWT payload"
```

---

### Task 7: Frontend — hide gated UI for basic-tier schools

**Files:**
- Modify: `apps/web/app/providers.tsx`
- Modify: `apps/web/app/(dashboard)/layout.tsx`
- Modify: `apps/web/app/(parent)/parent/fees/page.tsx`

**Interfaces:**
- Consumes: the JWT's new `subscription_tier` claim (Task 6), already decoded into `AuthUser` since `AuthUser` is built directly from the token payload.
- Produces: `useAuth()` exposes `subscriptionTier: string | null`.

No automated test for this task — matches the plan/spec's note that this codebase has no existing test pattern for dashboard-layout nav visibility or the parent fees page; verified manually in Task 9.

- [ ] **Step 1: Expose `subscriptionTier` from `useAuth()`**

In `apps/web/app/providers.tsx`, find the `AuthUser` interface (currently ~line 9) and add:

```ts
export interface AuthUser {
  // ...existing fields...
  subscription_tier?: string | null;
}
```

Find the `AuthContextValue` interface (~line 19) and the provider's value object (~line 92) and add a derived field the same way `schoolId` already is:

```ts
  subscriptionTier: user?.subscription_tier ?? null,
```

- [ ] **Step 2: Hide the payout settings nav entry for basic-tier schools**

In `apps/web/app/(dashboard)/layout.tsx`, find the existing `showPayoutSettings` logic (added in the payout feature — search for `canAccessPayoutSettings`) and add a plan check alongside the existing role check:

```ts
  const { subscriptionTier } = useAuth();
  const showPayoutSettings = canAccessPayoutSettings(user.role) && subscriptionTier !== 'basic';
```

(Read the surrounding code first — `useAuth()` may already be destructured once at the top of the component; add `subscriptionTier` to that existing destructure rather than calling `useAuth()` twice.)

Find wherever the analytics dashboard nav link is defined per role (in `apps/web/lib/navigation.ts`'s `PRINCIPAL_NAV` or similar) — since `subscriptionTier` isn't available inside a plain data array, the hiding needs to happen at render time in the layout instead: filter the rendered nav list to exclude the analytics entry when `subscriptionTier === 'basic'`, following whatever pattern the file already uses to render `mainNav`/`SETTINGS_NAV` as a `.map(...)`.

- [ ] **Step 3: Hide the "Pay Now" button for basic-tier schools**

In `apps/web/app/(parent)/parent/fees/page.tsx`, find the existing "Pay Now" button (search for `handlePayNow`) and add a plan check:

```tsx
  const { subscriptionTier } = useAuth();
```

```tsx
            {subscriptionTier === 'basic' ? (
              <p className="text-sm text-gray-500 text-center py-2.5">Online payment isn't available for this school yet — please contact the school office.</p>
            ) : Number(invoice.balance) > 0 ? (
              <button /* existing Pay Now button, unchanged */>
                {/* ... */}
              </button>
            ) : (
              <p className="text-sm text-green-600 text-center font-medium">This invoice has been fully paid.</p>
            )}
```

- [ ] **Step 4: Lint and build**

Run: `npm --workspace=@chronixedu/web run lint`
Expected: no new errors.

Run: `npm --workspace=@chronixedu/web run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/providers.tsx "apps/web/app/(dashboard)/layout.tsx" "apps/web/app/(parent)/parent/fees/page.tsx"
git commit -m "feat: hide payout/analytics/pay-now UI for basic-tier schools"
```

---

### Task 8: Homepage pricing section rewrite

**Files:**
- Modify: `apps/web/app/home-page.tsx`

**Interfaces:** none — self-contained marketing content change.

No automated test — matches the plan's note that this page has no existing test coverage pattern.

- [ ] **Step 1: Remove the monthly/annual toggle state and `prices` object**

Delete lines 17-22 (the `prices` const, `p`, and `period` derivations) and the `isAnnual` state (line 15) — this page no longer has a monthly/annual distinction.

- [ ] **Step 2: Remove the toggle UI**

Delete the `.toggle-wrap` block (currently lines 507-512, right after the `s-head` div in the pricing section).

- [ ] **Step 3: Replace the 4-card grid with Basic/Premium + an Enterprise callout**

Replace the entire `.pricing-grid` block (currently lines 513-568) with:

```tsx
          <div className="pricing-grid">
            <div className="price-card reveal">
              <div className="price-name">Basic</div>
              <div className="price-desc">Everything a school needs to run day to day</div>
              <div className="price-amount"><span className="price-num">₦400</span><span className="price-per">/student/term</span></div>
              <ul className="price-feats">
                <li><CheckIcon /> Results &amp; report cards</li>
                <li><CheckIcon /> Attendance &amp; behaviour tracking</li>
                <li><CheckIcon /> Timetable</li>
                <li><CheckIcon /> Parent &amp; student portals</li>
                <li><CheckIcon /> Fee invoicing &amp; manual payment recording</li>
                <li><CheckIcon /> In-app messaging &amp; announcements</li>
              </ul>
              <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-ghost">Get Started</a>
            </div>
            <div className="price-card featured reveal stagger-1">
              <span className="price-featured-badge">Recommended</span>
              <div className="price-name">Premium</div>
              <div className="price-desc">Everything in Basic, plus SMS and online payments</div>
              <div className="price-amount"><span className="price-num">₦600</span><span className="price-per">/student/term</span></div>
              <ul className="price-feats">
                <li><CheckIcon /> Everything in Basic</li>
                <li><CheckIcon /> SMS reminders for attendance &amp; fees</li>
                <li><CheckIcon /> Online fee collection via Paystack — settles directly to your school&apos;s bank account</li>
                <li><CheckIcon /> Analytics dashboard</li>
              </ul>
              <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-primary">Get Started</a>
            </div>
          </div>
          <div className="price-card reveal stagger-2" style={{ maxWidth: 640, margin: '32px auto 0' }}>
            <div className="price-name">Enterprise</div>
            <div className="price-desc">Boarding schools &amp; multi-campus groups — custom pricing</div>
            <a href="mailto:edu@chronixtechnology.com" className="lp-btn lp-btn-ghost">Talk to Sales</a>
          </div>
```

- [ ] **Step 4: Lint and build**

Run: `npm --workspace=@chronixedu/web run lint`
Expected: no new errors (confirm no other part of the file still references `isAnnual`/`prices`/`p`/`period` — check for a stray reference elsewhere before considering this done).

Run: `npm --workspace=@chronixedu/web run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/home-page.tsx
git commit -m "feat: rewrite homepage pricing section for per-student Basic/Premium/Enterprise"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete backend test suite**

Run: `npm test` (from repo root)
Expected: all suites pass. Pay particular attention to any pre-existing scenario test (`schoolSuspension.test.ts`, `phase4Integration.test.ts`, `onboardingWizard.test.ts`, etc.) whose fixture school never explicitly sets `subscription_tier` — confirm each still passes under the fail-open-on-null behavior; if any now unexpectedly hits a `FEATURE_NOT_IN_PLAN` 403, that fixture's `subscription_tier` needs to be set to `'premium'` explicitly.

- [ ] **Step 2: Lint and both builds**

Run: `npm run lint && npm --workspace=@chronixedu/web run build && npm --workspace=@chronixedu/api run build`
Expected: zero errors.

- [ ] **Step 3: Manual verification**

1. As super_admin, set a test school's plan to `basic` via the subscriptions UI. Log in as that school's bursar — confirm the Payout Setup nav entry is gone, and hitting `GET /api/schools/:id/settings/payout` directly (e.g. via curl with that bursar's token) returns `403 FEATURE_NOT_IN_PLAN`.
2. As a parent at that basic-tier school, confirm the fees page shows the "contact the school office" message instead of a working Pay Now button.
3. Switch the same school to `premium` — confirm all of the above now work normally, with no re-login required only if you also re-test after a fresh login (the JWT is claims-based and only refreshes on login, per Task 6 — note this to the user as an expected limitation: a school's plan change won't take effect for an already-logged-in user until they log in again).
4. Visit the homepage `#pricing` section — confirm Basic/Premium/Enterprise render correctly with no leftover monthly/annual toggle.
