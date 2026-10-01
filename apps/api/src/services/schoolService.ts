export interface GradeBand {
  grade: string;
  min: number;
  max: number;
  label: string;
  remark: string;
}

export interface AssessmentComponent {
  name: string;
  max_score: number;
  weight: number;
  display_order: number;
}

export interface AcademicCalendarTerm {
  term: string;
  typical_start: string;
  typical_end: string;
}

export interface CalendarTerm {
  name: string;
  start_month: number;
  end_month: number;
}

/**
 * What a NEW school's academic_config starts with: the calendar templates and nothing a
 * school must decide for itself. No grading_scale, no promotion_cutoff, no
 * assessment_components — doctrine 8. Seeding NIGERIAN_DEFAULTS at creation made every
 * school "have" a scale and a 40% pass mark that nobody chose, the promotion_cutoff ?? 40
 * bug across every school at once. An unset scale stays unset and is visibly unset:
 * POST /results/publish refuses with GRADING_SCALE_NOT_SET until the principal sets one in
 * Settings. NIGERIAN_DEFAULTS remains as a reference a principal may choose to copy, never
 * as a value written on anyone's behalf.
 */
export function newSchoolAcademicConfig(): Record<string, unknown> {
  return {
    academic_calendar: NIGERIAN_DEFAULTS.academic_calendar,
    calendar: NIGERIAN_DEFAULTS.calendar,
  };
}

export interface AcademicConfig {
  grading_scale: GradeBand[];
  promotion_cutoff: number;
  assessment_components: AssessmentComponent[];
  academic_calendar: AcademicCalendarTerm[];
  calendar: CalendarTerm[];
}

export const NIGERIAN_DEFAULTS: AcademicConfig = {
  grading_scale: [
    { grade: 'A', min: 70, max: 100, label: 'Excellent',  remark: 'Outstanding performance' },
    { grade: 'B', min: 60, max: 69,  label: 'Very Good',  remark: 'Above average performance' },
    { grade: 'C', min: 50, max: 59,  label: 'Good',       remark: 'Average performance' },
    { grade: 'D', min: 40, max: 49,  label: 'Pass',       remark: 'Below average but passing' },
    { grade: 'F', min: 0,  max: 39,  label: 'Fail',       remark: 'Below passing mark' },
  ],
  promotion_cutoff: 40,
  assessment_components: [
    { name: 'CA 1',           max_score: 10, weight: 10, display_order: 1 },
    { name: 'CA 2',           max_score: 10, weight: 10, display_order: 2 },
    { name: 'Mid-Term Test',  max_score: 10, weight: 10, display_order: 3 },
    { name: 'Examination',    max_score: 70, weight: 70, display_order: 4 },
  ],
  academic_calendar: [
    { term: 'First Term',  typical_start: 'September', typical_end: 'December' },
    { term: 'Second Term', typical_start: 'January',   typical_end: 'April' },
    { term: 'Third Term',  typical_start: 'May',       typical_end: 'July' },
  ],
  calendar: [
    { name: 'First Term',  start_month: 9, end_month: 12 },
    { name: 'Second Term', start_month: 1, end_month: 4  },
    { name: 'Third Term',  start_month: 5, end_month: 7  },
  ],
};

/**
 * Slugifies a school name for use as a unique URL-safe identifier.
 * Example: "St. Mary's School" → "st-marys-school"
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot generate a valid slug from school name: "${name}"`);
  return slug;
}

/**
 * Returns null if grade bands are valid; returns an error string if invalid.
 * Valid: no overlaps, no gaps, min=0 to max=100 coverage, each band min <= max.
 */
export function validateGradeBands(bands: GradeBand[]): string | null {
  for (const band of bands) {
    if (band.min > band.max) {
      return `Grade ${band.grade}: min (${band.min}) must not exceed max (${band.max})`;
    }
  }

  const sorted = [...bands].sort((a, b) => a.min - b.min);

  if (sorted[0].min !== 0) {
    return `Grade bands must start at 0. Lowest min is ${sorted[0].min}`;
  }

  if (sorted[sorted.length - 1].max !== 100) {
    return `Grade bands must end at 100. Highest max is ${sorted[sorted.length - 1].max}`;
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.min <= prev.max) {
      return `Grade bands overlap: ${prev.grade} (${prev.min}-${prev.max}) and ${curr.grade} (${curr.min}-${curr.max})`;
    }
    if (curr.min !== prev.max + 1) {
      return `Gap in grade bands between ${prev.grade} (max ${prev.max}) and ${curr.grade} (min ${curr.min})`;
    }
  }

  return null;
}
