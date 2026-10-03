/**
 * Platform-admin two-factor, commit 1 of 4: storage and recovery (migration 055, 3 Oct 2026).
 * Recovery is built and proven before anyone can enrol, because production has one platform admin
 * who can sign in and no second one to reset him.
 */
import { pool, seed } from './helpers';
import {
  savePendingTotpSecret, readTotpSecret, replaceRecoveryCodes, consumeRecoveryCode, unusedRecoveryCodeCount,
} from '../db/queries/twoFactor';
import { generateTotpSecret, base32Encode } from '../services/totp';
import { generateRecoveryCodes } from '../services/recoveryCodes';
import { SYSTEM_ACTOR_ID } from '../config/systemActor';

const ADMIN = 'c0a10000-0000-4000-8000-000000000001';
const ADMIN2 = 'c0a10000-0000-4000-8000-000000000002';

async function addAdmin(id: string, email: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false)`,
    [id, email]
  );
}

async function activate(userId: string): Promise<void> {
  await pool.query(`UPDATE user_totp SET activated_at = now() WHERE user_id = $1`, [userId]);
}

async function removals(): Promise<Array<{ platform_admin_id: string; target_user_id: string | null; ip_address: string | null; metadata: Record<string, unknown> }>> {
  const { rows } = await pool.query(
    `SELECT platform_admin_id, target_user_id, ip_address, metadata FROM platform_audit_logs
      WHERE action_type = 'TWO_FACTOR_REMOVED' ORDER BY created_at`
  );
  return rows;
}

beforeEach(async () => {
  await seed();
  await addAdmin(ADMIN, 'admin-one@chronix.test');
  await addAdmin(ADMIN2, 'admin-two@chronix.test');
});

afterAll(async () => {
  await pool.end();
});

describe('the authenticator secret at rest', () => {
  it('is stored encrypted and reads back for its own admin', async () => {
    const secret = generateTotpSecret();
    expect(await savePendingTotpSecret(ADMIN, secret)).toBe(true);

    const read = await readTotpSecret(ADMIN);
    expect(read?.secret.equals(secret)).toBe(true);
    expect(read?.activatedAt).toBeNull();

    const { rows } = await pool.query<{ secret_ciphertext: Buffer }>(`SELECT secret_ciphertext FROM user_totp WHERE user_id = $1`, [ADMIN]);
    expect(rows[0].secret_ciphertext.length).toBeGreaterThan(secret.length);
    expect(rows[0].secret_ciphertext.includes(secret)).toBe(false);
    expect(rows[0].secret_ciphertext.toString('latin1').includes(base32Encode(secret))).toBe(false);
  });

  it('does not decrypt when copied onto another admin', async () => {
    await savePendingTotpSecret(ADMIN, generateTotpSecret());
    await savePendingTotpSecret(ADMIN2, generateTotpSecret());
    // The control: both read back before the copy.
    expect(await readTotpSecret(ADMIN2)).not.toBeNull();

    await pool.query(
      `UPDATE user_totp SET secret_ciphertext = (SELECT secret_ciphertext FROM user_totp WHERE user_id = $1) WHERE user_id = $2`,
      [ADMIN, ADMIN2]
    );
    await expect(readTotpSecret(ADMIN2)).rejects.toThrow();
  });

  it('starting enrolment again replaces a pending secret, but never an active one', async () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(await savePendingTotpSecret(ADMIN, first)).toBe(true);
    expect(await savePendingTotpSecret(ADMIN, second)).toBe(true);
    expect((await readTotpSecret(ADMIN))?.secret.equals(second)).toBe(true);

    await activate(ADMIN);
    expect(await savePendingTotpSecret(ADMIN, generateTotpSecret())).toBe(false);
    const read = await readTotpSecret(ADMIN);
    expect(read?.secret.equals(second)).toBe(true);
    expect(read?.activatedAt).not.toBeNull();
  });
});

describe('recovery codes', () => {
  it('are stored only as hashes, ten of them, and a new set retires the old one', async () => {
    const first = generateRecoveryCodes();
    await replaceRecoveryCodes(ADMIN, first);
    expect(await unusedRecoveryCodeCount(ADMIN)).toBe(10);

    const { rows } = await pool.query<{ code_hash: string }>(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [ADMIN]);
    const stored = rows.map((r) => r.code_hash).join(' ');
    for (const code of first) {
      expect(stored.includes(code)).toBe(false);
      expect(stored.toLowerCase().includes(code.replace(/-/g, '').toLowerCase())).toBe(false);
    }

    const second = generateRecoveryCodes();
    await replaceRecoveryCodes(ADMIN, second);
    expect(await unusedRecoveryCodeCount(ADMIN)).toBe(10);
    expect(await consumeRecoveryCode(ADMIN, first[0])).toBe(false);
    expect(await consumeRecoveryCode(ADMIN, second[0])).toBe(true);
  });

  it('a code works once, even when five requests race with it, and only for its own admin', async () => {
    const mine = generateRecoveryCodes();
    const theirs = generateRecoveryCodes();
    await replaceRecoveryCodes(ADMIN, mine);
    await replaceRecoveryCodes(ADMIN2, theirs);

    const results = await Promise.all(Array.from({ length: 5 }, () => consumeRecoveryCode(ADMIN, mine[0])));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await unusedRecoveryCodeCount(ADMIN)).toBe(9);

    expect(await consumeRecoveryCode(ADMIN, theirs[1])).toBe(false);
    expect(await unusedRecoveryCodeCount(ADMIN2)).toBe(10);
    // Typed loosely, it still counts as the same code.
    expect(await consumeRecoveryCode(ADMIN, mine[1].toLowerCase().replace(/-/g, ' '))).toBe(true);
  });
});

describe('switching off an active second factor is recorded, whoever does it', () => {
  async function enrolActive(userId: string): Promise<void> {
    await savePendingTotpSecret(userId, generateTotpSecret());
    await activate(userId);
    await replaceRecoveryCodes(userId, generateRecoveryCodes());
  }

  it('through break_glass_reset: everything removed, the reason kept, signed by the system account', async () => {
    await enrolActive(ADMIN);
    expect(await readTotpSecret(ADMIN)).not.toBeNull();
    expect(await removals()).toHaveLength(0);

    const { rows } = await pool.query<{ n: number }>(
      `SELECT chronixedu_two_factor.break_glass_reset($1, $2) AS n`, [ADMIN, 'Lost phone and recovery codes; confirmed by phone call']
    );
    expect(rows[0].n).toBe(10);
    expect(await readTotpSecret(ADMIN)).toBeNull();
    expect(await unusedRecoveryCodeCount(ADMIN)).toBe(0);

    const [record] = await removals();
    expect(record.platform_admin_id).toBe(SYSTEM_ACTOR_ID);
    expect(record.target_user_id).toBeNull();
    expect(record.ip_address).toBeNull();
    expect(record.metadata).toMatchObject({
      user_id: ADMIN,
      by: 'break_glass_reset',
      reason: 'Lost phone and recovery codes; confirmed by phone call',
    });
    expect(record.metadata.activated_at).toBeTruthy();
    expect(record.metadata.database_role).toBeTruthy();
  });

  it('through a plain DELETE typed into the SQL editor', async () => {
    await enrolActive(ADMIN);
    await pool.query(`DELETE FROM user_totp WHERE user_id = $1`, [ADMIN]);
    const [record] = await removals();
    expect(record.metadata).toMatchObject({ user_id: ADMIN, by: 'a DELETE on user_totp', reason: null });
  });

  it('when the admin\'s user row is deleted, and the record outlives the user', async () => {
    await enrolActive(ADMIN);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
    expect((await pool.query(`SELECT 1 FROM users WHERE id = $1`, [ADMIN])).rowCount).toBe(0);
    const [record] = await removals();
    expect(record.metadata).toMatchObject({ user_id: ADMIN });
  });

  it('but not the removal of an enrolment that was never switched on', async () => {
    await savePendingTotpSecret(ADMIN2, generateTotpSecret()); // pending only
    await enrolActive(ADMIN);
    await pool.query(`DELETE FROM user_totp WHERE user_id = ANY($1::uuid[])`, [[ADMIN, ADMIN2]]);
    // The control is the active one in the same statement: exactly one record, and it is his.
    const records = await removals();
    expect(records).toHaveLength(1);
    expect(records[0].metadata.user_id).toBe(ADMIN);
  });

  it('a reason given to break_glass_reset does not leak onto a later DELETE in the same transaction', async () => {
    await enrolActive(ADMIN);
    await enrolActive(ADMIN2);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT chronixedu_two_factor.break_glass_reset($1, 'first, by the runbook')`, [ADMIN]);
      await c.query(`DELETE FROM user_totp WHERE user_id = $1`, [ADMIN2]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const records = await removals();
    expect(records.map((r) => [r.metadata.user_id, r.metadata.by, r.metadata.reason])).toEqual([
      [ADMIN, 'break_glass_reset', 'first, by the runbook'],
      [ADMIN2, 'a DELETE on user_totp', null],
    ]);
  });
});

