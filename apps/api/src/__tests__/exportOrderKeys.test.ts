import fs from 'fs';
import path from 'path';

jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));

import { EXPORT_DATASETS } from '../db/queries/schoolExport';

/**
 * Settings → Data Export lists the single spreadsheets with three first (apps/web/lib/exportOrder.ts).
 * The web cannot import EXPORT_DATASETS, so a renamed key there would quietly send that dataset to
 * the back of the list. This reads the web's list and checks each key against the API's own.
 */
describe('the Data Export page names datasets the API has', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../web/lib/exportOrder.ts'), 'utf8');
  const match = source.match(/FIRST_DATASETS\s*=\s*\[([^\]]*)\]/);
  const first = match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  it('finds the list it is checking', () => {
    // The control: an unreadable list would make the next test pass on nothing.
    expect(first).toEqual(['students', 'people', 'audit_log']);
  });

  it('every key it puts first is an export dataset', () => {
    const keys = new Set(EXPORT_DATASETS.map((d) => d.key));
    for (const key of first) expect({ key, exported: keys.has(key) }).toEqual({ key, exported: true });
  });
});
