# School Onboarding & Settings API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build POST /api/schools (create + seed defaults), GET /api/schools/:schoolId, PATCH /api/schools/:schoolId/identity, PATCH /api/schools/:schoolId/academic-config (with 423/warnings logic), and POST /api/schools/:schoolId/logo (Supabase Storage upload).

**Architecture:** New route file `apps/api/src/routes/schools.ts` wired into `index.ts`. Business logic lives in `apps/api/src/services/schoolService.ts`. Raw SQL functions live in `apps/api/src/db/queries/schools.ts`. A shared pg Pool lives in `apps/api/src/db/client.ts`. Audit logging via `apps/api/src/db/queries/auditLog.ts`. School data is split between a `schools` table (id, name) and a `school_settings` table with `identity_config` JSONB and `academic_config` JSONB.

**Tech Stack:** Node.js + Express + TypeScript (strict), PostgreSQL (pg Pool), Supabase Storage, Zod (validation), Multer (multipart), express-rate-limit, Winston logger, Jest + ts-jest + Supertest (tests).

> **DECISION REQUIRED — path aliases:** The existing `apps/api` tsconfig defines `@/*` but ts-node-dev does not have `tsconfig-paths/register` wired up, so existing routes use relative imports. This plan follows the same pattern (relative imports) to avoid breaking the dev server. To enable `@/` aliases, add `-r tsconfig-paths/register` to the `dev` script and install `tsconfig-paths`.

> **DECISION REQUIRED — JWT claim casing:** The existing `AuthUser` interface uses `school_id` (snake_case). The Agent File (Rule C9) says to use `req.user.schoolId`. This plan uses `req.user!.school_id` to match the existing interface. Clean up all routes to camelCase JWT claims in a separate task once the interface is updated.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `apps/api/src/migrations/002_schools_settings.sql` | DDL for schools, school_settings, audit_logs |
| Create | `apps/api/src/db/client.ts` | Shared pg Pool singleton |
| Create | `apps/api/src/db/queries/auditLog.ts` | `logAudit()` helper |
| Create | `apps/api/src/db/queries/schools.ts` | All SQL functions for schools domain |
| Create | `apps/api/src/services/schoolService.ts` | Business logic: seeding, grade validation, results check |
| Create | `apps/api/src/middleware/errorHandler.ts` | Global Express error handler |
| Create | `apps/api/src/routes/schools.ts` | All 5 school endpoints |
| Create | `apps/api/src/__tests__/schools.test.ts` | Supertest integration tests |
| Modify | `apps/api/src/index.ts` | Register school routes, rate limiting, error handler |
| Modify | `apps/api/package.json` | Add multer, zod, express-rate-limit, winston, jest deps |
| Modify | `.env.example` | Add SUPABASE_STORAGE_BUCKET |

---

## Task 1: Install dependencies

**Files:**
- Modify: `apps/api/package.json`

- [ ] **Step 1: Install runtime dependencies**

Run from `apps/api/`:
```bash
cd "apps/api" && npm install multer zod express-rate-limit winston @supabase/supabase-js
npm install --save-dev @types/multer jest ts-jest @types/jest supertest @types/supertest
```

Expected: No errors. `node_modules` updated.

- [ ] **Step 2: Verify package.json has the new deps**

Check that `apps/api/package.json` now lists `multer`, `zod`, `express-rate-limit`, `winston` under dependencies.

- [ ] **Step 3: Add Jest config to package.json**

Open `apps/api/package.json` and add:
```json
{
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc -p tsconfig.json",
    "lint": "eslint . --ext .ts",
    "test": "jest --runInBand"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "roots": ["<rootDir>/src"],
    "testMatch": ["**/__tests__/**/*.test.ts"],
    "moduleNameMapper": {
      "^@/(.*)$": "<rootDir>/$1"
    }
  }
}
```

- [ ] **Step 4: Verify Jest runs (no tests yet)**

```bash
cd "apps/api" && npm test
```

Expected: `No tests found` or `Test Suites: 0 passed` — not an error exit.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json
git commit -m "chore: add multer, zod, rate-limit, winston, jest to api"
```

---

## Task 2: Write & run migration SQL

**Files:**
- Create: `apps/api/src/migrations/002_schools_settings.sql`

- [ ] **Step 1: Create the migration file**

`apps/api/src/migrations/002_schools_settings.sql`:
```sql
-- 002_schools_settings.sql
-- Schools, school_settings, and audit_logs tables

