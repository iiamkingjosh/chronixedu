# School Payout via Paystack Subaccounts — Design Spec

**Date:** 2026-08-06
**Status:** Approved for implementation planning

## Overview

Every parent fee payment across every school currently settles into a single Paystack account controlled by Chronix — there is no per-school payout routing anywhere in the schema or code. `school_id` is passed only as `metadata` on the Paystack transaction (a label, not a routing instruction). This means Chronix is, in effect, a single collection point for all schools' fee income, with no automated way to get money to the schools themselves.

This spec adds **Paystack Subaccounts** so each school's fee payments settle directly to that school's own bank account, automatically, per transaction, via Paystack's own split-settlement infrastructure. Chronix takes **0%** of fee payments — its subaccount `percentage_charge` is `0`, and the school (subaccount) bears Paystack's own processing fee (`bearer: "subaccount"`). Chronix's revenue (subscription/onboarding fees) is billed and recorded entirely separately via the existing `platform_subscriptions` / manual "record payment" flow in `superAdmin.ts`, and is unaffected by this feature.

The core property this design guarantees: **money is never held by Chronix, even momentarily.** Paystack settles the school's share straight to their bank on Paystack's normal settlement schedule; Chronix's own account receives nothing from these transactions.

## Current State (reference)

- `PAYSTACK_SECRET_KEY` — single global env var, one Paystack account for the whole platform ([env.ts:27](apps/api/src/config/env.ts#L27)).
- `initializePaystackTransaction()` — [paystackService.ts:76-108](apps/api/src/services/paystackService.ts#L76-L108) — takes no subaccount/split parameters today.
- `POST /:schoolId/payments/paystack/initialize` call site — [fees.ts:488-499](apps/api/src/routes/fees.ts#L488-L499) — passes `school_id` only inside `metadata`.
- `schools` table — no bank/payout columns exist prior to this feature. Migration `024_add_school_payout_config.sql` (already applied, see below) adds `payout_config JSONB NOT NULL DEFAULT '{}'::jsonb` plus a functional index on `payout_config->>'settlement_status'`.
- `isAdminRole()` / `ADMIN_ROLES` — [auth.ts:1-6](apps/web/lib/auth.ts#L1-L6) — currently `['principal', 'super_admin']` only. Bursar has no access to any `/settings/*` page today.
- `logAudit()` — [auditLog.ts:15](apps/api/src/db/queries/auditLog.ts#L15) — existing audit-log helper, reused as-is.
- `sendTermiiSms()` — [termiiService.ts:22](apps/api/src/services/termiiService.ts#L22) — existing SMS helper, reused as-is.
- Settings page pattern to follow — `apps/web/app/(dashboard)/settings/identity/page.tsx` (React Hook Form + Zod, `apiFetch`/`apiUpload`, local toast helper).

### Already done (out of band, before this spec's implementation plan)

Migration `024_add_school_payout_config.sql` has already been written and applied directly to production:

```sql
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS payout_config JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_schools_payout_settlement_status
  ON schools ((payout_config->>'settlement_status'));
```

`payout_config` shape:
```json
{
  "paystack_subaccount_code": "ACCT_xxx",
  "bank_code": "058",
  "account_number": "0123456789",
  "account_name": "GREENFIELD SECONDARY SCHOOL",
  "settlement_status": "pending" | "active" | "failed",
  "updated_at": "2026-08-06T10:00:00Z",
  "updated_by": "<user_id>"
}
```

**Known pre-existing issue, unrelated to this feature**: the `schema_migrations` tracking table was empty before migration 024 (migrations 001–023 were never recorded as applied, despite the live schema reflecting them). Migration 024 was applied and recorded directly, working around this gap rather than fixing it. Backfilling `schema_migrations` for 001–023 is a separate task, out of scope here.

## Decisions Made

- **Who manages bank details:** School's own bursar or principal, self-service (not super-admin-driven onboarding).
- **Existing live schools:** Fee collection is **blocked** (not silently pooled) until a school completes payout setup — forces the migration, zero risk of new money landing in the old pooled account by accident.
- **Paystack fee bearer:** The school (subaccount) absorbs Paystack's own transaction fee.
- **Platform fee:** 0% — no `platform_fee_percent` field; Chronix's subaccount `percentage_charge` is `0` at creation.
- **Change protection:** Bursar can change bank details directly (no approval gate), but the principal is emailed **and** SMS'd immediately on every change, as a fast-detection fraud control.
- **Parent-facing error:** A clear message ("Online payment isn't set up yet for this school — please contact the school office"), not a generic Paystack error.
- **Bursar's settings access:** Narrow carve-out — bursar gets access to only the new payout page, not the rest of `/settings/*` (which stays principal/super_admin-only via the existing `isAdminRole()` gate, left unchanged).

## Behavior

### 1. Backend — Paystack service functions

New functions in `paystackService.ts`:

```ts
listBanks(): Promise<{ name: string; code: string }[]>
// GET https://api.paystack.co/bank?country=nigeria

resolveBankAccount(bankCode: string, accountNumber: string): Promise<{ account_name: string } | null>
// GET https://api.paystack.co/bank/resolve?account_number=...&bank_code=...
// Returns null on any failure (invalid account, Paystack error) — caller shows a validation error.

createPaystackSubaccount(input: {
  businessName: string;
  bankCode: string;
  accountNumber: string;
}): Promise<{ subaccount_code: string } | null>
// POST https://api.paystack.co/subaccount
// body: { business_name, settlement_bank: bankCode, account_number, percentage_charge: 0 }
```

`initializePaystackTransaction()` gains two new optional input fields: `subaccountCode?: string` and `bearer?: 'subaccount'`. When present, both are passed through in the `/transaction/initialize` request body as `subaccount` and `bearer`.

### 2. Backend — new payout settings route

New route, school-scoped, `verifyToken` + `requireRole(['bursar', 'principal'])` (rule C5):

- `GET /:schoolId/settings/payout` — returns current `payout_config` with `account_number` masked to last 4 digits (never returns the full number once saved).
- `POST /:schoolId/settings/payout/resolve` — body `{ bank_code, account_number }`, calls `resolveBankAccount`, returns the resolved `account_name` for the frontend confirmation step. No DB write.
- `PUT /:schoolId/settings/payout` — body `{ bank_code, account_number, account_name }` (the confirmed values from the resolve step), validated with Zod (rule C7). Flow:
  1. Re-resolve server-side (never trust the client-confirmed name alone) and verify it matches what was confirmed.
  2. Call `createPaystackSubaccount()`.
  3. On success: write `payout_config` with `settlement_status: 'active'`, `logAudit()` with masked account details (rule C11), and fire-and-forget the principal email + SMS alert.
  4. On Paystack failure: write `settlement_status: 'failed'` with the error reason, return `502`.

### 3. Backend — `fees.ts` payment-initialize gate

At [fees.ts:488](apps/api/src/routes/fees.ts#L488), before the existing `isPaystackConfigured()` check: fetch the school's `payout_config.settlement_status`. If not `'active'`, return `503 { code: 'PAYOUT_NOT_CONFIGURED', message: 'Online payment isn't set up yet for this school — please contact the school office.' }`. If active, pass `subaccountCode: payout_config.paystack_subaccount_code` and `bearer: 'subaccount'` into `initializePaystackTransaction()`. No change needed to the `charge.success` webhook handler — split settlement is transparent to the webhook payload.

### 4. Frontend — payout settings page

New page: `apps/web/app/(dashboard)/settings/payout/page.tsx`, following the `settings/identity/page.tsx` pattern (React Hook Form + Zod, `apiFetch`, toast helper). Two-step UI:
1. Select bank (dropdown from `listBanks()`) + enter account number → call resolve endpoint → show resolved account name for confirmation.
2. Confirm → `PUT` the settings route → success toast, page now shows masked account details with a "Change bank account" option that re-runs the same flow.

If `settlement_status === 'failed'`, show the failure reason inline with a retry.

### 5. Frontend — access control for the new page

New helper `canAccessPayoutSettings(role)` in `apps/web/lib/auth.ts`: `['principal', 'bursar', 'super_admin']`. Used for:
- The page's own client-side guard (redirect if role doesn't match — defense in depth; the API route is the real boundary).
- A standalone nav entry in the dashboard layout, rendered outside the existing `showSettings`/`SETTINGS_NAV` block, so bursar sees only this one item and nothing else under Settings. `isAdminRole()` / `ADMIN_ROLES` / `SETTINGS_NAV` are left unchanged.

### 6. Frontend — parent fees page error state

In the parent fees page's "Pay Now" flow, when the initialize call returns `PAYOUT_NOT_CONFIGURED`, show the dedicated message instead of the current generic Paystack-failure copy.

### 7. Super-admin visibility

Add one column ("Payout: Active / Pending") to the existing super-admin schools list, backed by the `payout_config->>'settlement_status'` index from migration 024. Read-only — no new write path for super admin.

### 8. Rollout for currently-live schools

1. Ship with the block-until-active gate live.
2. Send one platform announcement (existing `platform_announcements` / SendGrid delivery system) to every principal/bursar: action required to keep collecting fees online.
3. Track completion via the new super-admin schools-list column.

## Data Flow

```
Bursar/principal → Settings → Payout Setup
        │
        ├─ Select bank + enter account number
        │        └─ POST .../payout/resolve → Paystack /bank/resolve → account_name shown for confirmation
        │
        └─ Confirm
                 └─ PUT .../payout
                          ├─ re-resolve server-side (trust nothing from client except bank_code/account_number)
                          ├─ Paystack POST /subaccount (percentage_charge: 0)
                          ├─ payout_config written, settlement_status: 'active'
                          ├─ logAudit() — masked account details
                          └─ (fire-and-forget) email + SMS to principal


Parent → Pay Now (fees.ts initialize route)
        │
        ├─ payout_config.settlement_status !== 'active'
        │        └─ 503 PAYOUT_NOT_CONFIGURED → "contact the school office" message
        │
        └─ settlement_status === 'active'
                 └─ initializePaystackTransaction(subaccountCode, bearer: 'subaccount')
                          └─ Paystack splits at settlement:
                                   ├─ school's share → school's bank account directly
                                   └─ Chronix's Paystack account → receives nothing (percentage_charge: 0)
```

## Error Handling

- **Bank resolve fails** (bad account number, Paystack downtime): resolve endpoint returns `null` → frontend shows "Couldn't verify this account — check the details and try again," no partial state saved.
- **Subaccount creation fails** after a successful resolve: `payout_config.settlement_status` set to `'failed'` with reason stored; settings page shows the failure with a retry option; fee collection stays blocked (no partial/ambiguous state).
- **Parent attempts payment, school not configured**: `503 PAYOUT_NOT_CONFIGURED`, clear contact-the-school message, no Paystack call attempted.
- **Bank details changed on an already-active school**: treated identically to first-time setup (re-resolve, re-verify, new subaccount or update existing one via Paystack's `PUT /subaccount/:code`), plus the principal alert fires every time, including this case.

## Testing

- Unit: `paystackService.test.ts` — `listBanks`, `resolveBankAccount`, `createPaystackSubaccount`, and the new `subaccountCode`/`bearer` pass-through in `initializePaystackTransaction`.
- New scenario test `apps/api/tests/feesPayout.test.ts` (matching existing scenario-test style): payment initialize is blocked with `PAYOUT_NOT_CONFIGURED` when `settlement_status` isn't `'active'`; succeeds with `subaccount`/`bearer` attached when it is.
- New route tests for `GET/POST/PUT .../settings/payout`: role enforcement (bursar/principal allowed, other roles `403`), account-number masking on `GET`, audit log written on successful `PUT`.
- Manual/integration: full flow verified against Paystack's test mode (test secret key, Paystack-provided test bank accounts) before going live with a real school.

## Out of Scope

- Paystack Transfers API / manual settlement (Approach B) — explicitly rejected in favor of automatic per-transaction subaccount splitting.
- Per-school configurable platform fee percentage — Chronix takes 0% of fee payments; not a field that exists.
- Principal-approval-gated bank changes — email/SMS alert only, no approval workflow.
- Backfilling the `schema_migrations` tracking table for migrations 001–023 — pre-existing gap, unrelated to this feature, tracked separately.
- Changes to the subscription/onboarding-payment billing flow (`platform_subscriptions`, `record-payment` route) — entirely separate from parent fee payments and untouched by this spec.
