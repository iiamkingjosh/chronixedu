/** AUDIT M-cron: a cron job must run on only one replica at a time. */
import { runExclusive } from '../services/cronTracker';
import pool from '../db/client';

afterAll(() => pool.end());

it('a second concurrent run of the same job is skipped', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let runs = 0;
  const job = async () => { runs++; await gate; };

  const first = runExclusive('test-job', job);
  await new Promise(r => setTimeout(r, 100));
  const second = await runExclusive('test-job', job);
  release();

  expect(await first).toBe(true);
  expect(second).toBe(false);
  expect(runs).toBe(1);

  // Lock is released afterwards, and a failing job releases it too.
  await expect(runExclusive('test-job', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(await runExclusive('test-job', async () => undefined)).toBe(true);
});