CREATE TABLE IF NOT EXISTS schools (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS school_settings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  identity_config JSONB       NOT NULL DEFAULT '{}',
  academic_config JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID        REFERENCES schools(id) ON DELETE SET NULL,
  user_id     UUID,
  action      TEXT        NOT NULL,
  entity      TEXT        NOT NULL,
  entity_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_school_id ON audit_logs(school_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
```

- [ ] **Step 2: Run the migration against your Supabase DB**

In Supabase dashboard → SQL Editor, paste and run the file contents.  
Or via psql:
```bash
psql $DATABASE_URL -f apps/api/src/migrations/002_schools_settings.sql
```

Expected: `CREATE TABLE`, `CREATE TABLE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE INDEX` — no errors.

- [ ] **Step 3: Verify tables exist**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('schools', 'school_settings', 'audit_logs');
```

Expected: 3 rows returned.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/migrations/002_schools_settings.sql
git commit -m "feat: add schools, school_settings, audit_logs migration"
```

---

## Task 3: Create DB Pool client

**Files:**
- Create: `apps/api/src/db/client.ts`

- [ ] **Step 1: Create the file**

`apps/api/src/db/client.ts`:
```typescript
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;
```

- [ ] **Step 2: Install pg types if missing**

```bash
cd "apps/api" && npm install pg @types/pg
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "apps/api" && npx tsc --noEmit
```

Expected: No errors on the new file.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/client.ts apps/api/package.json apps/api/package-lock.json
git commit -m "feat: add pg pool singleton at db/client.ts"
```

---

## Task 4: Create audit log helper

**Files:**
- Create: `apps/api/src/db/queries/auditLog.ts`

- [ ] **Step 1: Write a failing test**

Create `apps/api/src/__tests__/auditLog.test.ts`:
```typescript
import pool from '../db/client';
import { logAudit } from '../db/queries/auditLog';

jest.mock('../db/client', () => ({
  default: { query: jest.fn() },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe('logAudit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a row into audit_logs with all fields', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await logAudit({
      schoolId: 'school-1',
      userId: 'user-1',
      action: 'SCORE_UPDATE',
      entity: 'scores',
      entityId: 'score-1',
      oldValue: { score: 80 },
      newValue: { score: 90 },
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      ['school-1', 'user-1', 'SCORE_UPDATE', 'scores', 'score-1', { score: 80 }, { score: 90 }]
    );
  });

  it('works when optional fields are undefined', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await logAudit({
      schoolId: 'school-1',
      userId: 'user-1',
      action: 'IDENTITY_UPDATE',
      entity: 'school_settings',
      entityId: 'settings-1',
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      ['school-1', 'user-1', 'IDENTITY_UPDATE', 'school_settings', 'settings-1', undefined, undefined]
    );
  });
});
```

- [ ] **Step 2: Run test — expect it to fail**

```bash
cd "apps/api" && npm test -- --testPathPattern=auditLog
```

Expected: FAIL — `Cannot find module '../db/queries/auditLog'`

- [ ] **Step 3: Create the audit log helper**

`apps/api/src/db/queries/auditLog.ts`:
```typescript
import pool from '../client';

interface AuditLogEntry {
  schoolId: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.schoolId, entry.userId, entry.action, entry.entity, entry.entityId, entry.oldValue, entry.newValue]
  );
}
```

- [ ] **Step 4: Run test — expect it to pass**

```bash
cd "apps/api" && npm test -- --testPathPattern=auditLog
```

Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/queries/auditLog.ts apps/api/src/__tests__/auditLog.test.ts
git commit -m "feat: add logAudit helper with tests"
```

---

## Task 5: Create school DB query functions

**Files:**
- Create: `apps/api/src/db/queries/schools.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/__tests__/schoolQueries.test.ts`:
```typescript
import pool from '../db/client';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';

jest.mock('../db/client', () => ({ default: { query: jest.fn() } }));
const mockQuery = pool.query as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('insertSchool', () => {
  it('inserts and returns the new school row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc', name: 'Test School' }] });
    const school = await insertSchool('Test School');
    expect(school).toEqual({ id: 'abc', name: 'Test School' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schools'),
      ['Test School']
    );
  });
});

