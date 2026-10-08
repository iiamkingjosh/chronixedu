import { currentAndPreviousTerm } from '../termOrder';

const t = (id: string, start: string, is_current = false) => ({ id, name: id, start_date: start, is_current });

describe('currentAndPreviousTerm', () => {
  it('finds the term before the current one, across sessions and whatever order they arrive in', () => {
    const sessions = [
      { id: 'new', name: '2027/2028', is_current: true, terms: [t('n1', '2027-09-13T00:00:00.000Z', true)] },
      { id: 'old', name: '2026/2027', is_current: false, terms: [t('o3', '2027-04-20'), t('o1', '2026-09-14'), t('o2', '2027-01-05')] },
    ];
    const pair = currentAndPreviousTerm(sessions);
    expect(pair?.current.id).toBe('n1');
    expect(pair?.previous?.id).toBe('o3');
  });

  it('ignores a later term, and has no previous term for a school in its first term', () => {
    const sessions = [{ id: 's', name: '2026/2027', is_current: true, terms: [t('t2', '2027-01-05'), t('t1', '2026-09-14', true)] }];
    expect(currentAndPreviousTerm(sessions)).toEqual({ current: sessions[0].terms[1], previous: null });
  });

  it('is null with no current term, so nothing is offered', () => {
    expect(currentAndPreviousTerm([{ id: 's', name: 'x', is_current: true, terms: [t('a', '2026-09-14')] }])).toBeNull();
    expect(currentAndPreviousTerm([{ id: 's', name: 'x', is_current: false, terms: [t('a', '2026-09-14', true)] }])).toBeNull();
    expect(currentAndPreviousTerm([])).toBeNull();
  });
});
