import { COMMON_SCALE, initialGradingForm, parsePassMark } from '../gradingDefaults';

describe('initialGradingForm', () => {
  it('shows a school that has chosen nothing an empty form, marked not set', () => {
    for (const config of [undefined, null, {}, { grading_scale: [] }, { promotion_cutoff: null }]) {
      expect(initialGradingForm(config)).toEqual({ bands: [], scaleSet: false, passMark: '', passMarkSet: false });
    }
  });

  it("shows what a school did choose, and only that", () => {
    const scale = COMMON_SCALE.slice(0, 2);
    expect(initialGradingForm({ grading_scale: scale })).toEqual({ bands: scale, scaleSet: true, passMark: '', passMarkSet: false });
    expect(initialGradingForm({ promotion_cutoff: 45 })).toEqual({ bands: [], scaleSet: false, passMark: '45', passMarkSet: true });
    // A pass mark of 0 is a choice, not an absence.
    expect(initialGradingForm({ promotion_cutoff: 0 }).passMarkSet).toBe(true);
  });
});

describe('parsePassMark', () => {
  it('takes a whole number from 0 to 100', () => {
    expect(parsePassMark('45')).toEqual({ ok: true, value: 45 });
    expect(parsePassMark(' 0 ')).toEqual({ ok: true, value: 0 });
    expect(parsePassMark('100')).toEqual({ ok: true, value: 100 });
  });

  it('says what is wrong with anything else', () => {
    for (const bad of ['', '  ', '45.5', '45%', '-1', '101', '1e2', 'forty']) {
      expect({ bad, ok: parsePassMark(bad).ok }).toEqual({ bad, ok: false });
    }
  });
});

describe('COMMON_SCALE', () => {
  it('covers 0 to 100 without gaps, so filling the form with it gives a scale that saves', () => {
    const sorted = [...COMMON_SCALE].sort((a, b) => b.min - a.min);
    expect(sorted[0].max).toBe(100);
    expect(sorted[sorted.length - 1].min).toBe(0);
    for (let i = 0; i < sorted.length - 1; i++) expect(sorted[i].min).toBe(sorted[i + 1].max + 1);
  });
});
