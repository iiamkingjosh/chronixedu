/**
 * The RLS policy set built by migrations/ must equal the checked-in inventory.
 *
 * The existing RLS assertion in `tenantIsolation.db.test.ts` checks that every public
 * table has row level security *enabled*. That was true on both sides the whole time
 * migrations/ was building 64 policies and production was holding 81 — including one
 * created by hand in the Supabase dashboard that existed in no file. A guard can be
 * real, pass honestly, and measure a property that cannot see the failure.
 *
 * This pins the half CI can reach: the policies a rebuild produces. Add, drop or
 * reshape a policy and this fails until `scripts/sql/rls_policy_inventory.txt` is
 * regenerated — so the change appears in a diff and someone has to mean it.
 *
 * It cannot see a deployed database. `scripts/sql/rls_drift_check.sql` is that half,
 * run by hand against production, comparing it to the same file.
 */
import fs from 'fs';
import path from 'path';
import { pool } from './helpers';

const INVENTORY = path.join(__dirname, '../../../../scripts/sql/rls_policy_inventory.txt');

const DUMP = `
  SELECT tablename || '|' || policyname || '|' || cmd || '|'
         || coalesce(array_to_string(roles, ','), '')
         || '|Q=' || coalesce(regexp_replace(qual, '\\s+', ' ', 'g'), '-')
         || '|C=' || coalesce(regexp_replace(with_check, '\\s+', ' ', 'g'), '-') AS sig
    FROM pg_policies
   WHERE schemaname = 'public'
   ORDER BY tablename, policyname`;

function expectedSigs(): string[] {
  return fs
    .readFileSync(INVENTORY, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'));
}

afterAll(async () => {
  await pool.end();
});

describe('RLS policy drift', () => {
  it('the rebuilt schema holds exactly the policies in the inventory', async () => {
    const actual = (await pool.query<{ sig: string }>(DUMP)).rows.map(r => r.sig);
    const expected = expectedSigs();

    // Reported as two named sets rather than a diff of arrays, because the failure that
    // matters is "which policy, and which direction" — an array diff of 80 long strings
    // says neither. A changed predicate appears in both lists, not as a match.
    const onlyInDatabase = actual.filter(s => !expected.includes(s));
    const onlyInInventory = expected.filter(s => !actual.includes(s));

    expect({ onlyInDatabase, onlyInInventory }).toEqual({
      onlyInDatabase: [],
      onlyInInventory: [],
    });
  });

  it('the inventory is not empty — an unreadable file must fail, not pass vacuously', () => {
    // Without this, a rename or a bad path turns the check above into `[] === []`, which
    // passes. The same shape as the migrate runner reporting success after reading zero
    // .sql files from an empty directory.
    expect(expectedSigs().length).toBeGreaterThan(50);
  });

  it('every policy in the inventory names a table that still exists', async () => {
    const tables = new Set(
      (
        await pool.query<{ relname: string }>(
          `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'`
        )
      ).rows.map(r => r.relname)
    );
    const orphaned = expectedSigs()
      .map(s => s.split('|')[0])
      .filter(t => !tables.has(t));
    expect(orphaned).toEqual([]);
  });
});
