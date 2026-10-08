import { termsToLookBackOn, defaultTermId, lagosToday } from '../parentTerms';

const sessions = [
  { id: 's2', name: '2026/2027', is_current: true, terms: [
    { id: 't4', name: 'First Term', start_date: '2026-09-14T00:00:00.000Z', is_current: true },
    { id: 't5', name: 'Second Term', start_date: '2027-01-05', is_current: false },
  ] },
  { id: 's1', name: '2025/2026', is_current: false, terms: [
    { id: 't1', name: 'First Term', start_date: '2025-09-15', is_current: false },
    { id: 't3', name: 'Third Term', start_date: '2026-04-27', is_current: true }, // an old session's leftover flag
    { id: 't2', name: 'Second Term', start_date: '2026-01-06', is_current: false },
  ] },
];

describe('termsToLookBackOn', () => {
  it('lists the terms that have begun, newest first, naming each session, marking only the real current term', () => {
    expect(termsToLookBackOn(sessions, '2026-10-08').map(({ id, label, isCurrent }) => ({ id, label, isCurrent }))).toEqual([
      { id: 't4', label: 'First Term, 2026/2027 (current)', isCurrent: true },
      { id: 't3', label: 'Third Term, 2025/2026', isCurrent: false },
      { id: 't2', label: 'Second Term, 2025/2026', isCurrent: false },
      { id: 't1', label: 'First Term, 2025/2026', isCurrent: false },
    ]);
    // Each carries its dates for a calendar: an end date when known, else the start.
    expect(termsToLookBackOn(sessions, '2026-10-08')[0]).toMatchObject({ name: 'First Term', start_date: '2026-09-14', end_date: '2026-09-14' });
  });

  it('leaves out a term that has not begun', () => {
    expect(termsToLookBackOn(sessions, '2027-01-05').map(c => c.id)).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(termsToLookBackOn(sessions, '2025-09-14')).toEqual([]);
  });
});

describe('defaultTermId', () => {
  it('opens on the current term, else the latest that has begun, else nothing', () => {
    expect(defaultTermId(termsToLookBackOn(sessions, '2026-10-08'))).toBe('t4');
    const plain = (id: string) => ({ id, label: id, isCurrent: false, name: id, start_date: '2026-01-01', end_date: '2026-04-01' });
    expect(defaultTermId([plain('a'), plain('b')])).toBe('a');
    expect(defaultTermId([])).toBeNull();
  });
});

describe('lagosToday', () => {
  it('is the date in Lagos, not the machine’s', () => {
    // 23:30 UTC on 7 Oct is 00:30 on 8 Oct in Lagos (UTC+1).
    expect(lagosToday(new Date('2026-10-07T23:30:00Z'))).toBe('2026-10-08');
  });
});