describe('insertSchoolSettings', () => {
  it('inserts default settings and returns the row', async () => {
    const defaults = { grading_scale: [] };
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'settings-1', school_id: 'abc' }] });
    const row = await insertSchoolSettings('abc', {}, defaults);
    expect(row.school_id).toBe('abc');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO school_settings'),
      expect.arrayContaining(['abc'])
    );
  });
});

describe('findSchoolById', () => {
  it('returns school with settings when found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'abc',
        name: 'Test School',
        identity_config: {},
        academic_config: { grading_scale: [] },
      }],
    });
    const result = await findSchoolById('abc');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abc');
  });

  it('returns null when school not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findSchoolById('missing');
    expect(result).toBeNull();
  });
});

describe('updateIdentityConfig', () => {
  it('merges patch into identity_config JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'settings-1' }] });
    const patch = { name: 'New Name', primary_colour: '#FF761B' };
    await updateIdentityConfig('abc', patch);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('identity_config = identity_config ||'),
      [JSON.stringify(patch), 'abc']
    );
  });
});

describe('updateAcademicConfig', () => {
  it('merges patch into academic_config JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'settings-1' }] });
    const patch = { promotion_cutoff: 45 };
    await updateAcademicConfig('abc', patch);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('academic_config = academic_config ||'),
      [JSON.stringify(patch), 'abc']
    );
  });
});

describe('checkPublishedResultsExist', () => {
  it('returns false when result_status table does not exist', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "result_status" does not exist'));
    const exists = await checkPublishedResultsExist('abc');
    expect(exists).toBe(false);
  });

  it('returns true when published rows found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const exists = await checkPublishedResultsExist('abc');
    expect(exists).toBe(true);
  });
});

describe('checkSubmittedResultsExist', () => {
  it('returns false when result_status table does not exist', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "result_status" does not exist'));
    const exists = await checkSubmittedResultsExist('abc');
    expect(exists).toBe(false);
  });

  it('returns true when submitted rows found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const exists = await checkSubmittedResultsExist('abc');
    expect(exists).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd "apps/api" && npm test -- --testPathPattern=schoolQueries
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the query file**

`apps/api/src/db/queries/schools.ts`:
```typescript
import pool from '../client';

export interface SchoolRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SchoolWithSettings extends SchoolRow {
  identity_config: Record<string, unknown>;
  academic_config: Record<string, unknown>;
}

export async function insertSchool(name: string): Promise<SchoolRow> {
  const result = await pool.query<SchoolRow>(
    `INSERT INTO schools (name) VALUES ($1) RETURNING *`,
    [name]
  );
  return result.rows[0];
}

export async function insertSchoolSettings(
  schoolId: string,
  identityConfig: Record<string, unknown>,
  academicConfig: Record<string, unknown>
): Promise<{ id: string; school_id: string }> {
  const result = await pool.query(
    `INSERT INTO school_settings (school_id, identity_config, academic_config)
     VALUES ($1, $2, $3)
     RETURNING id, school_id`,
    [schoolId, JSON.stringify(identityConfig), JSON.stringify(academicConfig)]
  );
  return result.rows[0];
}

export async function findSchoolById(schoolId: string): Promise<SchoolWithSettings | null> {
  const result = await pool.query<SchoolWithSettings>(
    `SELECT s.id, s.name, s.created_at, s.updated_at,
            ss.identity_config, ss.academic_config
     FROM schools s
     LEFT JOIN school_settings ss ON ss.school_id = s.id
     WHERE s.id = $1`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}

export async function updateIdentityConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET identity_config = identity_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function updateAcademicConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET academic_config = academic_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function checkPublishedResultsExist(schoolId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::text AS count FROM result_status
       WHERE school_id = $1 AND status = 'published'`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    // result_status table does not exist yet — safe to proceed
    return false;
  }
}

