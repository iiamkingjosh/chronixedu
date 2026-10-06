import fs from 'fs';
import path from 'path';

jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));

import { REFUND_REASONS } from '../db/queries/feeRefunds';

/**
 * The bursar's refund form offers reasons from apps/web/lib/refundReasons.ts. The web cannot import the
 * API's list, so a reason added or renamed on one side would be refused by the API, or never offered.
 * This reads the web's list and checks it against the API's, both ways.
 */
describe('the refund form offers exactly the reasons the API takes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../web/lib/refundReasons.ts'), 'utf8');
  const offered = [...source.matchAll(/\['([a-z_]+)',\s*'[^']+'\]/g)].map((m) => m[1]);

  it('finds the list it is checking', () => {
    // The control: an unreadable list would make the next test compare nothing.
    expect(offered.length).toBeGreaterThan(0);
  });

  it('the same reasons, in the same order', () => {
    expect(offered).toEqual([...REFUND_REASONS]);
  });
});
