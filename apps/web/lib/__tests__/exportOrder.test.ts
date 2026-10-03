import { orderDatasets } from '../exportOrder';

// The API's order today (apps/api/src/db/queries/schoolExport.ts, EXPORT_DATASETS), abridged:
// students and accounts lead, the audit log comes last.
const FROM_API = ['students', 'people', 'parent_links', 'sessions', 'scores', 'attendance', 'payments', 'settings', 'audit_log']
  .map((key) => ({ key }));

describe('orderDatasets', () => {
  it('puts students, accounts and the audit log first, and keeps the rest in the API order', () => {
    // The control: in the API's own order the audit log is last, so this test can fail.
    expect(FROM_API[FROM_API.length - 1].key).toBe('audit_log');

    expect(orderDatasets(FROM_API).map((d) => d.key)).toEqual([
      'students', 'people', 'audit_log',
      'parent_links', 'sessions', 'scores', 'attendance', 'payments', 'settings',
    ]);
  });

  it('shows every dataset exactly once, so none is hidden', () => {
    const out = orderDatasets(FROM_API).map((d) => d.key);
    expect(out).toHaveLength(FROM_API.length);
    expect([...out].sort()).toEqual(FROM_API.map((d) => d.key).sort());
  });

  it('copes with a dataset named first being absent, and does not change its input', () => {
    const without = FROM_API.filter((d) => d.key !== 'people');
    const before = without.map((d) => d.key);
    expect(orderDatasets(without).map((d) => d.key).slice(0, 2)).toEqual(['students', 'audit_log']);
    expect(without.map((d) => d.key)).toEqual(before);
  });
});

// That FIRST_DATASETS names keys the API really has is checked on the API side, where
// EXPORT_DATASETS lives (apps/api/src/__tests__/exportOrderKeys.test.ts).
