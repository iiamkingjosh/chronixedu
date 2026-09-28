/** AUDIT M-cron: a cron job must run on only one replica at a time. */
import { runExclusive } from '../services/cronTracker';
import pool from '../db/client';

afterAll(() => pool.end());

it('a second concurrent run of the same job is skipped', async () => {
  // This test used to start `first`, sleep 100ms, and ASSUME `first` held the lock by
  // then. Under load it did not: `second` won the race, took the lock, ran the job and
  // parked on `gate` — but `release()` was only called after `second` returned, so each
  // waited on the other. The run hit the 30s test timeout with a live connection still
  // holding the advisory lock, afterAll's pool.end() then hung on that checked-out
  // client, and Jest could not exit. Found 28 Sep 2026 with the lock visible in pg_locks:
  // one idle backend whose last statement was pg_try_advisory_lock.
  //
  // A sleep is a guess about scheduling standing in for a synchronisation. `running`
  // resolves from INSIDE the job, and runExclusive only runs the job after acquiring the
  // lock — so awaiting it proves `first` holds the lock before `second` is attempted,
  // however slow the machine is.
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let started!: () => void;
  const running = new Promise<void>(r => { started = r; });
  let runs = 0;
  const job = async () => { runs++; started(); await gate; };

  const first = runExclusive('test-job', job);
  try {
    await running;
    const second = await runExclusive('test-job', job);
    expect(second).toBe(false);
  } finally {
    // Released unconditionally: if an assertion above throws, `first` must still be let
    // go, or its connection keeps the lock and the next suite inherits it.
    release();
  }

  expect(await first).toBe(true);
  expect(runs).toBe(1);

  // Lock is released afterwards, and a failing job releases it too.
  await expect(runExclusive('test-job', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(await runExclusive('test-job', async () => undefined)).toBe(true);
});