export async function checkSubmittedResultsExist(schoolId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::text AS count FROM result_status
       WHERE school_id = $1 AND status = 'submitted'`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd "apps/api" && npm test -- --testPathPattern=schoolQueries
```

Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/queries/schools.ts apps/api/src/__tests__/schoolQueries.test.ts
git commit -m "feat: add school DB query functions with tests"
```

---

## Task 6: Create school service

**Files:**
- Create: `apps/api/src/services/schoolService.ts`

The service holds: Nigerian default config, grade band validation, and the seed-on-create logic. Routes stay thin — all business rules here.

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/__tests__/schoolService.test.ts`:
```typescript
import { validateGradeBands, NIGERIAN_DEFAULTS } from '../services/schoolService';

describe('NIGERIAN_DEFAULTS', () => {
  it('has 5 grade bands', () => {
    expect(NIGERIAN_DEFAULTS.grading_scale).toHaveLength(5);
  });

  it('assessment_components weights sum to 100', () => {
    const total = NIGERIAN_DEFAULTS.assessment_components.reduce(
      (sum: number, c: { weight: number }) => sum + c.weight, 0
    );
    expect(total).toBe(100);
  });

  it('grading_scale covers 0-100 without gaps', () => {
    const sorted = [...NIGERIAN_DEFAULTS.grading_scale].sort(
      (a: { min: number }, b: { min: number }) => a.min - b.min
    );
    expect(sorted[0].min).toBe(0);
    expect(sorted[sorted.length - 1].max).toBe(100);
  });
});

describe('validateGradeBands', () => {
  it('returns null for valid non-overlapping bands covering 0-100', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: '' },
      { grade: 'B', min: 60, max: 69, label: 'Very Good', remark: '' },
      { grade: 'C', min: 50, max: 59, label: 'Good', remark: '' },
      { grade: 'D', min: 40, max: 49, label: 'Pass', remark: '' },
      { grade: 'F', min: 0,  max: 39, label: 'Fail', remark: '' },
    ];
    expect(validateGradeBands(bands)).toBeNull();
  });

  it('returns error when bands have a gap', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 60,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/gap/i);
  });

  it('returns error when bands overlap', () => {
    const bands = [
      { grade: 'A', min: 60, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 65,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/overlap/i);
  });

  it('returns error when lowest band does not start at 0', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 10, max: 69,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/must start at 0/i);
  });

  it('returns error when highest band does not end at 100', () => {
    const bands = [
      { grade: 'A', min: 70, max: 99, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 69, label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/must end at 100/i);
  });

  it('returns error when a band has min > max', () => {
    const bands = [
      { grade: 'A', min: 100, max: 70, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,   max: 99, label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/min.*max/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd "apps/api" && npm test -- --testPathPattern=schoolService
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the service**

`apps/api/src/services/schoolService.ts`:
```typescript
export interface GradeBand {
  grade: string;
  min: number;
  max: number;
  label: string;
  remark: string;
}

export interface AssessmentComponent {
  name: string;
  max_score: number;
  weight: number;
  display_order: number;
}

export interface AcademicCalendarTerm {
  term: string;
  typical_start: string;
  typical_end: string;
}

export interface AcademicConfig {
  grading_scale: GradeBand[];
  promotion_cutoff: number;
  assessment_components: AssessmentComponent[];
  academic_calendar: AcademicCalendarTerm[];
}

export const NIGERIAN_DEFAULTS: AcademicConfig = {
  grading_scale: [
    { grade: 'A', min: 70, max: 100, label: 'Excellent',  remark: 'Outstanding performance' },
    { grade: 'B', min: 60, max: 69,  label: 'Very Good',  remark: 'Above average performance' },
    { grade: 'C', min: 50, max: 59,  label: 'Good',       remark: 'Average performance' },
    { grade: 'D', min: 40, max: 49,  label: 'Pass',       remark: 'Below average but passing' },
    { grade: 'F', min: 0,  max: 39,  label: 'Fail',       remark: 'Below passing mark' },
  ],
  promotion_cutoff: 40,
  assessment_components: [
    { name: 'CA 1',           max_score: 10, weight: 10, display_order: 1 },
    { name: 'CA 2',           max_score: 10, weight: 10, display_order: 2 },
    { name: 'Mid-Term Test',  max_score: 10, weight: 10, display_order: 3 },
    { name: 'Examination',    max_score: 70, weight: 70, display_order: 4 },
  ],
  academic_calendar: [
    { term: 'First Term',  typical_start: 'September', typical_end: 'December' },
    { term: 'Second Term', typical_start: 'January',   typical_end: 'April' },
    { term: 'Third Term',  typical_start: 'May',        typical_end: 'July' },
  ],
};

/**
 * Returns an error message string if bands are invalid, or null if valid.
 * Valid bands: no overlaps, no gaps, cover exactly 0-100, each band has min <= max.
 */
export function validateGradeBands(bands: GradeBand[]): string | null {
  for (const band of bands) {
    if (band.min > band.max) {
      return `Grade ${band.grade}: min (${band.min}) must not exceed max (${band.max})`;
    }
  }

  const sorted = [...bands].sort((a, b) => a.min - b.min);

  if (sorted[0].min !== 0) {
    return `Grade bands must start at 0. Lowest min is ${sorted[0].min}`;
  }

  if (sorted[sorted.length - 1].max !== 100) {
    return `Grade bands must end at 100. Highest max is ${sorted[sorted.length - 1].max}`;
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.min <= prev.max) {
      return `Grade bands overlap: ${prev.grade} (${prev.min}-${prev.max}) and ${curr.grade} (${curr.min}-${curr.max})`;
    }
    if (curr.min !== prev.max + 1) {
      return `Gap in grade bands between ${prev.grade} (max ${prev.max}) and ${curr.grade} (min ${curr.min})`;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd "apps/api" && npm test -- --testPathPattern=schoolService
```

Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/schoolService.ts apps/api/src/__tests__/schoolService.test.ts
git commit -m "feat: add school service with Nigerian defaults and grade band validation"
```

---

## Task 7: Create global error handler

**Files:**
- Create: `apps/api/src/middleware/errorHandler.ts`

- [ ] **Step 1: Create the file**

`apps/api/src/middleware/errorHandler.ts`:
```typescript
import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message },
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "apps/api" && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/middleware/errorHandler.ts
git commit -m "feat: add global error handler middleware"
```

---

## Task 8: Create the schools route

**Files:**
- Create: `apps/api/src/routes/schools.ts`

This is the main task. All 5 endpoints, full Zod validation, try/catch on every handler, standard response envelope, audit logging on writes.

- [ ] **Step 1: Write failing route tests**

Create `apps/api/src/__tests__/schools.test.ts`:
```typescript
import request from 'supertest';
import express from 'express';
import schoolsRouter from '../routes/schools';
import { errorHandler } from '../middleware/errorHandler';
import * as schoolQueries from '../db/queries/schools';
import * as auditLog from '../db/queries/auditLog';
import { supabaseAdmin } from '../supabaseClient';

jest.mock('../db/queries/schools');
jest.mock('../db/queries/auditLog');
jest.mock('../supabaseClient', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn().mockReturnValue({
        upload: jest.fn(),
        getPublicUrl: jest.fn(),
      }),
    },
  },
}));

const mockQueries = schoolQueries as jest.Mocked<typeof schoolQueries>;
const mockAudit  = auditLog   as jest.Mocked<typeof auditLog>;

// ── JWT helper ────────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';
process.env.JWT_SECRET = 'test-secret';

function makeToken(role: string, schoolId?: string) {
  return jwt.sign(
    { user_id: 'user-1', role, school_id: schoolId ?? null, email: 'test@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

// ── Test app ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/schools', schoolsRouter);
app.use(errorHandler);

// ── POST /api/schools ─────────────────────────────────────────────────────────
describe('POST /api/schools', () => {
  it('creates a school and returns 201', async () => {
    mockQueries.insertSchool.mockResolvedValueOnce({
      id: 'school-1', name: 'Test School', created_at: '', updated_at: '',
    });
    mockQueries.insertSchoolSettings.mockResolvedValueOnce({
      id: 'settings-1', school_id: 'school-1',
    });

    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ name: 'Test School' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.school.name).toBe('Test School');
  });

  it('returns 400 if name is missing', async () => {
    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 for non-super_admin', async () => {
    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-1')}`)
      .send({ name: 'Test School' });

    expect(res.status).toBe(403);
  });
});

