import { splitTermsByStructure, termLabel } from '../assessmentTerms';

const first = { id: 't1', name: 'First Term', session_name: '2026/2027' };
const second = { id: 't2', name: 'Second Term', session_name: '2026/2027' };
const third = { id: 't3', name: 'Third Term' };

describe('splitTermsByStructure', () => {
  it('lists each term once, on the side its configs put it', () => {
    const configs = [{ term_id: 't1' }, { term_id: 't1' }, { term_id: 't3' }];
    expect(splitTermsByStructure([first, second, third], configs)).toEqual({ without: [second], sources: [first, third] });
  });

  it('with no configs at all, every term is without one and there is nothing to copy from', () => {
    expect(splitTermsByStructure([first, second], [])).toEqual({ without: [first, second], sources: [] });
  });

  it('ignores configs of terms it was not given', () => {
    expect(splitTermsByStructure([second], [{ term_id: 't1' }])).toEqual({ without: [second], sources: [] });
  });
});

describe('termLabel', () => {
  it('names the session when it is known', () => {
    expect(termLabel(first)).toBe('First Term (2026/2027)');
    expect(termLabel(third)).toBe('Third Term');
  });
});