describe('break_glass_reset', () => {
  it('refuses without a reason, for someone who is not a platform admin, and when there is nothing to reset', async () => {
    const run = (user: string, reason: string | null) =>
      pool.query(`SELECT chronixedu_two_factor.break_glass_reset($1, $2)`, [user, reason]);
    await savePendingTotpSecret(ADMIN, generateTotpSecret());
    const teacher = await pool.query(`SELECT id FROM users WHERE role = 'teacher' LIMIT 1`);
    expect(teacher.rows[0]?.id).toBeTruthy();

    await expect(run(ADMIN, null)).rejects.toThrow(/a reason are both required/);
    await expect(run(ADMIN, '   ')).rejects.toThrow(/a reason are both required/);
    await expect(run(teacher.rows[0].id, 'x')).rejects.toThrow(/is not a platform admin/);
    await expect(run(ADMIN2, 'x')).rejects.toThrow(/has no two-factor to reset/);
    // The control: the same call for the admin who has a row succeeds.
    await expect(run(ADMIN, 'x')).resolves.toBeTruthy();
  });

  it('can be run by the table owner and by nobody Supabase serves', async () => {
    const fn = 'chronixedu_two_factor.break_glass_reset(uuid, text)';
    const { rows } = await pool.query<{ role: string; can: boolean; schema: boolean }>(
      `SELECT r AS role,
              has_function_privilege(r, $1, 'EXECUTE') AS can,
              has_schema_privilege(r, 'chronixedu_two_factor', 'USAGE') AS schema
         FROM unnest(ARRAY[current_user::text, 'anon', 'authenticated', 'service_role']) AS r`,
      [fn]
    );
    expect(rows).toEqual([
      { role: expect.any(String), can: true, schema: true },
      { role: 'anon', can: false, schema: false },
      { role: 'authenticated', can: false, schema: false },
      { role: 'service_role', can: false, schema: false },
    ]);
    const publicGrant = await pool.query(
      `SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
      [fn]
    );
    expect(publicGrant.rows[0].n).toBe(0);
  });
});

describe('the two tables over Supabase\'s REST roles', () => {
  it('give anon and authenticated nothing, although an ordinary table gives them everything', async () => {
    const { rows } = await pool.query<{ tbl: string; role: string; granted: boolean }>(
      `SELECT t AS tbl, r AS role,
              has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'INSERT')
           OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE') AS granted
         FROM unnest(ARRAY['users', 'user_totp', 'user_recovery_codes']) AS t,
              unnest(ARRAY['anon', 'authenticated']) AS r`
    );
    const granted = Object.fromEntries(rows.map((r) => [`${r.tbl} ${r.role}`, r.granted]));
    expect(granted).toEqual({
      'user_recovery_codes anon': false,
      'user_recovery_codes authenticated': false,
      'user_totp anon': false,
      'user_totp authenticated': false,
      // The control: the stubs grant every new table to both, as Supabase does, so the four above
      // are refused because 055 revoked it, not because nothing was ever granted.
      'users anon': true,
      'users authenticated': true,
    });
  });
});
