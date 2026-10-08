import { buildPromotionPayload } from '../promotionDecisions';

const ada = { id: 'a', first_name: 'Ada', last_name: 'Obi', class_id: 'jss1' };
const bayo = { id: 'b', first_name: 'Bayo', last_name: 'Ade', class_id: 'jss1' };
const chi = { id: 'c', first_name: 'Chi', last_name: 'Eze', class_id: null };

describe('buildPromotionPayload', () => {
  it('sends a promotion to a new class and a repeat in the current class', () => {
    const out = buildPromotionPayload([ada, bayo], {
      a: { decision: 'promoted', classId: 'jss2' },
      b: { decision: 'repeat', classId: '' },
    });
    expect(out).toEqual({
      decisions: [
        { student_id: 'a', class_id: 'jss2', decision: 'promoted' },
        { student_id: 'b', class_id: 'jss1', decision: 'repeat' },
      ],
      problems: [],
      undecided: 0,
    });
  });

  it('leaves an undecided student out, and counts them', () => {
    const out = buildPromotionPayload([ada, bayo], { a: { decision: 'repeat', classId: '' } });
    expect(out.decisions.map(d => d.student_id)).toEqual(['a']);
    expect(out.undecided).toBe(1);
    expect(out.problems).toEqual([]);
  });

  it('refuses a promotion with no class, or into the same class, naming the student', () => {
    const out = buildPromotionPayload([ada, bayo], {
      a: { decision: 'promoted', classId: '' },
      b: { decision: 'promoted', classId: 'jss1' },
    });
    expect(out.decisions).toEqual([]);
    expect(out.problems).toEqual([
      expect.stringContaining('Ada Obi moves up to'),
      expect.stringContaining('Bayo Ade is marked promoted into the class they are already in'),
    ]);
  });

  it('a repeat for a student with no class needs one chosen', () => {
    expect(buildPromotionPayload([chi], { c: { decision: 'repeat', classId: '' } }).problems).toEqual([expect.stringContaining('Chi Eze repeats in')]);
    expect(buildPromotionPayload([chi], { c: { decision: 'repeat', classId: 'jss1' } }).decisions).toEqual([{ student_id: 'c', class_id: 'jss1', decision: 'repeat' }]);
  });

  it('with nobody decided, says so rather than sending an empty run', () => {
    expect(buildPromotionPayload([ada], {})).toEqual({ decisions: [], problems: [expect.stringContaining('No student has a decision')], undecided: 1 });
  });
});