// ── GET /api/schools/:schoolId ────────────────────────────────────────────────
describe('GET /api/schools/:schoolId', () => {
  it('returns school for super_admin', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce({
      id: 'school-1', name: 'Test', created_at: '', updated_at: '',
      identity_config: {}, academic_config: {},
    });

    const res = await request(app)
      .get('/api/schools/school-1')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('school-1');
  });

  it('returns school for a principal requesting their own school', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce({
      id: 'school-1', name: 'Test', created_at: '', updated_at: '',
      identity_config: {}, academic_config: {},
    });

    const res = await request(app)
      .get('/api/schools/school-1')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-1')}`);

    expect(res.status).toBe(200);
  });

  it('returns 403 for a principal requesting a different school', async () => {
    const res = await request(app)
      .get('/api/schools/other-school')
      .set('Authorization', `Bearer ${makeToken('principal', 'school-1')}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 when school does not exist', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/schools/missing')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`);

    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/schools/:schoolId/identity ─────────────────────────────────────
describe('PATCH /api/schools/:schoolId/identity', () => {
  it('updates identity config and returns 200', async () => {
    mockQueries.findSchoolById.mockResolvedValueOnce({
      id: 'school-1', name: 'Old', created_at: '', updated_at: '',
      identity_config: { name: 'Old' }, academic_config: {},
    });
    mockQueries.updateIdentityConfig.mockResolvedValueOnce(undefined);
    mockAudit.logAudit.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-1/identity')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockAudit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IDENTITY_UPDATE' })
    );
  });

  it('returns 400 for invalid colour format', async () => {
    const res = await request(app)
      .patch('/api/schools/school-1/identity')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ primary_colour: 'not-a-colour' });

    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/schools/:schoolId/academic-config ──────────────────────────────
describe('PATCH /api/schools/:schoolId/academic-config', () => {
  const validBands = [
    { grade: 'A', min: 70, max: 100, label: 'Excellent',  remark: '' },
    { grade: 'B', min: 60, max: 69,  label: 'Very Good',  remark: '' },
    { grade: 'C', min: 50, max: 59,  label: 'Good',       remark: '' },
    { grade: 'D', min: 40, max: 49,  label: 'Pass',       remark: '' },
    { grade: 'F', min: 0,  max: 39,  label: 'Fail',       remark: '' },
  ];

  it('updates academic config and returns 200', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(false);
    mockQueries.updateAcademicConfig.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-1/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.warnings).toBeUndefined();
  });

  it('returns 423 when published results exist', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(true);

    const res = await request(app)
      .patch('/api/schools/school-1/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('CONFIG_LOCKED');
  });

  it('returns 200 with warnings when submitted results exist', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(true);
    mockQueries.updateAcademicConfig.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/api/schools/school-1/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: validBands });

    expect(res.status).toBe(200);
    expect(res.body.data.warnings).toBeDefined();
    expect(res.body.data.warnings.length).toBeGreaterThan(0);
  });

  it('returns 400 when grade bands are invalid', async () => {
    mockQueries.checkPublishedResultsExist.mockResolvedValueOnce(false);
    mockQueries.checkSubmittedResultsExist.mockResolvedValueOnce(false);

    const overlappingBands = [
      { grade: 'A', min: 60, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 65,  label: 'Fail',      remark: '' },
    ];

    const res = await request(app)
      .patch('/api/schools/school-1/academic-config')
      .set('Authorization', `Bearer ${makeToken('super_admin')}`)
      .send({ grading_scale: overlappingBands });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRADE_BANDS');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd "apps/api" && npm test -- --testPathPattern=schools.test
```

Expected: FAIL — `Cannot find module '../routes/schools'`

- [ ] **Step 3: Create the schools route**

`apps/api/src/routes/schools.ts`:
```typescript
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';
import { logAudit } from '../db/queries/auditLog';
import { NIGERIAN_DEFAULTS, validateGradeBands } from '../services/schoolService';
import { supabaseAdmin } from '../supabaseClient';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createSchoolSchema = z.object({
  name: z.string().min(1).max(255),
  motto: z.string().max(500).optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
});

const updateIdentitySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  motto: z.string().max(500).optional(),
  logo_url: z.string().url().optional(),
  stamp_url: z.string().url().optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const gradeBandSchema = z.object({
  grade: z.string().min(1),
  min: z.number().int().min(0).max(100),
  max: z.number().int().min(0).max(100),
  label: z.string().min(1),
  remark: z.string(),
});

const updateAcademicSchema = z.object({
  grading_scale: z.array(gradeBandSchema).min(1).optional(),
  promotion_cutoff: z.number().int().min(0).max(100).optional(),
  assessment_components: z.array(z.object({
    name: z.string().min(1),
    max_score: z.number().int().positive(),
    weight: z.number().int().positive(),
    display_order: z.number().int().positive(),
  })).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ── Middleware: allow super_admin or matching principal ───────────────────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) { res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }); return; }
  if (user.role === 'super_admin') { next(); return; }
  if (user.role === 'principal' && user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

// ── POST /api/schools ─────────────────────────────────────────────────────────

router.post(
  '/',
  verifyToken,
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { name, motto, primary_colour, secondary_colour } = parsed.data;

      const school = await insertSchool(name);

      const identityConfig: Record<string, unknown> = { name, motto: motto ?? '', logo_url: null, stamp_url: null };
      if (primary_colour)   identityConfig.primary_colour   = primary_colour;
      if (secondary_colour) identityConfig.secondary_colour = secondary_colour;

      const settings = await insertSchoolSettings(school.id, identityConfig, NIGERIAN_DEFAULTS);

      return res.status(201).json({ success: true, data: { school, settings } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId ────────────────────────────────────────────────

router.get(
  '/:schoolId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }
      return res.json({ success: true, data: school });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/identity ─────────────────────────────────────

router.patch(
  '/:schoolId/identity',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateIdentitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findSchoolById(req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const patch = parsed.data as Record<string, unknown>;
      await updateIdentityConfig(req.params.schoolId, patch);

      await logAudit({
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        action: 'IDENTITY_UPDATE',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        oldValue: existing.identity_config,
        newValue: { ...existing.identity_config, ...patch },
      });

      return res.json({ success: true, data: { message: 'Identity updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/academic-config ──────────────────────────────

router.patch(
  '/:schoolId/academic-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateAcademicSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { grading_scale, promotion_cutoff, assessment_components } = parsed.data;

      // Validate grade bands if provided
      if (grading_scale) {
        const bandError = validateGradeBands(grading_scale);
        if (bandError) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_GRADE_BANDS', message: bandError } });
        }
      }

      // Check for published results (block)
      const hasPublished = await checkPublishedResultsExist(req.params.schoolId);
      if (hasPublished) {
        return res.status(423).json({
          success: false,
          error: { code: 'CONFIG_LOCKED', message: 'Academic config cannot be changed while published results exist for the current term.' },
        });
      }

      // Check for submitted results (warn, but proceed)
      const hasSubmitted = await checkSubmittedResultsExist(req.params.schoolId);
      const warnings: string[] = [];
      if (hasSubmitted) {
        warnings.push('Submitted results exist for the current term. Changing the grading scale will not retroactively recalculate those results.');
      }

      // Validate assessment component weights sum to 100 if provided
      if (assessment_components) {
        const total = assessment_components.reduce((sum, c) => sum + c.weight, 0);
        if (total !== 100) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Assessment component weights must sum to 100. Got ${total}.` } });
        }
      }

      const patch: Record<string, unknown> = {};
      if (grading_scale)          patch.grading_scale          = grading_scale;
      if (promotion_cutoff !== undefined) patch.promotion_cutoff = promotion_cutoff;
      if (assessment_components)  patch.assessment_components  = assessment_components;

      await updateAcademicConfig(req.params.schoolId, patch);

      const response: Record<string, unknown> = { message: 'Academic config updated' };
      if (warnings.length > 0) response.warnings = warnings;

      return res.json({ success: true, data: response });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/logo ─────────────────────────────────────────

router.post(
  '/:schoolId/logo',
  verifyToken,
  requireSchoolAccess,
  upload.single('logo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "logo".' } });
      }

      const allowed = ['image/jpeg', 'image/png'];
      if (!allowed.includes(file.mimetype)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'Only JPEG and PNG files are allowed.' } });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const storagePath = `schools/${req.params.schoolId}/logo.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const logoUrl = urlData.publicUrl;

      await updateIdentityConfig(req.params.schoolId, { logo_url: logoUrl });

      await logAudit({
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        action: 'LOGO_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { logo_url: logoUrl },
      });

      return res.json({ success: true, data: { logo_url: logoUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd "apps/api" && npm test -- --testPathPattern=schools.test
```

Expected: PASS — all route tests green.

- [ ] **Step 5: Run full test suite**

```bash
cd "apps/api" && npm test
```

Expected: All tests across auditLog, schoolQueries, schoolService, schools.test pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/schools.ts apps/api/src/__tests__/schools.test.ts
git commit -m "feat: add schools route with all 5 endpoints"
```

---

## Task 9: Wire up index.ts

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing test for rate limiting wiring (smoke check)**

This is a smoke test — just verify the health endpoint still works and schools route is mounted:

```typescript
// add to apps/api/src/__tests__/schools.test.ts:
// (or create a separate integration smoke test if preferred)
describe('Route mount smoke test', () => {
  it('GET /api/schools/:id returns 401 without token (not 404)', async () => {
    const res = await request(app).get('/api/schools/any-id');
    // 401 means the route exists and verifyToken is running
    expect(res.status).toBe(401);
  });
});
```

This test already passes since the app in `schools.test.ts` already mounts the router. No separate app-level test needed.

- [ ] **Step 2: Update index.ts**

Replace `apps/api/src/index.ts` with:
```typescript
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth';
import schoolsRoutes from './routes/schools';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

const app = express();
const port = process.env.PORT ?? '3001';

app.use(cors());
app.use(express.json());

// Rate limiting (Rule S5)
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 5 }));
app.use('/api',      rateLimit({ windowMs: 60_000, max: 100 }));

// Routes
app.use('/api/auth',    authRoutes);
app.use('/api/schools', schoolsRoutes);

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

// Global error handler must be last
app.use(errorHandler);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Chronix Edu API listening on http://localhost:${port}`);
});
```

- [ ] **Step 3: Update .env.example**

Add the missing storage bucket line to `.env.example`:
```
SUPABASE_STORAGE_BUCKET=school-assets
```

- [ ] **Step 4: Verify TypeScript compiles with no errors**

```bash
cd "apps/api" && npx tsc --noEmit
```

Expected: Clean compile.

- [ ] **Step 5: Start the API and smoke test the health endpoint**

```bash
cd "apps/api" && npm run dev
```

In another terminal:
```bash
curl http://localhost:3001/health
```

Expected: `{"success":true,"status":"ok"}`

- [ ] **Step 6: Smoke test one endpoint with curl**

```bash
# Should get 401 (no token) — confirms route is mounted
curl -X POST http://localhost:3001/api/schools -H "Content-Type: application/json" -d '{"name":"Test"}'
```

Expected: `{"success":false,"error":{"code":"...","message":"Missing Authorization header"}}` — **not** a 404.

- [ ] **Step 7: Run full test suite one final time**

```bash
cd "apps/api" && npm test
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/index.ts .env.example
git commit -m "feat: wire schools route, rate limiting, and error handler into index.ts"
```

---

## Self-Review — Spec Coverage Check

| Spec requirement | Covered in task |
|-----------------|----------------|
| POST /api/schools (super_admin) | Task 8, route line ~60 |
| Auto-seed grading scale A/B/C/D/F | Task 6 NIGERIAN_DEFAULTS, Task 8 POST handler |
| Auto-seed assessment components (CA1/CA2/MidTerm/Exam) | Task 6 NIGERIAN_DEFAULTS |
| Auto-seed academic calendar (3 terms) | Task 6 NIGERIAN_DEFAULTS |
| All seeded in academic_config JSONB | Task 8, insertSchoolSettings call |
| GET /api/schools/:schoolId (super_admin or own principal) | Task 8, requireSchoolAccess middleware |
| PATCH identity (name, motto, logo_url, stamp_url, colours) | Task 8, updateIdentitySchema + route |
| Writes to identity_config JSONB | Task 5 updateIdentityConfig, Task 8 route |
| Audit log on identity update | Task 8, logAudit call in PATCH identity |
| PATCH academic-config (grading scale + promotion cutoff) | Task 8 route |
| Validate bands non-overlapping + cover 0-100 | Task 6 validateGradeBands, Task 8 route |
| 423 if published results exist | Task 5 checkPublishedResultsExist, Task 8 route |
| 200 + warnings if submitted results exist | Task 5 checkSubmittedResultsExist, Task 8 route |
| POST logo: multipart, jpeg/png only, max 2MB | Task 8, multer config + mimetype check |
| Logo upload to Supabase Storage | Task 8, supabaseAdmin.storage.upload |
| Rate limiting (S5) | Task 9, index.ts |
| Startup env var check (E2) | Task 9, index.ts |
| Global error handler | Task 7, wired in Task 9 |
| Standard response envelope (C6) | Every route handler |
| Zod validation on all POST/PATCH (C7) | All route handlers |
| try/catch on all async handlers (C8) | All route handlers |
| No raw fetch — Supabase SDK for storage | Task 8 uses supabaseAdmin |
| Assessment component weights validated to sum 100 | Task 8, PATCH academic-config handler |
