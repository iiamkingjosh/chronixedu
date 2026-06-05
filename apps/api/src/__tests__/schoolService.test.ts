import { validateGradeBands, NIGERIAN_DEFAULTS, slugify } from '../services/schoolService';

describe('NIGERIAN_DEFAULTS', () => {
  it('has 5 grade bands', () => {
    expect(NIGERIAN_DEFAULTS.grading_scale).toHaveLength(5);
  });

  it('assessment_components weights sum to 100', () => {
    const total = NIGERIAN_DEFAULTS.assessment_components.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBe(100);
  });

  it('grading_scale covers 0-100 without gaps', () => {
    const sorted = [...NIGERIAN_DEFAULTS.grading_scale].sort((a, b) => a.min - b.min);
    expect(sorted[0].min).toBe(0);
    expect(sorted[sorted.length - 1].max).toBe(100);
  });

  it('has 3 academic calendar terms', () => {
    expect(NIGERIAN_DEFAULTS.academic_calendar).toHaveLength(3);
  });

  it('promotion_cutoff is 40', () => {
    expect(NIGERIAN_DEFAULTS.promotion_cutoff).toBe(40);
  });
});

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Test School')).toBe('test-school');
  });

  it('removes apostrophes', () => {
    expect(slugify("St. Mary's School")).toBe('st-marys-school');
  });

  it('collapses multiple non-alphanumeric chars', () => {
    expect(slugify('School -- Name')).toBe('school-name');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify(' --- School --- ')).toBe('school');
  });
});

describe('validateGradeBands', () => {
  it('returns null for valid non-overlapping bands covering 0-100', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent',  remark: '' },
      { grade: 'B', min: 60, max: 69,  label: 'Very Good',  remark: '' },
      { grade: 'C', min: 50, max: 59,  label: 'Good',       remark: '' },
      { grade: 'D', min: 40, max: 49,  label: 'Pass',       remark: '' },
      { grade: 'F', min: 0,  max: 39,  label: 'Fail',       remark: '' },
    ];
    expect(validateGradeBands(bands)).toBeNull();
  });

  it('returns error when bands have a gap', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 60,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/gap/i);
  });

  it('returns error when bands overlap', () => {
    const bands = [
      { grade: 'A', min: 60, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 65,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/overlap/i);
  });

  it('returns error when lowest band does not start at 0', () => {
    const bands = [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: '' },
      { grade: 'F', min: 10, max: 69,  label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/start at 0/i);
  });

  it('returns error when highest band does not end at 100', () => {
    const bands = [
      { grade: 'A', min: 70, max: 99, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,  max: 69, label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/end at 100/i);
  });

  it('returns error when a band has min > max', () => {
    const bands = [
      { grade: 'A', min: 100, max: 70, label: 'Excellent', remark: '' },
      { grade: 'F', min: 0,   max: 99, label: 'Fail',      remark: '' },
    ];
    expect(validateGradeBands(bands)).toMatch(/must not exceed/i);
  });
});
