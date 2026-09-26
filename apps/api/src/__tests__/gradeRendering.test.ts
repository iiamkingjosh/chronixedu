/**
 * What a report card actually prints in the grade column.
 *
 * The value in that cell was used as BOTH the CSS class suffix and the printed text:
 *
 *   <td class="grade-{{grade}}">{{grade}}</td>
 *
 * and it was squeezed through `['A','B','C','D','F'].includes(g) ? g : 'F'` so the
 * class name would match one of the five `.grade-X` rules the templates define. Because
 * the same value was printed, the squeeze leaked onto the page.
 *
 * Two cases nobody had a test for, and they are the two this file covers:
 *
 *   An unscored subject. lookupGrade produced '—', the squeeze turned it into 'F', and
 *   the report card printed a bold red F beside a total of '—'. REACHABLE TODAY: the
 *   one real school runs a contiguous A–F scale, so no scored grade was ever altered,
 *   but any subject a teacher had not finished entering printed as a fail.
 *
 *   A WAEC A1–F9 scale. Every band fails the membership test, so a student scoring 80
 *   printed F. Not reachable at the only live school, which is on A–F — this is the
 *   case that bites the first customer who configures the scale the product supports.
 */
// reportCardService imports supabaseClient at module load, which throws without env.
// Only the pure helper is under test here.
jest.mock('../supabaseClient', () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock('puppeteer', () => ({ launch: jest.fn() }));

import { gradeCss, computePromotionStatus } from '../services/reportCardService';
import { lookupGrade, type GradeBand } from '../services/resultEngine';

const AF: GradeBand[] = [
  { grade: 'A', min: 70, max: 100, label: 'A', remark: 'Excellent' },
  { grade: 'B', min: 60, max: 69,  label: 'B', remark: 'Very Good' },
  { grade: 'C', min: 50, max: 59,  label: 'C', remark: 'Good' },
  { grade: 'D', min: 40, max: 49,  label: 'D', remark: 'Pass' },
  { grade: 'F', min: 0,  max: 39,  label: 'F', remark: 'Fail' },
];

/** The scale the product already supports via academic_config.grading_scale. */
const WAEC: GradeBand[] = [
  { grade: 'A1', min: 75, max: 100, label: 'A1', remark: 'Excellent' },
  { grade: 'B2', min: 70, max: 74,  label: 'B2', remark: 'Very Good' },
  { grade: 'B3', min: 65, max: 69,  label: 'B3', remark: 'Good' },
  { grade: 'C4', min: 60, max: 64,  label: 'C4', remark: 'Credit' },
  { grade: 'C5', min: 55, max: 59,  label: 'C5', remark: 'Credit' },
  { grade: 'C6', min: 50, max: 54,  label: 'C6', remark: 'Credit' },
  { grade: 'D7', min: 45, max: 49,  label: 'D7', remark: 'Pass' },
  { grade: 'E8', min: 40, max: 44,  label: 'E8', remark: 'Pass' },
  { grade: 'F9', min: 0,  max: 39,  label: 'F9', remark: 'Fail' },
];

/** A word scale — the shape that defeats any first-character derivation. */
const WORDS: GradeBand[] = [
  { grade: 'Excellent', min: 70, max: 100, label: 'Excellent', remark: 'Excellent' },
  { grade: 'Credit',    min: 50, max: 69,  label: 'Credit',    remark: 'Credit' },
  { grade: 'Pass',      min: 40, max: 49,  label: 'Pass',      remark: 'Pass' },
  { grade: 'Fail',      min: 0,  max: 39,  label: 'Fail',      remark: 'Fail' },
];

/** What the template renders: printed text and the class suffix, separately. */
function cell(score: number | null, scale: GradeBand[]): { printed: string; css: string } {
  const band = score === null ? null : lookupGrade(score, scale);
  return { printed: band ? band.grade : '—', css: gradeCss(band, scale) };
}

describe('an unscored subject is not a fail', () => {
  it('prints an em-dash, not F — the defect reachable at the live school today', () => {
    expect(cell(null, AF)).toEqual({ printed: '—', css: 'none' });
  });

  it('styles it neutrally, so it is not bold red', () => {
    // .grade-none is grey and normal weight; .grade-F is bold #c62828.
    expect(cell(null, AF).css).not.toBe('F');
  });

  it('still distinguishes a genuine zero from an unscored subject', () => {
    expect(cell(0, AF).printed).toBe('F');
    expect(cell(null, AF).printed).toBe('—');
  });
});

describe('a school on the WAEC scale gets WAEC grades', () => {
  it.each([
    [80, 'A1'], [72, 'B2'], [66, 'B3'], [62, 'C4'],
    [57, 'C5'], [52, 'C6'], [47, 'D7'], [42, 'E8'], [20, 'F9'],
  ])('score %i prints %s', (score, expected) => {
    expect(cell(score as number, WAEC).printed).toBe(expected);
  });

  it('does not print F for a score of 80', () => {
    // The old helper did exactly this.
    expect(cell(80, WAEC).printed).not.toBe('F');
  });

  it('gives the best band the best colour and the worst band the worst', () => {
    expect(cell(80, WAEC).css).toBe('A');
    expect(cell(20, WAEC).css).toBe('F');
  });
});

describe('the colour is derived from rank, never from the grade text', () => {
  it('handles a word scale, which no first-character rule could', () => {
    // 'Excellent' -> 'E' and 'Credit' -> 'C' would be wrong and silently plausible.
    expect(cell(85, WORDS)).toEqual({ printed: 'Excellent', css: 'A' });
    expect(cell(20, WORDS)).toEqual({ printed: 'Fail', css: 'F' });
  });

  it('keeps the printed label intact whatever the scale calls it', () => {
    expect(cell(55, WORDS).printed).toBe('Credit');
  });

  it('always yields one of the five classes the templates define, or none', () => {
    const allowed = new Set(['A', 'B', 'C', 'D', 'F', 'none']);
    for (const scale of [AF, WAEC, WORDS]) {
      for (let score = 0; score <= 100; score++) {
        expect(allowed.has(cell(score, scale).css)).toBe(true);
      }
    }
  });

  it('degrades to no grade when a school has no scale configured', () => {
    // Previously this fell back to a hard-coded 70/60/50/40 the school never agreed to.
    expect(cell(85, [])).toEqual({ printed: '—', css: 'none' });
  });
});

describe('lookupGrade reports a miss rather than inventing an F', () => {
  it('returns null when no band covers the score', () => {
    const gapped: GradeBand[] = [
      { grade: 'A', min: 70, max: 100, label: 'A', remark: 'Excellent' },
      { grade: 'F', min: 0,  max: 39,  label: 'F', remark: 'Fail' },
    ];
    // validateGradeBands rejects gaps at the settings write, so this is defence
    // against hand-written data, not a configurable state.
    expect(lookupGrade(55, gapped)).toBeNull();
    expect(cell(55, gapped)).toEqual({ printed: '—', css: 'none' });
  });
});

describe('a school that never set a pass mark gets no promotion decision', () => {
  // promotion_cutoff defaulted to 40. A letter grade is a summary; this prints
  // "Promoted" or "Repeat Class" on a Third Term report card a parent keeps. For a
  // school that never set a pass mark, 40 was Chronix's number presented as theirs.
  // 42 of 45 schools have no school_settings row, so the default was exercised.
  it('says Not determined rather than Repeat Class', () => {
    expect(computePromotionStatus('Third Term', 5, 35, null)).toEqual({
      promotionClass: 'pending',
      promotionStatus: 'Not determined',
    });
  });

  it('does not promote either — it declines to decide in both directions', () => {
    expect(computePromotionStatus('Third Term', 5, 85, null).promotionStatus).toBe('Not determined');
  });

  it('still decides when the school HAS set a pass mark', () => {
    expect(computePromotionStatus('Third Term', 5, 45, 40).promotionStatus).toBe('Promoted');
    expect(computePromotionStatus('Third Term', 5, 35, 40).promotionStatus).toBe('Repeat Class');
  });

  it('is unchanged for terms that are not the third', () => {
    expect(computePromotionStatus('First Term', 5, 35, null).promotionStatus).toBe('Term Completed');
  });
});
